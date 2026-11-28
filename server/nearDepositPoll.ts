import type { ChainKey } from "../shared/chain"
import { isNearAccountId } from "../shared/near"
import { activeChainKey } from "./activeChain"
import { loadEnv } from "./env"
import { nearLedgerOnly } from "./nearLedger"
import { getDb } from "./db"
import { applyNearDeposit, callNearRpc, nearRpcEndpoints, parseNearDeposits } from "./near"

/**
 * D1 (RELIABILITY_PLAN_V2 §2): deposit discovery via the NearBlocks v3 account
 * event feed — free, keyless — with every credit verified on-chain through the
 * existing parser. The indexer is a hint; the chain is truth. The block walk in
 * near.ts stays as the automatic fallback: it only runs while this poll has
 * been failing past NEAR_DEPOSIT_SCAN_AFTER_MS, and idles again on recovery.
 */

/** The v3 base. A future v4 or a self-hosted index is one env line. */
export const NEAR_DEPOSIT_INDEX_URL_DEFAULT = "https://api-testnet.nearblocks.io/v3"
export const NEAR_DEPOSIT_POLL_DEFAULT_MS = 20_000
export const NEAR_DEPOSIT_SCAN_AFTER_DEFAULT_MS = 10 * 60_000

const NEAR_DEPOSIT_INDEX_PAGE_LIMIT = 50
/** Pages per poll cycle. The first-boot sweep of this account is 5 pages today;
 *  the cap bounds a pathological history to one bounded cycle. */
const NEAR_DEPOSIT_INDEX_PAGE_CAP = 100
const NEAR_DEPOSIT_INDEX_TIMEOUT_MS = 10_000
/** Respect a 429 retry-after, but never park the poll for more than this. */
const NEAR_DEPOSIT_INDEX_HOLD_MAX_MS = 5 * 60_000

/**
 * Unset uses the default index; blank disables the poll (scan-only, v1
 * behavior); a value is the v3 base URL without a trailing slash.
 */
export function nearDepositIndexUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.NEAR_DEPOSIT_INDEX_URL
  if (raw === undefined) return NEAR_DEPOSIT_INDEX_URL_DEFAULT
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed.replace(/\/+$/, "")
}

/** Optional bearer key. Default blank — the free tier needs no registration. */
export function nearDepositIndexKey(env: Record<string, string | undefined> = process.env): string {
  const raw = env.NEAR_DEPOSIT_INDEX_KEY
  return typeof raw === "string" ? raw.trim() : ""
}

export function nearDepositPollMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.NEAR_DEPOSIT_POLL_MS)
  if (!Number.isInteger(raw)) return NEAR_DEPOSIT_POLL_DEFAULT_MS
  return Math.min(300_000, Math.max(5_000, raw))
}

/** Past this much failing poll the custody loop walks blocks again. */
export function nearDepositScanAfterMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.NEAR_DEPOSIT_SCAN_AFTER_MS)
  if (!Number.isInteger(raw)) return NEAR_DEPOSIT_SCAN_AFTER_DEFAULT_MS
  return Math.min(3_600_000, Math.max(5_000, raw))
}

/** Our own stop-point. Never persist the index's opaque cursors — their format
 *  changes without notice (see the v3 migration notes). */
export type NearDepositIndexMarker = { blockHeight: number; eventIndex: number; receiptId: string }

export type NearDepositIndexEvent = {
  blockHeight: number
  eventIndex: number
  receiptId: string
  txHash: string
  cause: string
  contract: string
  affected: string
  involved: string | null
  delta: number
  timestampNs: bigint
}

