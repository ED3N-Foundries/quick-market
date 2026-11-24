import { recoverMessageAddress, type Hex } from "viem"
import { LOGIN_SKEW_MS, SESSION_MS, loginMessage, nearLoginMessage } from "../shared/login"
import { NEP413_RECIPIENT, parseNearPublicKey, verifyNep413 } from "../shared/nearKey"
import { isImplicitAccount } from "../shared/near"
import type { ChainKey } from "../shared/chain"
import { activeChainKey } from "./activeChain"
import { chainConfig } from "./env"
import { getDb } from "./db"
import { normalizeAccount } from "./money"
import { accessKeyOnAccount, isNearCooling, nearRpcBusy } from "./near"

export const NEAR_BUSY = "NEAR is busy. Try again."
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

type NearSignFailure = "nonce" | "public-key" | "implicit-key" | "access-key" | "signature" | "mismatch"

function nearSignError(reason: NearSignFailure): string {
  const detail = {
    nonce: "The sign-in nonce is missing or not 32 bytes.",
    "public-key": "The public key is missing or not an ed25519 key.",
    "implicit-key": "The public key does not match this implicit account.",
    "access-key": "This public key is not an access key on the account.",
    signature: "The signature is not 64 bytes.",
    mismatch: "The signature does not match the sign-in message (NEP-413, sha256, recipient quick-market, no callback URL).",
  }[reason]
  return `Signature is invalid\n${detail}`
}

async function nearSignatureOk(input: {
  address: string
  signature: string
  issued: number
  nonce?: unknown
  publicKey?: unknown
}): Promise<true | NearSignFailure> {
  const message = nearLoginMessage(input.address, input.issued)
  const nonce = nonceBytes(input.nonce)
  if (!nonce) return "nonce"
  if (typeof input.publicKey !== "string" || !parseNearPublicKey(input.publicKey)) return "public-key"
  if (isImplicitAccount(input.address)) {
    const pub = parseNearPublicKey(input.publicKey)
    if (!pub || hex(pub) !== input.address) return "implicit-key"
  } else {
    const present = await accessKeyOnAccount(input.address, input.publicKey)
    if (!present) return "access-key"
  }
  const verified = await verifyNep413({
    message,
    account: input.address,
    publicKey: input.publicKey,
    signature: input.signature,
    nonce,
    recipient: NEP413_RECIPIENT,
  })
  return verified === true ? true : verified
}

export async function openSession(input: {
  address: string
  signature: string
  issued: number
  now: number
  nonce?: unknown
  publicKey?: unknown
}): Promise<{ ok: true; token: string; you: You } | { ok: false; error: string }> {
  let chainKey: ChainKey
  let chainId: number
  try {
    const chain = chainConfig()
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
    let ok: true | NearSignFailure
    try {
      ok = await nearSignatureOk({
        address,
        signature: input.signature,
        issued: input.issued,
        nonce: input.nonce,
        publicKey: input.publicKey,
      })
    } catch (error) {
      if (isNearCooling(error) || nearRpcBusy(error)) return { ok: false, error: NEAR_BUSY }
      throw error
    }
    if (ok !== true) return { ok: false, error: nearSignError(ok) }
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
  const tx = db.transaction(() => {
    db.query("INSERT INTO login_sigs (chain_key, signature, expires_at) VALUES (?, ?, ?)").run(chainKey, input.signature, input.now + LOGIN_SKEW_MS)
    ensureUser(address)
    db.query("INSERT INTO sessions (chain_key, token, address, expires_at) VALUES (?, ?, ?, ?)").run(chainKey, token, address, input.now + SESSION_MS)
  })
  tx()
  return { ok: true, token, you: youFor(address)! }
}

export function sessionChainForToken(token: string, now = Date.now()): ChainKey | null {
  if (!/^[0-9a-f]{64}$/i.test(token)) return null
  const row = getDb().query("SELECT chain_key, expires_at FROM sessions WHERE token = ?").get(token) as {
    chain_key: ChainKey
    expires_at: number
  } | null
  if (!row || row.expires_at <= now) return null
  return row.chain_key
}

export function readSessionToken(token: unknown, now = Date.now()): { address: string | null; rejected: boolean } {
  // A hello with no token is an anonymous visitor. Only a token that was sent can be rejected.
  if (token == null) return { address: null, rejected: false }
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/i.test(token)) return { address: null, rejected: true }
  const row = getDb()
    .query("SELECT chain_key, address, expires_at FROM sessions WHERE token = ?")
    .get(token) as { chain_key: ChainKey; address: string; expires_at: number } | null
  if (!row || row.expires_at <= now || row.chain_key !== activeChainKey()) return { address: null, rejected: true }
  return { address: row.address, rejected: false }
}

export function readSession(req: Request, now = Date.now()): { address: string | null; rejected: boolean } {
  const header = req.headers.get("authorization") ?? ""
  if (!header) return { address: null, rejected: false }
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(header)
  if (!match) return { address: null, rejected: true }
  return readSessionToken(match[1], now)
}

export function endSessionToken(token: string) {
  if (!/^[0-9a-f]{64}$/i.test(token)) return
  getDb().query("DELETE FROM sessions WHERE token = ?").run(token)
}

export function endSession(req: Request) {
  const header = req.headers.get("authorization") ?? ""
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(header)
  if (!match) return
  endSessionToken(match[1]!)
}

/** The last scheduled prune, for the internal health routes. Requests never prune. */
let lastPrune: { deleted: number; at: number } | null = null

export function lastAuthPrune(): { deleted: number; at: number } | null {
  return lastPrune
}

/** Delete expired session tokens and sign-in signatures. Boot and the health
 *  interval call this; the expiry indexes keep both deletes off table scans. */
export function pruneExpiredAuth(now = Date.now()): number {
  const db = getDb()
  const expired = db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes
  const sigs = db.query("DELETE FROM login_sigs WHERE expires_at <= ?").run(now).changes
  lastPrune = { deleted: expired + sigs, at: now }
  return expired + sigs
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

