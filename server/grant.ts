import type { ChainKey } from "../shared/chain"
import { MINT_CONFIRMATIONS } from "../shared/mint"
import { marketPreferences } from "../shared/market"
import { activeChainKey } from "./activeChain"
import { getDb } from "./db"
import { trackGrant } from "./grantWait"
import { normalizeAccount } from "./money"

export type GrantProgress = { txHash?: string; seen?: number }

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

/** Claim the in-flight slot, then mint. The claim commits before this returns. */
export function startGrant(input: {
  address: string
  now: number
  chainKey: ChainKey
  amount: number
  intervalMs: number
  mint: (amountMicros: number, report: (progress: GrantProgress) => void) => Promise<void>
}): { claimed: boolean; done: Promise<boolean> } {
  if (input.chainKey !== "base-sepolia" && input.chainKey !== "near-testnet") return { claimed: false, done: Promise.resolve(false) }
  const address = normalizeAccount(input.address, input.chainKey)
  if (!address) return { claimed: false, done: Promise.resolve(false) }
  if (!claimSlot(address, input.now, input.intervalMs, input.chainKey)) return { claimed: false, done: Promise.resolve(false) }
  const done = trackGrant(address, () => finishGrant(address, input.now, input.amount, input.mint, input.chainKey))
  return { claimed: true, done }
}

export async function applyGrant(input: {
  address: string
  now: number
  chainKey: ChainKey
  amount: number
  intervalMs: number
  mint: (amountMicros: number, report: (progress: GrantProgress) => void) => Promise<void>
}): Promise<boolean> {
  const started = startGrant(input)
  if (!started.claimed) return false
  return started.done
}

/** The mint hash, stored while the slot is still open. A hash is already step 1. */
export function noteGrantTx(address: string, hash: string, chainKey: ChainKey = activeChainKey()): void {
  noteGrantProgress(address, chainKey, { txHash: hash, seen: 1 })
}

/** Record the hash and the meter. Seen never moves backward. */
export function noteGrantProgress(address: string, chainKey: ChainKey, progress: GrantProgress): void {
  const normalized = normalizeAccount(address, chainKey)
  if (!normalized) return
  const hash = progress.txHash
  if (hash && hash.length > 0) {
    getDb()
      .query(
        "UPDATE users SET grant_tx = ? WHERE chain_key = ? AND address = ? AND grant_pending_at IS NOT NULL AND grant_tx IS NULL",
      )
      .run(hash, chainKey, normalized)
  }
  if (typeof progress.seen === "number" && Number.isFinite(progress.seen)) {
    const seen = Math.max(0, Math.min(MINT_CONFIRMATIONS, Math.floor(progress.seen)))
    getDb()
      .query(
        `UPDATE users SET grant_seen = CASE WHEN COALESCE(grant_seen, 0) > ? THEN grant_seen ELSE ? END
         WHERE chain_key = ? AND address = ? AND grant_pending_at IS NOT NULL`,
      )
      .run(seen, seen, chainKey, normalized)
  }
}

/** The hash can arrive while the mint is still waiting on blocks. */
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
  grant_pending_at: number | null
}

/** One transaction. Eligible rows are due and have no pending grant. */
function claimSlot(address: string, now: number, intervalMs: number, chainKey: ChainKey): boolean {
  const tx = getDb().transaction(() => {
    const row = getDb()
      .query("SELECT grant_at, grant_pending_at FROM users WHERE chain_key = ? AND address = ?")
      .get(chainKey, address) as GrantRow | null
    if (!row) {
      getDb()
        .query(
          "INSERT INTO users (chain_key, address, balance_micros, created_at, grant_pending_at, grant_seen) VALUES (?, ?, 0, ?, ?, 0)",
        )
        .run(chainKey, address, now, now)
      return true
    }
    if (row.grant_pending_at != null) return false
    if (!grantDue(row.grant_at, now, intervalMs)) return false
    const result = getDb()
      .query(
        "UPDATE users SET grant_pending_at = ?, grant_tx = NULL, grant_seen = 0 WHERE chain_key = ? AND address = ? AND grant_pending_at IS NULL",
      )
      .run(now, chainKey, address)
    return result.changes === 1
  })
  return tx()
}

async function finishGrant(
  address: string,
  now: number,
  amount: number,
  mint: (amountMicros: number, report: (progress: GrantProgress) => void) => Promise<void>,
  chainKey: ChainKey,
): Promise<boolean> {
  try {
    await mint(amount, (progress) => noteGrantProgress(address, chainKey, progress))
  } catch (error) {
    clearPending(address, chainKey)
    throw error
  }
  return creditGrant(address, now, amount, chainKey)
}

function creditGrant(address: string, now: number, amount: number, chainKey: ChainKey): boolean {
  const tx = getDb().transaction(() => {
    const result = getDb()
      .query(
        `UPDATE users
         SET balance_micros = balance_micros + ?, grant_at = ?, grant_pending_at = NULL, grant_tx = NULL, grant_seen = 0
         WHERE chain_key = ? AND address = ? AND grant_pending_at IS NOT NULL`,
      )
      .run(amount, now, chainKey, address)
    return result.changes === 1
  })
  return tx()
}

function clearPending(address: string, chainKey: ChainKey) {
  getDb()
    .query("UPDATE users SET grant_pending_at = NULL, grant_tx = NULL, grant_seen = 0 WHERE chain_key = ? AND address = ?")
    .run(chainKey, address)
}

type PendingGrantRow = { address: string; grant_pending_at: number; grant_tx: string | null }

/**
 * After a restart the in-memory mint is gone.
 * A stored hash is watched again and credited at step 3. A row with no hash was never accepted, so the slot opens.
 */
export function resumePendingGrants(input: {
  chainKey: ChainKey
  amount: number
  watch: (hash: string, report: (progress: GrantProgress) => void) => Promise<void>
}): Promise<void> {
  const rows = getDb()
    .query("SELECT address, grant_pending_at, grant_tx FROM users WHERE chain_key = ? AND grant_pending_at IS NOT NULL")
    .all(input.chainKey) as PendingGrantRow[]
  const jobs: Promise<unknown>[] = []
  for (const row of rows) {
    const address = normalizeAccount(row.address, input.chainKey) ?? row.address
    if (!row.grant_tx) {
      clearPending(address, input.chainKey)
      continue
    }
    const hash = row.grant_tx
    jobs.push(
      finishWatched({
        address,
        chainKey: input.chainKey,
        pendingAt: row.grant_pending_at,
        amount: input.amount,
        watch: (report) => input.watch(hash, report),
      }).catch((error) => {
        console.error(error instanceof Error ? error.message : error)
      }),
    )
  }
  return Promise.all(jobs).then(() => undefined)
}

function finishWatched(input: {
  address: string
  chainKey: ChainKey
  pendingAt: number
  amount: number
  watch: (report: (progress: GrantProgress) => void) => Promise<void>
}): Promise<boolean> {
  return trackGrant(input.address, async () => {
    try {
      await input.watch((progress) => noteGrantProgress(input.address, input.chainKey, progress))
    } catch (error) {
      clearPending(input.address, input.chainKey)
      throw error
    }
    return creditGrant(input.address, input.pendingAt, input.amount, input.chainKey)
  })
}
