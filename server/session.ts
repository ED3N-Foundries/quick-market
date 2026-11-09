import { timingSafeEqual } from "node:crypto"
import { recoverMessageAddress, type Hex } from "viem"
import { LOGIN_SKEW_MS, SESSION_MS, loginMessage, nearLoginMessage } from "../shared/login"
import { NEP413_RECIPIENT, parseNearPublicKey, verifyNep413, verifyNearMessage } from "../shared/nearKey"
import { isImplicitAccount } from "../shared/near"
import { configuredChain, loadEnv } from "./env"
import { getDb } from "./db"
import { normalizeAccount } from "./money"
import { accessKeyOnAccount } from "./near"
import { ensureUser, youFor, type You } from "./rounds"

const SIGNATURE = /^0x[0-9a-fA-F]+$/

function nonceBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) return null
  const bytes = Buffer.from(value, "base64")
  return bytes.length === 32 ? new Uint8Array(bytes) : null
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function nearSignatureOk(input: {
  address: string
  signature: string
  issued: number
  bot: boolean
  nonce?: unknown
  publicKey?: unknown
}): Promise<boolean> {
  const message = nearLoginMessage(input.address, input.issued)
  if (input.bot) return isImplicitAccount(input.address) && (await verifyNearMessage(message, input.address, input.signature))
  const nonce = nonceBytes(input.nonce)
  if (!nonce || typeof input.publicKey !== "string") return false
  if (isImplicitAccount(input.address)) {
    const pub = parseNearPublicKey(input.publicKey)
    if (!pub || hex(pub) !== input.address) return false
  } else {
    const present = await accessKeyOnAccount(input.address, input.publicKey)
    if (!present) return false
  }
  return verifyNep413({
    message,
    account: input.address,
    publicKey: input.publicKey,
    signature: input.signature,
    nonce,
    recipient: NEP413_RECIPIENT,
  })
}

export async function openSession(input: {
  address: string
  signature: string
  issued: number
  now: number
  botSecret?: unknown
  nonce?: unknown
  publicKey?: unknown
}): Promise<{ ok: true; token: string; you: You } | { ok: false; error: string }> {
  let chainKey: ReturnType<typeof configuredChain>["key"]
  let chainId: number
  try {
    const chain = configuredChain()
    chainKey = chain.key
    chainId = chain.id
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Chain is invalid" }
  }
  const address = normalizeAccount(input.address, chainKey)
  if (!address) return { ok: false, error: "Address is invalid" }
  if (!Number.isInteger(input.issued) || Math.abs(input.now - input.issued) > LOGIN_SKEW_MS) {
    return { ok: false, error: "Sign-in expired" }
  }
  if (chainKey === "near-testnet") {
    const ok = await nearSignatureOk({
      address,
      signature: input.signature,
      issued: input.issued,
      bot: botSecretOk(input.botSecret),
      nonce: input.nonce,
      publicKey: input.publicKey,
    })
    if (!ok) return { ok: false, error: "Signature is invalid" }
  } else {
    if (!SIGNATURE.test(input.signature)) return { ok: false, error: "Signature is invalid" }
    const message = loginMessage(chainId, address, input.issued)
    let recovered = ""
    try {
      recovered = (await recoverMessageAddress({ message, signature: input.signature as Hex })).toLowerCase()
    } catch {
      return { ok: false, error: "Signature is invalid" }
    }
    if (recovered !== address) return { ok: false, error: "Signature is invalid" }
  }

  const db = getDb()
  const seen = db.query("SELECT signature FROM login_sigs WHERE chain_key = ? AND signature = ?").get(chainKey, input.signature)
  if (seen) return { ok: false, error: "Sign-in already used" }

  const token = randomToken()
  const bot = botSecretOk(input.botSecret)
  const tx = db.transaction(() => {
    db.query("INSERT INTO login_sigs (chain_key, signature, expires_at) VALUES (?, ?, ?)").run(chainKey, input.signature, input.now + LOGIN_SKEW_MS)
    if (bot) {
      db.query(
        `INSERT INTO users (chain_key, address, balance_micros, created_at, is_bot) VALUES (?, ?, 0, ?, 1)
         ON CONFLICT(chain_key, address) DO UPDATE SET is_bot = 1`,
      ).run(chainKey, address, input.now)
    } else {
      ensureUser(address)
    }
    db.query("INSERT INTO sessions (chain_key, token, address, expires_at) VALUES (?, ?, ?, ?)").run(chainKey, token, address, input.now + SESSION_MS)
  })
  tx()
  return { ok: true, token, you: youFor(address)! }
}

export function readSession(req: Request, now = Date.now()): { address: string | null; rejected: boolean } {
  const header = req.headers.get("authorization") ?? ""
  if (!header) return { address: null, rejected: false }
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(header)
  if (!match) return { address: null, rejected: true }
  const row = getDb()
    .query("SELECT address, expires_at FROM sessions WHERE chain_key = ? AND token = ?")
    .get(configuredChain().key, match[1]!) as { address: string; expires_at: number } | null
  if (!row || row.expires_at <= now) return { address: null, rejected: true }
  return { address: row.address, rejected: false }
}

export function endSession(req: Request) {
  const header = req.headers.get("authorization") ?? ""
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(header)
  if (!match) return
  getDb().query("DELETE FROM sessions WHERE chain_key = ? AND token = ?").run(configuredChain().key, match[1]!)
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function agentAuthorized(header: string | null): boolean {
  return botSecretOk(header)
}

function botSecretOk(given: unknown): boolean {
  const expected = loadEnv().agentSecret
  if (!expected || typeof given !== "string" || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}