/** A v3 ft-txns row, defensively parsed. Null = malformed hint (skipped, counted). */
export function parseNearDepositIndexEvent(raw: unknown): NearDepositIndexEvent | null {
  if (!raw || typeof raw !== "object") return null
  const row = raw as Record<string, unknown>
  const block = row.block && typeof row.block === "object" ? (row.block as Record<string, unknown>) : {}
  const blockHeight = Number(block.block_height ?? row.block_height)
  if (!Number.isSafeInteger(blockHeight) || blockHeight <= 0) return null
  const eventIndex = Number(row.event_index)
  if (!Number.isSafeInteger(eventIndex) || eventIndex < 0) return null
  const receiptId = typeof row.receipt_id === "string" ? row.receipt_id : ""
  const txHash = typeof row.transaction_hash === "string" ? row.transaction_hash : ""
  if (!receiptId || !txHash) return null
  const delta = Number(row.delta_amount)
  if (!Number.isFinite(delta)) return null
  const timestampNs = BigInt(/^\d+$/.test(String(row.block_timestamp)) ? String(row.block_timestamp) : "0")
  return {
    blockHeight,
    eventIndex,
    receiptId,
    txHash,
    cause: typeof row.cause === "string" ? row.cause : "",
    contract: typeof row.contract_account_id === "string" ? row.contract_account_id : "",
    affected: typeof row.affected_account_id === "string" ? row.affected_account_id : "",
    involved: typeof row.involved_account_id === "string" ? row.involved_account_id : null,
    delta,
    timestampNs,
  }
}

/** Newest-first order key: block height, then the event index, then the receipt. */
export function nearDepositIndexAtOrBefore(
  event: Pick<NearDepositIndexEvent, "blockHeight" | "eventIndex" | "receiptId">,
  marker: NearDepositIndexMarker,
): boolean {
  if (event.blockHeight !== marker.blockHeight) return event.blockHeight < marker.blockHeight
  if (event.eventIndex !== marker.eventIndex) return event.eventIndex < marker.eventIndex
  return event.receiptId <= marker.receiptId
}

class NearDepositIndexThrottled extends Error {
  retryAfterMs: number | null
  constructor(message: string, retryAfterMs: number | null) {
    super(message)
    this.name = "NearDepositIndexThrottled"
    this.retryAfterMs = retryAfterMs
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 300)
  return String(error).slice(0, 300)
}

function markerKey(chain: ChainKey): string {
  return `${chain}:near_deposit_index_marker`
}

function readMarker(chain: ChainKey): NearDepositIndexMarker | null {
  try {
    const row = getDb().query("SELECT value FROM meta WHERE key = ?").get(markerKey(chain)) as { value: string } | null
    if (!row) return null
    const parsed = JSON.parse(row.value) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const { blockHeight, eventIndex, receiptId } = parsed as Record<string, unknown>
    if (!Number.isSafeInteger(blockHeight) || !Number.isSafeInteger(eventIndex) || typeof receiptId !== "string") {
      return null
    }
    return { blockHeight: blockHeight as number, eventIndex: eventIndex as number, receiptId }
  } catch {
    return null
  }
}

function saveMarker(chain: ChainKey, marker: NearDepositIndexMarker): void {
  getDb()
    .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(markerKey(chain), JSON.stringify(marker))
}

type IndexPage = { events: unknown[]; nextPage: string | null }

async function fetchIndexPage(
  url: string,
  key: string,
  treasury: string,
  cursor: string | null,
): Promise<IndexPage> {
  const target =
    `${url}/accounts/${encodeURIComponent(treasury)}/ft-txns?limit=${NEAR_DEPOSIT_INDEX_PAGE_LIMIT}` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
  const headers: Record<string, string> = { accept: "application/json" }
  if (key) headers.authorization = `Bearer ${key}`
  const response = await fetch(target, { headers, signal: AbortSignal.timeout(NEAR_DEPOSIT_INDEX_TIMEOUT_MS) })
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after"))
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null
    const text = await response.text().catch(() => "")
    const detail = text ? ` (${text.slice(0, 160)})` : ""
    if (response.status === 429) throw new NearDepositIndexThrottled(`NEAR deposit index returned HTTP 429${detail}`, retryAfterMs)
    throw new Error(`NEAR deposit index returned HTTP ${response.status}${detail}`)
  }
  const body = (await response.json().catch(() => null)) as
    | { data?: unknown; meta?: { next_page?: unknown } }
    | null
  if (!body || !Array.isArray(body.data)) throw new Error("NEAR deposit index reply is unreadable")
  const next = body.meta?.next_page
  return { events: body.data, nextPage: typeof next === "string" && next ? next : null }
}

type PollState = {
  startedAt: number | null
  lastPollAt: number | null
  lastOkAt: number | null
  lastError: string | null
  failures: number
  holdUntilMs: number | null
  eventsSeen: number
  transfersSeen: number
  credits: number
  hintMismatches: number
  malformed: number
  lastEventBlock: number | null
  marker: NearDepositIndexMarker | null
  markerAt: number | null
}

