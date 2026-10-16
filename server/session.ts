import { timingSafeEqual } from "node:crypto"
import { recoverMessageAddress, type Hex } from "viem"
import { chainFromEnv } from "../shared/chain"
import { LOGIN_SKEW_MS, SESSION_MS, loginMessage } from "../shared/login"
import { getDb } from "./db"
import { normalizeAddress } from "./money"
import { ensureUser, youFor, type You } from "./rounds"

const SIGNATURE = /^0x[0-9a-fA-F]+$/

export async function openSession(input: {
  address: string
  signature: string
  issued: number
  now: number
  botSecret?: unknown
}): Promise<{ ok: true; token: string; you: You } | { ok: false; error: string }> {
  const address = normalizeAddress(input.address)
  if (!address) return { ok: false, error: "Address is invalid" }
  if (!Number.isInteger(input.issued) || Math.abs(input.now - input.issued) > LOGIN_SKEW_MS) {
    return { ok: false, error: "Sign-in expired" }
  }
  if (!SIGNATURE.test(input.signature)) return { ok: false, error: "Signature is invalid" }

  let chainId: number
  try {
    chainId = chainFromEnv(process.env.CHAIN, process.env.USDC_ADDRESS).id
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Chain is invalid" }
  }

  const message = loginMessage(chainId, address, input.issued)
  let recovered = ""
  try {
    recovered = (await recoverMessageAddress({ message, signature: input.signature as Hex })).toLowerCase()
  } catch {
    return { ok: false, error: "Signature is invalid" }
  }
  if (recovered !== address) return { ok: false, error: "Signature is invalid" }

  const db = getDb()
  const seen = db.query("SELECT signature FROM login_sigs WHERE signature = ?").get(input.signature)
  if (seen) return { ok: false, error: "Sign-in already used" }

  const token = randomToken()
  const bot = botSecretOk(input.botSecret)
  const tx = db.transaction(() => {
    db.query("INSERT INTO login_sigs (signature, expires_at) VALUES (?, ?)").run(input.signature, input.now + LOGIN_SKEW_MS)
    if (bot) {
      db.query(
        `INSERT INTO users (address, balance_micros, created_at, is_bot) VALUES (?, 0, ?, 1)
         ON CONFLICT(address) DO UPDATE SET is_bot = 1`,
      ).run(address, input.now)
    } else {
      ensureUser(address)
    }
    db.query("INSERT INTO sessions (token, address, expires_at) VALUES (?, ?, ?)").run(token, address, input.now + SESSION_MS)
  })
  tx()
  return { ok: true, token, you: youFor(address)! }
}

export function readSession(req: Request, now = Date.now()): { address: string | null; rejected: boolean } {
  const header = req.headers.get("authorization") ?? ""
  if (!header) return { address: null, rejected: false }
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(header)
  if (!match) return { address: null, rejected: true }
  const row = getDb().query("SELECT address, expires_at FROM sessions WHERE token = ?").get(match[1]!) as
    | { address: string; expires_at: number }
    | null
  if (!row || row.expires_at <= now) return { address: null, rejected: true }
  return { address: row.address, rejected: false }
}

export function endSession(req: Request) {
  const header = req.headers.get("authorization") ?? ""
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(header)
  if (!match) return
  getDb().query("DELETE FROM sessions WHERE token = ?").run(match[1]!)
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
  const expected = process.env.AGENT_SECRET ?? ""
  if (!expected || typeof given !== "string" || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}
