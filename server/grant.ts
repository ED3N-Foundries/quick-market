import type { ChainKey } from "../shared/chain"
import { getDb } from "./db"
import { normalizeAddress } from "./money"
import { ensureUser } from "./rounds"

export const DEFAULT_GRANT_MICROS = 100_000_000
export const DEFAULT_GRANT_INTERVAL_MS = 2 * 60 * 1000

const tails = new Map<string, Promise<unknown>>()

export function grantSettings(
  env: { GRANT_MICROS?: string; GRANT_INTERVAL_MS?: string } = {
    GRANT_MICROS: process.env.GRANT_MICROS,
    GRANT_INTERVAL_MS: process.env.GRANT_INTERVAL_MS,
  },
): {
  amount: number
  intervalMs: number
} {
  const amount = positiveInt(env.GRANT_MICROS, DEFAULT_GRANT_MICROS, "GRANT_MICROS")
  const intervalMs = positiveInt(env.GRANT_INTERVAL_MS, DEFAULT_GRANT_INTERVAL_MS, "GRANT_INTERVAL_MS")
  return { amount, intervalMs }
}

export function grantDue(grantAt: number | null, now: number, intervalMs: number): boolean {
  if (grantAt === null) return true
  return now - grantAt >= intervalMs
}

/** Outstanding ledger to back once. Null once qm_usdc_v1 is recorded. */
export function cutoverAmount(flag: string | null, sumMicros: number): number | null {
  if (flag !== null) return null
  if (!Number.isSafeInteger(sumMicros) || sumMicros < 0) throw new Error("Balance sum is invalid")
  return sumMicros
}

export async function applyGrant(input: {
  address: string
  now: number
  chainKey: ChainKey
  amount: number
  intervalMs: number
  mint: (amountMicros: number) => Promise<void>
}): Promise<boolean> {
  if (input.chainKey !== "base-sepolia") return false
  const address = normalizeAddress(input.address)
  if (!address) return false
  const previous = tails.get(address) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(() => grantOnce(address, input))
  tails.set(address, run)
  try {
    return await run
  } finally {
    if (tails.get(address) === run) tails.delete(address)
  }
}

async function grantOnce(
  address: string,
  input: {
    now: number
    amount: number
    intervalMs: number
    mint: (amountMicros: number) => Promise<void>
  },
): Promise<boolean> {
  if (!due(address, input.now, input.intervalMs)) return false
  await input.mint(input.amount)
  const tx = getDb().transaction(() => {
    if (!due(address, input.now, input.intervalMs)) return false
    ensureUser(address)
    getDb()
      .query("UPDATE users SET balance_micros = balance_micros + ?, grant_at = ? WHERE address = ?")
      .run(input.amount, input.now, address)
    return true
  })
  return tx()
}

function due(address: string, now: number, intervalMs: number): boolean {
  const row = getDb().query("SELECT grant_at FROM users WHERE address = ?").get(address) as
    | { grant_at: number | null }
    | null
  return grantDue(row?.grant_at ?? null, now, intervalMs)
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}