const poll: PollState = {
  startedAt: null,
  lastPollAt: null,
  lastOkAt: null,
  lastError: null,
  failures: 0,
  holdUntilMs: null,
  eventsSeen: 0,
  transfersSeen: 0,
  credits: 0,
  hintMismatches: 0,
  malformed: 0,
  lastEventBlock: null,
  marker: null,
  markerAt: null,
}

/** Test hook: clear the runtime poll state between suites. */
export function resetNearDepositPollForTest(): void {
  poll.startedAt = null
  poll.lastPollAt = null
  poll.lastOkAt = null
  poll.lastError = null
  poll.failures = 0
  poll.holdUntilMs = null
  poll.eventsSeen = 0
  poll.transfersSeen = 0
  poll.credits = 0
  poll.hintMismatches = 0
  poll.malformed = 0
  poll.lastEventBlock = null
  poll.marker = null
  poll.markerAt = null
}

export type NearDepositIndexRun = { ok: boolean; pages: number; events: number; credits: number; held: boolean }

type HandleOutcome = "skip" | "credited" | "mismatch" | "retry"

/**
 * One poll cycle. The walk is newest-first to find the stop-point fast, then
 * handles events oldest-first so the marker only ever moves over events that
 * are fully handled — an unverified event leaves the marker for the next poll.
 */
export async function pollNearDepositIndex(treasury: string): Promise<NearDepositIndexRun> {
  if (nearLedgerOnly()) return { ok: true, pages: 0, events: 0, credits: 0, held: false }
  const now = Date.now()
  poll.lastPollAt = now
  if (poll.startedAt == null) poll.startedAt = now
  const url = nearDepositIndexUrl()
  if (!url) return { ok: false, pages: 0, events: 0, credits: 0, held: false }
  if (poll.holdUntilMs != null && now < poll.holdUntilMs) return { ok: false, pages: 0, events: 0, credits: 0, held: true }
  const chainKey = activeChainKey()
  const token = loadEnv().tokenAccount.trim()
  const key = nearDepositIndexKey()
  const marker = readMarker(chainKey)
  poll.marker = marker
  const collected: NearDepositIndexEvent[] = []
  let pages = 0
  let cursor: string | null = null
  try {
    for (;;) {
      const page = await fetchIndexPage(url, key, treasury, cursor)
      pages += 1
      let stopped = false
      for (const raw of page.events) {
        const event = parseNearDepositIndexEvent(raw)
        if (!event) {
          poll.malformed += 1
          continue
        }
        if (marker && nearDepositIndexAtOrBefore(event, marker)) {
          stopped = true
          break
        }
        collected.push(event)
      }
      if (stopped || !page.nextPage || pages >= NEAR_DEPOSIT_INDEX_PAGE_CAP) break
      cursor = page.nextPage
    }
  } catch (error) {
    poll.failures += 1
    if (error instanceof NearDepositIndexThrottled) {
      // A 429 with no retry-after still has to park. The free tier is 10/min
      // and 420/day; retrying on the catch-up gap (2 s) would spend that quota
      // and keep the ban in place. The hold cap is the park when the header is absent.
      const retryAfterMs = error.retryAfterMs ?? NEAR_DEPOSIT_INDEX_HOLD_MAX_MS
      poll.holdUntilMs = Date.now() + Math.min(retryAfterMs, NEAR_DEPOSIT_INDEX_HOLD_MAX_MS)
    }
    poll.lastError = messageOf(error)
    return { ok: false, pages, events: 0, credits: 0, held: false }
  }
  collected.reverse()
  let credits = 0
  let events = 0
  for (const event of collected) {
    events += 1
    poll.eventsSeen += 1
    if (poll.lastEventBlock == null || event.blockHeight > poll.lastEventBlock) poll.lastEventBlock = event.blockHeight
    const outcome = await handleIndexEvent(chainKey, treasury, token, event)
    if (outcome === "credited") {
      credits += 1
      poll.credits += 1
    }
    if (outcome === "retry") {
      // An unverified hint keeps its place: the marker did not move past it,
      // so the next poll walks down to it again and retries.
      poll.failures += 1
      return { ok: false, pages, events, credits, held: false }
    }
  }
  poll.lastOkAt = Date.now()
  poll.failures = 0
  poll.lastError = null
  poll.holdUntilMs = null
  return { ok: true, pages, events: collected.length, credits, held: false }
}

