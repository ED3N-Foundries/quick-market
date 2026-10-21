import type { ChainKey } from "../shared/chain"
import { marketPreferences } from "../shared/market"
import { getDb } from "./db"
import { trackGrant } from "./grantWait"
import { normalizeAddress } from "./money"

export function grantSettings(): { amount: number; intervalMs: number } {
  return { amount: marketPreferences.grantMicros, intervalMs: marketPreferences.grantIntervalMs }
}

export function grantDue(grantAt: number | null, now: number, intervalMs: number): boolean {
  if (grantAt === null) return true
  return now - grantAt >= intervalMs
}

/** Automatic credit only for an address that has never received a grant. */
export function grantOnSignIn(grantAt: number | null): boolean {
  return grantAt === null
}

/** Outstanding ledger to back once. Null once qm_usdc_v1 is recorded. */
export function cutoverAmount(flag: string | null, sumMicros: number): number | null {
  if (flag !== null) return null
  if (!Number.isSafeInteger(sumMicros) || sumMicros < 0) throw new Error("Balance sum is invalid")
  return sumMicros
}

/**
 * Claim the in-flight slot, then mint.
 * The claim commits before this returns, so a caller can answer and let `done` finish.
 */
export function startGrant(input: {
  address: string
  now: number
  chainKey: ChainKey
  amount: number
  intervalMs: number
  mint: (amountMicros: number) => Promise<void>
}): { claimed: boolean; done: Promise<boolean> } {
  if (input.chainKey !== "base-sepolia") return { claimed: false, done: Promise.resolve(false) }
  const address = normalizeAddress(input.address)
  if (!address) return { claimed: false, done: Promise.resolve(false) }
  if (!claimSlot(address, input.now, input.intervalMs)) return { claimed: false, done: Promise.resolve(false) }
  const done = trackGrant(address, () => finishGrant(address, input.now, input.amount, input.mint))
  return { claimed: true, done }
}

export async function applyGrant(input: {
  address: string
  now: number
  chainKey: ChainKey
  amount: number
  intervalMs: number
  mint: (amountMicros: number) => Promise<void>
}): Promise<boolean> {
  const started = startGrant(input)
  if (!started.claimed) return false
  return started.done
}

/** The mint hash, stored while the slot is still open. */
export function noteGrantTx(address: string, hash: string): void {
  const normalized = normalizeAddress(address)
  if (!normalized || hash.length === 0) return
  getDb()
    .query("UPDATE users SET grant_tx = ? WHERE address = ? AND grant_pending_at IS NOT NULL")
    .run(hash, normalized)
}

/**
 * The hash can arrive while the mint is still waiting on blocks.
 * Pending means the caller should answer now and let `done` credit afterwards.
 */
export async function settleGrantRequest<T>(input: {
  done: Promise<T>
  hash: Promise<string>
}): Promise<{ kind: "done"; value: T } | { kind: "pending"; txHash: string }> {
  return Promise.race([
    input.done.then((value) => ({ kind: "done" as const, value })),
    input.hash.then((txHash) => ({ kind: "pending" as const, txHash })),
  ])
}

type GrantRow = {
  grant_at: number | null
  is_bot: number
  grant_pending_at: number | null
}

/** One transaction. Eligible rows are not bots, are due, and have no pending grant. */
function claimSlot(address: string, now: number, intervalMs: number): boolean {
  const tx = getDb().transaction(() => {
    const row = getDb()
      .query("SELECT grant_at, is_bot, grant_pending_at FROM users WHERE address = ?")
      .get(address) as GrantRow | null
    if (!row) {
      getDb()
        .query(
          "INSERT INTO users (address, balance_micros, created_at, is_bot, grant_pending_at) VALUES (?, 0, ?, 0, ?)",
        )
        .run(address, now, now)
      return true
    }
    if (row.is_bot === 1) return false
    if (row.grant_pending_at != null) return false
    if (!grantDue(row.grant_at, now, intervalMs)) return false
    const result = getDb()
      .query("UPDATE users SET grant_pending_at = ? WHERE address = ? AND grant_pending_at IS NULL")
      .run(now, address)
    return result.changes === 1
  })
  return tx()
}

async function finishGrant(
  address: string,
  now: number,
  amount: number,
  mint: (amountMicros: number) => Promise<void>,
): Promise<boolean> {
  try {
    await mint(amount)
  } catch (error) {
    clearPending(address)
    throw error
  }
  return creditGrant(address, now, amount)
}

function creditGrant(address: string, now: number, amount: number): boolean {
  const tx = getDb().transaction(() => {
    const result = getDb()
      .query(
        `UPDATE users
         SET balance_micros = balance_micros + ?, grant_at = ?, grant_pending_at = NULL, grant_tx = NULL
         WHERE address = ? AND grant_pending_at IS NOT NULL`,
      )
      .run(amount, now, address)
    return result.changes === 1
  })
  return tx()
}

function clearPending(address: string) {
  getDb().query("UPDATE users SET grant_pending_at = NULL, grant_tx = NULL WHERE address = ?").run(address)
}