async function handleIndexEvent(
  chainKey: ChainKey,
  treasury: string,
  token: string,
  event: NearDepositIndexEvent,
): Promise<HandleOutcome> {
  // Mints are treasury solvency, not player deposits; other tokens and
  // outbound moves are not ours. All are handled and the marker advances.
  if (event.cause !== "TRANSFER" || event.contract !== token || event.affected !== treasury || !(event.delta > 0)) {
    advanceMarker(chainKey, event)
    return "skip"
  }
  poll.transfersSeen += 1
  const sender = event.involved
  if (!sender || !isNearAccountId(sender)) {
    // No live TRANSFER has ever hit this account, so the sender field is an
    // assumption the D1 rollout's one-time test deposit validates. A hint we
    // cannot address stays put and retries — it is never skipped.
    poll.lastError = `transfer hint without a sender at block ${event.blockHeight} (${event.txHash})`
    return "retry"
  }
  let payload: unknown
  try {
    payload = await callNearRpc(
      nearRpcEndpoints(),
      "EXPERIMENTAL_tx_status",
      { tx_hash: event.txHash, sender_account_id: sender, wait_until: "NONE" },
      { background: true },
    )
  } catch (error) {
    poll.lastError = messageOf(error)
    return "retry"
  }
  // The chain is truth: any deposit the receipt actually carries is credited,
  // whether or not the hinted (sender, amount) is among the parsed rows.
  const rows = parseNearDeposits(payload, treasury, token, event.timestampNs)
  let credited = 0
  for (const row of rows) {
    if (applyNearDeposit(row)) {
      credited += 1
      console.log(`deposit ${row.from} ${row.amountMicros} ${row.txHash}`)
    }
  }
  const matched = rows.some((row) => row.from === sender && row.amountMicros === event.delta)
  if (rows.length === 0 || !matched) {
    poll.hintMismatches += 1
    if (rows.length === 0) poll.lastError = `verified hint carried no deposit (${event.txHash})`
  }
  advanceMarker(chainKey, event)
  return credited > 0 ? "credited" : "mismatch"
}

function advanceMarker(chainKey: ChainKey, event: NearDepositIndexEvent): void {
  const marker: NearDepositIndexMarker = {
    blockHeight: event.blockHeight,
    eventIndex: event.eventIndex,
    receiptId: event.receiptId,
  }
  poll.marker = marker
  poll.markerAt = Date.now()
  saveMarker(chainKey, marker)
}

export type NearDepositIndexHealth = {
  enabled: boolean
  url: string | null
  lastPollAt: number | null
  lastOkAt: number | null
  lastError: string | null
  failures: number
  eventsSeen: number
  transfersSeen: number
  credits: number
  hintMismatches: number
  malformed: number
  lastEventBlock: number | null
  marker: NearDepositIndexMarker | null
  markerAt: number | null
  downForMs: number | null
}

export function nearDepositIndexHealth(now = Date.now()): NearDepositIndexHealth {
  const url = nearDepositIndexUrl()
  const anchor = poll.lastOkAt ?? poll.startedAt
  return {
    enabled: url != null,
    url,
    lastPollAt: poll.lastPollAt,
    lastOkAt: poll.lastOkAt,
    lastError: poll.lastError,
    failures: poll.failures,
    eventsSeen: poll.eventsSeen,
    transfersSeen: poll.transfersSeen,
    credits: poll.credits,
    hintMismatches: poll.hintMismatches,
    malformed: poll.malformed,
    lastEventBlock: poll.lastEventBlock,
    marker: poll.marker,
    markerAt: poll.markerAt,
    downForMs: url == null ? null : anchor != null ? Math.max(0, now - anchor) : null,
  }
}

/**
 * The block walk runs only while the poll is off or has been failing past the
 * grace window. A green poll idles the walk entirely, so the ~81-calls/min
 * serial scan stops grinding against blocks that carry no deposits.
 */
export function nearDepositScanActive(now = Date.now(), env: Record<string, string | undefined> = process.env): boolean {
  if (nearLedgerOnly(env)) return false
  const url = nearDepositIndexUrl()
  if (!url) return true
  const anchor = poll.lastOkAt ?? poll.startedAt
  if (anchor == null) return false
  return now - anchor > nearDepositScanAfterMs()
}
