import { LATE_BUY_IN_CODE, LATE_BUY_IN_ERROR } from "../shared/buyIn"
import { GRANT_FOLLOW_MS, MINT_CONFIRMATIONS } from "../shared/mint"
import { handoffBanner, tickerFor, type Handoff, type Ticker } from "../shared/source"
import { markAccountDirty } from "./accountDirty"
import { activeChainKey } from "./activeChain"
import { clockAt, feeBps, LIVE_MS, marketBounds, MIN_STAKE_MICROS, priceSource, TAPE_MS, windowAccepts, type PriceSource } from "./config"
import { getDb } from "./db"
import { grantWaiting } from "./grantWait"
import { normalizeAccount, normalizeAddress } from "./money"
import { settleRound, type Resolution } from "./settle"

import type { ChainKey } from "../shared/chain"
import type {
  AccountResult,
  Band,
  Board,
  GrantPending,
  OpenBuyIn,
  PoolCard,
  SettlementEvent,
  Side,
  TrayRow,
  You,
} from "../shared/stream"

export type { Band, Board, OpenBuyIn, PoolCard, Side, TrayRow, You }
export type SettledEvent = SettlementEvent

export type Print = {
  price: string
  exchangeTs: number
  receivedAt: number
  source: PriceSource
}

type RoundRow = {
  id: number
  starts_at: number
  ends_at: number
  strike: string | null
  settle: string | null
  status: "open" | "settled" | "void"
  fee_micros: number
  winning_side: string | null
  resolution: string | null
  pool_up_micros: number
  pool_down_micros: number
  source: string | null
}

type BetRow = {
  round_id: number
  address: string
  side: Side
  stake_micros: number
  payout_micros: number | null
  created_at: number
}

class BuyInError extends Error {
  code?: typeof LATE_BUY_IN_CODE
  constructor(message: string, code?: typeof LATE_BUY_IN_CODE) {
    super(message)
    this.code = code
  }
}

const prints: Print[] = []
let lastReceivedAt = 0
let secondBucket: { sec: number; price: string; source: string; exchangeTs: number } | null = null
const cycleByChain = new Map<ChainKey, string>()
let handoff: Handoff | null = null
/** Bumped once when a handoff resumes. Each chain publishes that generation on its own. */
let handoffEpoch = 0
const handoffSeen = new Map<ChainKey, number>()
let ticker: Ticker = tickerFor(priceSource())

export function resetRuntime() {
  prints.length = 0
  lastReceivedAt = 0
  secondBucket = null
  cycleByChain.clear()
  handoff = null
  handoffEpoch = 0
  handoffSeen.clear()
  ticker = tickerFor(priceSource())
}

export function noteAlive(at: number) {
  lastReceivedAt = at
}

export function tickerNow(): Ticker {
  return ticker
}

export function handoffNow(): Handoff | null {
  return handoff
}

/** How long buy-ins stay shut after the next price source is known. */
export const HANDOFF_MS = 5_000

/** The moment the current clock window takes bets again. Open rounds are already voided. */
export function resumeAtFor(now: number): number {
  return now + HANDOFF_MS
}

function feedHeld(now: number): boolean {
  if (!handoff) return false
  if (handoff.resumeAt == null) return true
  return now < handoff.resumeAt
}

export function failFeed(from: PriceSource, to: PriceSource | null, now: number): SettledEvent[] {
  const settled = voidOpenRounds()
  if (handoff && handoff.from === from && handoff.to === to) return settled
  handoff = { from, to, resumeAt: to ? resumeAtFor(now) : null }
  if (to) ticker = tickerFor(to)
  return settled
}

export function adoptFeed(to: PriceSource, now: number) {
  if (!handoff || handoff.to) return
  handoff = { from: handoff.from, to, resumeAt: resumeAtFor(now) }
  ticker = tickerFor(to)
}

export function notePrint(print: Print) {
  if (!/^\d+(\.\d+)?$/.test(print.price)) return
  prints.push(print)
  lastReceivedAt = print.receivedAt
  const cutoff = print.exchangeTs - TAPE_MS
  while (prints.length > 20_000 || (prints[0] && prints[0].exchangeTs < cutoff)) prints.shift()
  recordSecond(print)
}

export function feedStatus(now: number): "live" | "stale" {
  if (!lastReceivedAt) return "stale"
  return now - lastReceivedAt <= LIVE_MS ? "live" : "stale"
}

/** The most tape points one reply may carry. */
export const TAPE_POINTS_MAX = 2_000

/** Keep the newest minute whole and uniformly sample the rest, so a long hold
 *  or a wide replay cannot balloon a snapshot or a tool reply. */
export function capTape<T extends { t: number }>(points: T[], max = TAPE_POINTS_MAX): T[] {
  if (points.length <= max) return points
  const newest = points[points.length - 1]!
  const recent: T[] = []
  const older: T[] = []
  for (const point of points) {
    if (point.t < newest.t - 60_000) older.push(point)
    else recent.push(point)
  }
  const out: T[] = []
  const sample = (from: T[], keep: number): void => {
    if (keep >= from.length) {
      out.push(...from)
      return
    }
    if (keep <= 0) return
    if (keep === 1) {
      out.push(from[from.length - 1]!)
      return
    }
    for (let index = 0; index < keep; index++) {
      out.push(from[Math.floor((index * (from.length - 1)) / (keep - 1))]!)
    }
  }
  const recentKeep = Math.min(recent.length, max)
  sample(older, max - recentKeep)
  sample(recent, recentKeep)
  return out
}

export function tapePoints(): { t: number; price: string }[] {
  return capTape(prints.map((print) => ({ t: print.exchangeTs, price: print.price })))
}

function priceAt(boundary: number, maxAge: number): Print | null {
  let best: Print | null = null
  for (const print of prints) {
    if (print.exchangeTs > boundary) continue
    if (boundary - print.exchangeTs > maxAge) continue
    if (!best || print.exchangeTs > best.exchangeTs) best = print
  }
  if (best) return best
  const row = getDb()
    .query(
      `SELECT price, source, exchange_ts FROM ticks
       WHERE second_ts <= ? AND second_ts >= ?
       ORDER BY second_ts DESC LIMIT 1`,
    )
    .get(Math.floor(boundary / 1000), Math.floor((boundary - maxAge) / 1000)) as
    | { price: string; source: PriceSource; exchange_ts: number }
    | null
  if (!row || boundary - row.exchange_ts > maxAge) return null
  return { price: row.price, exchangeTs: row.exchange_ts, receivedAt: row.exchange_ts, source: row.source }
}

export function tapeRange(from: number, to: number): { t: number; price: string }[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) return []
  const byTime = new Map<number, string>()
  const held = priceAt(from, TAPE_MS)
  if (held) byTime.set(held.exchangeTs, held.price)
  const rows = getDb()
    .query(
      `SELECT exchange_ts AS t, price FROM ticks
       WHERE second_ts >= ? AND second_ts <= ?
       ORDER BY second_ts ASC`,
    )
    .all(Math.floor(from / 1000), Math.floor(to / 1000)) as { t: number; price: string }[]
  for (const row of rows) {
    if (row.t >= from && row.t <= to) byTime.set(row.t, row.price)
  }
  for (const print of prints) {
    if (print.exchangeTs < from || print.exchangeTs > to) continue
    byTime.set(print.exchangeTs, print.price)
  }
  return capTape([...byTime.entries()].sort((left, right) => left[0] - right[0]).map(([t, price]) => ({ t, price })))
}

function recordSecond(print: Print) {
  const sec = Math.floor(print.exchangeTs / 1000)
  if (!secondBucket) {
    secondBucket = { sec, price: print.price, source: print.source, exchangeTs: print.exchangeTs }
    return
  }
  if (sec === secondBucket.sec) {
    secondBucket = { sec, price: print.price, source: print.source, exchangeTs: print.exchangeTs }
    return
  }
  const closed = secondBucket
  secondBucket = { sec, price: print.price, source: print.source, exchangeTs: print.exchangeTs }
  getDb()
    .query(
      `INSERT INTO ticks (second_ts, price, source, exchange_ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(second_ts) DO UPDATE SET price = excluded.price, source = excluded.source, exchange_ts = excluded.exchange_ts`,
    )
    .run(closed.sec, closed.price, closed.source, closed.exchangeTs)
}

function getRound(id: number): RoundRow | null {
  return (getDb().query("SELECT * FROM rounds WHERE chain_key = ? AND id = ?").get(activeChainKey(), id) as RoundRow | null) ?? null
}

function ensureRound(id: number): void {
  if (id < 0) return
  const bounds = marketBounds(id)
  getDb()
    .query(
      `INSERT INTO rounds (chain_key, id, starts_at, ends_at, status, fee_micros, pool_up_micros, pool_down_micros, source)
       VALUES (?, ?, ?, ?, 'open', 0, 0, 0, ?)
       ON CONFLICT(chain_key, id) DO NOTHING`,
    )
    .run(activeChainKey(), id, bounds.strikeAt, bounds.settlesAt, ticker.venue)
}

/** The window id is the clock slot, so a voided buy-in row has to be emptied and reopened. */
function reviveJoin(now: number): void {
  const id = clockAt(now).joinId
  if (id < 0) return
  const existing = getRound(id)
  if (!existing || existing.status === "open") return
  const tx = getDb().transaction(() => {
    const current = getRound(id)
    if (!current || current.status === "open") return
    getDb().query("DELETE FROM buy_ins WHERE chain_key = ? AND round_id = ?").run(activeChainKey(), id)
    getDb()
      .query(
        `UPDATE rounds
         SET strike = NULL, settle = NULL, status = 'open', fee_micros = 0, winning_side = NULL, resolution = NULL,
             pool_up_micros = 0, pool_down_micros = 0, source = ?
         WHERE chain_key = ? AND id = ? AND status != 'open'`,
      )
      .run(ticker.venue, activeChainKey(), id)
  })
  tx()
}

function poolSums(roundId: number) {
  const rows = getDb()
    .query(
      `SELECT side, COALESCE(SUM(stake_micros), 0) AS pool, COUNT(*) AS players
       FROM buy_ins WHERE chain_key = ? AND round_id = ? GROUP BY side`,
    )
    .all(activeChainKey(), roundId) as { side: Side; pool: number; players: number }[]
  let poolUpMicros = 0
  let poolDownMicros = 0
  let playersUp = 0
  let playersDown = 0
  for (const row of rows) {
    if (row.side === "up") {
      poolUpMicros = row.pool
      playersUp = row.players
    } else {
      poolDownMicros = row.pool
      playersDown = row.players
    }
  }
  return { poolUpMicros, poolDownMicros, playersUp, playersDown }
}

const HISTORY_TRAY = 10

function recentBuyIns(roundId: number, limit: number): { address: string; side: Side; stakeMicros: number; payoutMicros: number | null }[] {
  const rows = getDb()
    .query(
      `SELECT address, side, stake_micros, payout_micros
       FROM buy_ins
       WHERE chain_key = ? AND round_id = ?
       ORDER BY created_at DESC, address ASC
       LIMIT ?`,
    )
    .all(activeChainKey(), roundId, limit) as { address: string; side: Side; stake_micros: number; payout_micros: number | null }[]
  return rows.map((row) => ({
    address: row.address,
    side: row.side,
    stakeMicros: row.stake_micros,
    payoutMicros: row.payout_micros,
  }))
}

function toBand(row: RoundRow): Band {
  const bounds = marketBounds(row.id)
  const sums =
    row.status === "open"
      ? poolSums(row.id)
      : {
          poolUpMicros: row.pool_up_micros,
          poolDownMicros: row.pool_down_micros,
          playersUp: 0,
          playersDown: 0,
        }
  return {
    id: row.id,
    buyInOpen: bounds.buyInOpen,
    strikeAt: row.starts_at,
    settlesAt: row.ends_at,
    strike: row.strike,
    status: row.status,
    ...sums,
  }
}

function cardFor(id: number): PoolCard | null {
  if (id < 0) return null
  ensureRound(id)
  const row = getRound(id)
  if (!row) return null
  return { ...toBand(row), ...poolSums(id), tray: [] }
}

/** A voided ride stays in history. It is not the market on screen. */
function openLive(id: number): PoolCard | null {
  if (id < 0) return null
  ensureRound(id)
  const row = getRound(id)
  if (!row || row.status !== "open") return null
  return cardFor(id)
}

export function board(now = Date.now()): Board {
  const clock = clockAt(now)
  if (feedHeld(now)) {
    return {
      blockStart: clock.blockStart,
      blockEnd: clock.blockEnd,
      windowEndsAt: handoff?.resumeAt ?? clock.windowEndsAt,
      phase: "buy-in",
      join: null,
      live: null,
      bands: [],
    }
  }
  reviveJoin(now)
  if (clock.joinId >= 0) ensureRound(clock.joinId)
  if (clock.liveId >= 0) ensureRound(clock.liveId)
  const rows = getDb().query(BOARD_ROUNDS_SQL).all(activeChainKey(), now - TAPE_MS) as RoundRow[]
  // The tape window is small. Sorting here keeps the planner on rounds_ends
  // instead of walking the primary key to satisfy ORDER BY id.
  rows.sort((left, right) => left.id - right.id)
  return {
    blockStart: clock.blockStart,
    blockEnd: clock.blockEnd,
    windowEndsAt: clock.windowEndsAt,
    phase: "buy-in",
    join: clock.joinId < 0 ? null : cardFor(clock.joinId),
    live: openLive(clock.liveId),
    bands: rows.map(toBand),
  }
}

/** Exported for the plan regression tests so they exercise the shipped SQL verbatim. */
export const OPEN_BUY_INS_SQL = `SELECT r.id, b.side, b.stake_micros
  FROM rounds r
  JOIN buy_ins b
    ON b.chain_key = r.chain_key AND b.round_id = r.id AND b.address = ?
  WHERE r.chain_key = ? AND r.status = 'open'
  ORDER BY r.id`

export const BOARD_ROUNDS_SQL = "SELECT * FROM rounds WHERE chain_key = ? AND ends_at > ?"

export const DUE_ROUNDS_SQL = "SELECT * FROM rounds WHERE chain_key = ? AND status = 'open' AND ends_at <= ? ORDER BY id ASC"

export const STRIKE_ROUNDS_SQL = "SELECT * FROM rounds WHERE chain_key = ? AND status = 'open' AND strike IS NULL AND starts_at <= ?"

export const OPEN_ROUNDS_SQL = "SELECT * FROM rounds WHERE chain_key = ? AND status = 'open' ORDER BY id ASC"

function openBuyInsFor(address: string): OpenBuyIn[] {
  const rows = getDb().query(OPEN_BUY_INS_SQL).all(address, activeChainKey()) as {
    id: number
    side: Side
    stake_micros: number
  }[]
  return rows.map((row) => ({ roundId: row.id, side: row.side, stakeMicros: row.stake_micros }))
}

function grantPendingFrom(pendingAt: number | null, txHash: string | null, seen: number | null): GrantPending | null {
  if (pendingAt == null) return null
  const steps = typeof seen === "number" && Number.isFinite(seen) ? Math.max(0, Math.min(MINT_CONFIRMATIONS, Math.floor(seen))) : 0
  return { startedAt: pendingAt, txHash, seen: steps, confirmations: MINT_CONFIRMATIONS }
}

/** A crashed mint must not stick. A live waiter in this process keeps the slot. */
function releaseStaleGrant(address: string, now = Date.now()) {
  const row = getDb().query("SELECT grant_pending_at FROM users WHERE chain_key = ? AND address = ?").get(activeChainKey(), address) as
    | { grant_pending_at: number | null }
    | null
  const pendingAt = row?.grant_pending_at
  if (pendingAt == null) return
  if (now - pendingAt <= GRANT_FOLLOW_MS) return
  const key = normalizeAddress(address) ?? address
  if (grantWaiting(key)) return
  const wrote = getDb()
    .query("UPDATE users SET grant_pending_at = NULL, grant_tx = NULL, grant_seen = 0 WHERE chain_key = ? AND address = ? AND grant_pending_at = ?")
    .run(activeChainKey(), address, pendingAt)
  if (wrote.changes > 0) markAccountDirty(activeChainKey(), address)
}

export function youFor(address: string): You | null {
  releaseStaleGrant(address)
  const row = getDb()
    .query("SELECT balance_micros, grant_at, grant_pending_at, grant_tx, grant_seen FROM users WHERE chain_key = ? AND address = ?")
    .get(activeChainKey(), address) as
    | { balance_micros: number; grant_at: number | null; grant_pending_at: number | null; grant_tx: string | null; grant_seen: number | null }
    | null
  if (!row) return null
  return {
    address,
    balanceMicros: row.balance_micros,
    grantAt: row.grant_at,
    grantPending: grantPendingFrom(row.grant_pending_at, row.grant_tx, row.grant_seen),
    openBuyIns: openBuyInsFor(address),
  }
}

export function ensureUser(address: string): You {
  const existing = youFor(address)
  if (existing) return existing
  getDb()
    .query("INSERT INTO users (chain_key, address, balance_micros, created_at) VALUES (?, ?, 0, ?)")
    .run(activeChainKey(), address, Date.now())
  return { address, balanceMicros: 0, grantAt: null, grantPending: null, openBuyIns: [] }
}

export function credit(
  address: string,
  amountMicros: number,
): { ok: true; you: You } | { ok: false; error: string } {
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) return { ok: false, error: "Amount is invalid" }
  const tx = getDb().transaction(() => {
    ensureUser(address)
    getDb()
      .query("UPDATE users SET balance_micros = balance_micros + ? WHERE chain_key = ? AND address = ?")
      .run(amountMicros, activeChainKey(), address)
  })
  tx()
  markAccountDirty(activeChainKey(), address)
  return { ok: true, you: youFor(address)! }
}

export function withdraw(
  address: string,
  amountMicros: number,
): { ok: true; you: You } | { ok: false; error: string } {
  try {
    const tx = getDb().transaction(() => {
      const you = youFor(address)
      if (!you) throw new BuyInError("Unknown wallet")
      if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new BuyInError("Amount is invalid")
      if (amountMicros > you.balanceMicros) throw new BuyInError("Insufficient balance")
      getDb()
        .query("UPDATE users SET balance_micros = balance_micros - ? WHERE chain_key = ? AND address = ?")
        .run(amountMicros, activeChainKey(), address)
    })
    tx()
  } catch (error) {
    if (error instanceof BuyInError) return { ok: false, error: error.message }
    throw error
  }
  markAccountDirty(activeChainKey(), address)
  return { ok: true, you: youFor(address)! }
}

export function placeBuyIn(input: {
  address: string
  side: Side
  stakeMicros: number
  roundId: number
  now: number
  requestId?: string
}): { ok: true; you: You } | { ok: false; error: string; code?: typeof LATE_BUY_IN_CODE } {
  try {
    if (!feedHeld(input.now)) reviveJoin(input.now)
    const tx = getDb().transaction(() => {
      if (input.side !== "up" && input.side !== "down") throw new BuyInError("Side is invalid")
      if (!Number.isSafeInteger(input.stakeMicros) || input.stakeMicros < MIN_STAKE_MICROS) {
        throw new BuyInError("Minimum stake is 1 USDC")
      }
      if (input.requestId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
        throw new BuyInError("Request id is invalid")
      }
      if (input.requestId) {
        const previous = getDb()
          .query("SELECT round_id, side, stake_micros FROM buy_in_requests WHERE chain_key = ? AND address = ? AND id = ?")
          .get(activeChainKey(), input.address, input.requestId) as { round_id: number; side: Side; stake_micros: number } | null
        if (previous) {
          if (previous.round_id !== input.roundId || previous.side !== input.side || previous.stake_micros !== input.stakeMicros) {
            throw new BuyInError("Request id was already used")
          }
          return youFor(input.address)!
        }
      }

      if (handoff && feedHeld(input.now)) throw new BuyInError(handoffBanner(handoff.from, handoff.to))
      const id = namedRound(input.roundId, input.now)
      ensureRound(id)
      const round = getRound(id)
      if (!round || round.status !== "open") throw new BuyInError("Buy-in is closed")
      if (feedStatus(input.now) !== "live") throw new BuyInError("Price feed is delayed")

      releaseStaleGrant(input.address, input.now)
      const row = getDb()
        .query("SELECT balance_micros, grant_at, grant_pending_at, grant_tx, grant_seen FROM users WHERE chain_key = ? AND address = ?")
        .get(activeChainKey(), input.address) as
        | {
            balance_micros: number
            grant_at: number | null
            grant_pending_at: number | null
            grant_tx: string | null
            grant_seen: number | null
          }
        | null
      let balance = row?.balance_micros ?? 0
      const grantAt = row?.grant_at ?? null
      const grantPending = grantPendingFrom(row?.grant_pending_at ?? null, row?.grant_tx ?? null, row?.grant_seen ?? null)
      if (!row) {
        getDb()
          .query("INSERT INTO users (chain_key, address, balance_micros, created_at) VALUES (?, ?, 0, ?)")
          .run(activeChainKey(), input.address, input.now)
        balance = 0
      }

      const opens = openBuyInsFor(input.address)
      const onThis = opens.find((bet) => bet.roundId === id)
      for (const bet of opens) {
        if (bet.roundId === id) continue
        throw new BuyInError("Your last buy-in is still open")
      }
      if (onThis && onThis.side !== input.side) throw new BuyInError("You are already on the other side")
      if (input.stakeMicros > balance) throw new BuyInError("Insufficient balance")

      if (onThis) {
        getDb()
          .query("UPDATE buy_ins SET stake_micros = stake_micros + ? WHERE chain_key = ? AND round_id = ? AND address = ?")
          .run(input.stakeMicros, activeChainKey(), id, input.address)
      } else {
        getDb()
          .query(
            `INSERT INTO buy_ins (chain_key, round_id, address, side, stake_micros, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(activeChainKey(), id, input.address, input.side, input.stakeMicros, input.now)
      }
      getDb()
        .query("UPDATE users SET balance_micros = balance_micros - ? WHERE chain_key = ? AND address = ?")
        .run(input.stakeMicros, activeChainKey(), input.address)
      if (input.requestId) {
        getDb()
          .query("INSERT INTO buy_in_requests (chain_key, address, id, round_id, side, stake_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(activeChainKey(), input.address, input.requestId, id, input.side, input.stakeMicros, input.now)
      }

      const openBuyIns = opens.map((bet) =>
        bet.roundId === id ? { ...bet, stakeMicros: bet.stakeMicros + input.stakeMicros } : bet,
      )
      if (!onThis) {
        openBuyIns.push({ roundId: id, side: input.side, stakeMicros: input.stakeMicros })
        openBuyIns.sort((left, right) => left.roundId - right.roundId)
      }
      const you: You = {
        address: input.address,
        balanceMicros: balance - input.stakeMicros,
        grantAt,
        grantPending,
        openBuyIns,
      }
      return you
    })
    const you = tx()
    markAccountDirty(activeChainKey(), input.address)
    return { ok: true, you }
  } catch (error) {
    if (error instanceof BuyInError) {
      return error.code ? { ok: false, error: error.message, code: error.code } : { ok: false, error: error.message }
    }
    throw error
  }
}

/** The round a bet named, or a rejection when the receipt time is outside that window. */
function namedRound(roundId: number, now: number): number {
  if (!Number.isSafeInteger(roundId) || roundId < 0) throw new BuyInError("Market is invalid")
  if (windowAccepts(roundId, now)) return roundId
  const { strikeAt } = marketBounds(roundId)
  if (now >= strikeAt) throw new BuyInError(LATE_BUY_IN_ERROR, LATE_BUY_IN_CODE)
  throw new BuyInError("That market is not open")
}

function loadBets(roundId: number): BetRow[] {
  return getDb()
    .query("SELECT * FROM buy_ins WHERE chain_key = ? AND round_id = ? ORDER BY created_at ASC")
    .all(activeChainKey(), roundId) as BetRow[]
}

function voidOpenRounds(): SettledEvent[] {
  const open = getDb().query(OPEN_ROUNDS_SQL).all(activeChainKey()) as RoundRow[]
  return open.map((round) => closeRound(round, true))
}

function closeRound(round: RoundRow, forceVoid = false): SettledEvent {
  const life = round.ends_at - round.starts_at
  let strike = round.strike
  if (!strike) strike = priceAt(round.starts_at, life)?.price ?? null
  const settlePrint = forceVoid ? null : priceAt(round.ends_at, life)
  const bets = loadBets(round.id)
  const outcome = settleRound({
    bets: bets.map((bet) => ({
      address: bet.address,
      side: bet.side,
      stakeMicros: bet.stake_micros,
    })),
    strike,
    settle: settlePrint?.price ?? null,
    feeBps: feeBps(),
    stale: forceVoid || !strike || !settlePrint,
  })

  const tx = getDb().transaction(() => {
    const current = getRound(round.id)
    if (!current || current.status !== "open") return null
    const chain = activeChainKey()
    const setPayout = getDb().query(
      "UPDATE buy_ins SET payout_micros = ? WHERE chain_key = ? AND round_id = ? AND address = ?",
    )
    const addBalance = getDb().query(
      "UPDATE users SET balance_micros = balance_micros + ? WHERE chain_key = ? AND address = ? RETURNING balance_micros",
    )
    const balances = new Map<string, number>()
    for (const payout of outcome.payouts) {
      setPayout.run(payout.payoutMicros, chain, round.id, payout.address)
      const row = addBalance.get(payout.payoutMicros, chain, payout.address) as { balance_micros: number } | null
      if (row) balances.set(payout.address, row.balance_micros)
    }
    const status = outcome.resolution === "void" ? "void" : "settled"
    getDb()
      .query(
        `UPDATE rounds
         SET strike = COALESCE(strike, ?), settle = ?, status = ?, fee_micros = ?, winning_side = ?, resolution = ?,
             pool_up_micros = ?, pool_down_micros = ?
         WHERE chain_key = ? AND id = ? AND status = 'open'`,
      )
      .run(
        strike,
        outcome.settle,
        status,
        outcome.feeMicros,
        outcome.winningSide,
        outcome.resolution,
        outcome.poolUpMicros,
        outcome.poolDownMicros,
        chain,
        round.id,
      )
    return balances
  })
  const credited = tx()

  const payouts = outcome.payouts.map((payout) => ({
    address: payout.address,
    side: payout.side,
    stakeMicros: payout.stakeMicros,
    payoutMicros: payout.payoutMicros,
    ...(credited?.has(payout.address) ? { balanceMicros: credited.get(payout.address) } : {}),
  }))
  return {
    roundId: round.id,
    status: outcome.resolution === "void" ? "void" : "settled",
    resolution: outcome.resolution,
    winningSide: outcome.winningSide,
    strike,
    settle: outcome.settle,
    feeMicros: outcome.feeMicros,
    payouts,
    balances: [],
  }
}

/** The shared handoff clears on the first chain. Later chains in the same wake still publish that generation. */
function claimHandoffResume(now: number): boolean {
  const chain = activeChainKey()
  if (handoff?.resumeAt != null && now >= handoff.resumeAt) {
    handoff = null
    handoffEpoch += 1
  }
  const seen = handoffSeen.get(chain) ?? 0
  if (handoffEpoch <= seen) return false
  handoffSeen.set(chain, handoffEpoch)
  return true
}

export function advance(now: number): { settled: SettledEvent[]; broadcastRound: boolean; awaitingPrice: boolean } {
  const clock = clockAt(now)
  const settled: SettledEvent[] = []
  let broadcastRound = false

  if (claimHandoffResume(now)) broadcastRound = true
  if (feedHeld(now)) {
    const voided = voidOpenRounds()
    return { settled: voided, broadcastRound: broadcastRound || voided.length > 0, awaitingPrice: false }
  }

  reviveJoin(now)

  const due = getDb().query(DUE_ROUNDS_SQL).all(activeChainKey(), now) as RoundRow[]
  for (const round of due) settled.push(closeRound(round))
  if (settled.length) broadcastRound = true

  if (clock.joinId >= 0) ensureRound(clock.joinId)
  if (clock.liveId >= 0) ensureRound(clock.liveId)

  const locking = getDb().query(STRIKE_ROUNDS_SQL).all(activeChainKey(), now) as RoundRow[]
  let awaitingPrice = false
  for (const round of locking) {
    const print = priceAt(round.starts_at, round.ends_at - round.starts_at)
    if (!print) {
      awaitingPrice = true
      continue
    }
    const result = getDb()
      .query("UPDATE rounds SET strike = ? WHERE chain_key = ? AND id = ? AND strike IS NULL")
      .run(print.price, activeChainKey(), round.id)
    if (result.changes > 0) broadcastRound = true
  }

  const chain = activeChainKey()
  const key = `${clock.cycle}`
  if (cycleByChain.get(chain) !== key) {
    cycleByChain.set(chain, key)
    broadcastRound = true
  }
  return { settled, broadcastRound, awaitingPrice }
}

export type HistoryRow = {
  id: number
  startsAt: number
  endsAt: number
  strike: string | null
  settle: string | null
  status: string
  winningSide: string | null
  resolution: string | null
  poolUpMicros: number
  poolDownMicros: number
  source: string | null
  mySide?: Side
  myStakeMicros?: number
  myPayoutMicros?: number | null
}

function mapHistory(row: RoundRow & { my_side?: Side; my_stake?: number; my_payout?: number | null }): HistoryRow {
  const base: HistoryRow = {
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    strike: row.strike,
    settle: row.settle,
    status: row.status,
    winningSide: row.winning_side,
    resolution: row.resolution,
    poolUpMicros: row.pool_up_micros,
    poolDownMicros: row.pool_down_micros,
    source: row.source,
  }
  if (row.my_side) {
    base.mySide = row.my_side
    base.myStakeMicros = row.my_stake
    base.myPayoutMicros = row.my_payout
  }
  return base
}

export function listRounds(limit: number, address?: string | null, mine = false, after?: number | null): HistoryRow[] {
  const capped = Math.min(Math.max(limit, 1), 100)
  const forward = after != null && Number.isSafeInteger(after)
  if (mine && address) {
    const rows = forward
      ? (getDb()
          .query(
            `SELECT r.*, b.side AS my_side, b.stake_micros AS my_stake, b.payout_micros AS my_payout
             FROM rounds r
             JOIN buy_ins b ON b.chain_key = r.chain_key AND b.round_id = r.id AND b.address = ?
             WHERE r.chain_key = ? AND r.status != 'open' AND r.id > ?
             ORDER BY r.id ASC
             LIMIT ?`,
          )
          .all(address, activeChainKey(), after, capped) as (RoundRow & { my_side: Side; my_stake: number; my_payout: number | null })[])
      : (getDb()
          .query(
            `SELECT r.*, b.side AS my_side, b.stake_micros AS my_stake, b.payout_micros AS my_payout
             FROM rounds r
             JOIN buy_ins b ON b.chain_key = r.chain_key AND b.round_id = r.id AND b.address = ?
             WHERE r.chain_key = ? AND r.status != 'open'
             ORDER BY r.starts_at DESC, r.id DESC
             LIMIT ?`,
          )
          .all(address, activeChainKey(), capped) as (RoundRow & { my_side: Side; my_stake: number; my_payout: number | null })[])
    return rows.map(mapHistory)
  }
  const rows = forward
    ? (getDb()
        .query("SELECT * FROM rounds WHERE chain_key = ? AND status != 'open' AND id > ? ORDER BY id ASC LIMIT ?")
        .all(activeChainKey(), after, capped) as RoundRow[])
    : (getDb()
        .query("SELECT * FROM rounds WHERE chain_key = ? AND status != 'open' ORDER BY starts_at DESC, id DESC LIMIT ?")
        .all(activeChainKey(), capped) as RoundRow[])
  return rows.map(mapHistory)
}

export function accountResults(address: string, limit = 10): AccountResult[] {
  const capped = Math.min(Math.max(limit, 1), 50)
  const rows = getDb()
    .query(
      `SELECT r.id, r.status, r.resolution, r.winning_side, r.strike, r.settle, r.fee_micros,
              b.side, b.stake_micros, b.payout_micros
       FROM rounds r
       JOIN buy_ins b ON b.chain_key = r.chain_key AND b.round_id = r.id AND b.address = ?
       WHERE r.chain_key = ? AND r.status != 'open' AND b.payout_micros IS NOT NULL
       ORDER BY r.starts_at DESC, r.id DESC
       LIMIT ?`,
    )
    .all(address, activeChainKey(), capped) as {
    id: number
    status: "settled" | "void"
    resolution: "paid" | "refund" | "void"
    winning_side: Side | "push" | null
    strike: string | null
    settle: string | null
    fee_micros: number
    side: Side
    stake_micros: number
    payout_micros: number
  }[]
  return rows.map((row) => ({
    roundId: row.id,
    status: row.status,
    resolution: row.resolution,
    winningSide: row.winning_side,
    strike: row.strike,
    settle: row.settle,
    feeMicros: row.fee_micros,
    side: row.side,
    stakeMicros: row.stake_micros,
    payoutMicros: row.payout_micros,
  }))
}

function roundTape(round: RoundRow): { t: number; price: string }[] {
  const bounds = marketBounds(round.id)
  const from = bounds.buyInOpen
  const to = round.ends_at
  const byTime = new Map<number, string>()
  const rows = getDb()
    .query(
      `SELECT exchange_ts AS t, price FROM ticks
       WHERE second_ts >= ? AND second_ts <= ?
       ORDER BY second_ts ASC`,
    )
    .all(Math.floor(from / 1000), Math.floor(to / 1000)) as { t: number; price: string }[]
  for (const row of rows) byTime.set(row.t, row.price)
  for (const print of prints) {
    if (print.exchangeTs < from || print.exchangeTs > to) continue
    byTime.set(print.exchangeTs, print.price)
  }
  const life = Math.max(1_000, round.ends_at - round.starts_at)
  const windowSpan = Math.max(0, round.starts_at - bounds.buyInOpen)
  const held = priceAt(round.starts_at, Math.max(life, windowSpan + 1_000))
  if (held) byTime.set(held.exchangeTs, held.price)
  return capTape([...byTime.entries()].sort((left, right) => left[0] - right[0]).map(([t, price]) => ({ t, price })))
}

export function roundDetail(id: number) {
  const round = getRound(id)
  if (!round) return null
  return { round: mapHistory(round), buyIns: recentBuyIns(id, HISTORY_TRAY), tape: roundTape(round) }
}

export type BuyInOrder = { address: string; side: Side; stakeMicros: number }

export type BuyInRowResult = { address: string; ok: true; balanceMicros: number } | { address: string; ok: false; error: string }

export function placeBuyIns(input: {
  orders: BuyInOrder[]
  roundId: number
  now: number
}): { ok: true; results: BuyInRowResult[]; accepted: number } | { ok: false; error: string; code?: typeof LATE_BUY_IN_CODE } {
  if (handoff && feedHeld(input.now)) return { ok: false, error: handoffBanner(handoff.from, handoff.to) }
  if (input.orders.length > 200) return { ok: false, error: "Chunk is too large" }
  if (input.orders.length === 0) return { ok: true, results: [], accepted: 0 }
  let id: number
  try {
    id = namedRound(input.roundId, input.now)
  } catch (error) {
    if (error instanceof BuyInError) {
      return error.code ? { ok: false, error: error.message, code: error.code } : { ok: false, error: error.message }
    }
    throw error
  }
  if (feedStatus(input.now) !== "live") return { ok: false, error: "Price feed is delayed" }
  reviveJoin(input.now)
  ensureRound(id)
  const round = getRound(id)
  if (!round || round.status !== "open") return { ok: false, error: "Buy-in is closed" }

  const prepared = input.orders.map((order) => {
    const address = normalizeAccount(order.address)
    return { address, side: order.side, stakeMicros: order.stakeMicros }
  })
  const lookup = [...new Set(prepared.flatMap((order) => (order.address ? [order.address] : [])))]
  const run = getDb().transaction(() => {
    const users = new Map<string, { balance: number }>()
    const taken = new Set<string>()
    if (lookup.length > 0) {
      const marks = lookup.map(() => "?").join(",")
      const userRows = getDb()
        .query(`SELECT address, balance_micros FROM users WHERE chain_key = ? AND address IN (${marks})`)
        .all(activeChainKey(), ...lookup) as { address: string; balance_micros: number }[]
      for (const row of userRows) users.set(row.address, { balance: row.balance_micros })
      const betRows = getDb()
        .query(`SELECT address FROM buy_ins WHERE chain_key = ? AND round_id = ? AND address IN (${marks})`)
        .all(activeChainKey(), id, ...lookup) as { address: string }[]
      for (const row of betRows) taken.add(row.address)
    }
    const spent = new Map<string, number>()
    const results: BuyInRowResult[] = []
    const accepted: { address: string; side: Side; stakeMicros: number }[] = []
    for (const order of prepared) {
      if (!order.address) {
        results.push({ address: "", ok: false, error: "Address is invalid" })
        continue
      }
      const user = users.get(order.address)
      if (!user) {
        results.push({ address: order.address, ok: false, error: "Unknown wallet" })
        continue
      }
      if (order.side !== "up" && order.side !== "down") {
        results.push({ address: order.address, ok: false, error: "Side is invalid" })
        continue
      }
      if (!Number.isSafeInteger(order.stakeMicros) || order.stakeMicros < MIN_STAKE_MICROS) {
        results.push({ address: order.address, ok: false, error: "Minimum stake is 1 USDC" })
        continue
      }
      if (taken.has(order.address)) {
        results.push({ address: order.address, ok: false, error: "Already in this window" })
        continue
      }
      const left = user.balance - (spent.get(order.address) ?? 0)
      if (order.stakeMicros > left) {
        results.push({ address: order.address, ok: false, error: "Insufficient balance" })
        continue
      }
      taken.add(order.address)
      const spentAfter = (spent.get(order.address) ?? 0) + order.stakeMicros
      spent.set(order.address, spentAfter)
      accepted.push({ address: order.address, side: order.side, stakeMicros: order.stakeMicros })
      results.push({ address: order.address, ok: true, balanceMicros: user.balance - spentAfter })
    }
    const insert = getDb().query(
      `INSERT OR IGNORE INTO buy_ins (chain_key, round_id, address, side, stake_micros, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const debit = getDb().query(
      `UPDATE users SET balance_micros = balance_micros - ? WHERE chain_key = ? AND address = ? AND balance_micros >= ?`,
    )
    const undo = getDb().query(`DELETE FROM buy_ins WHERE chain_key = ? AND round_id = ? AND address = ?`)
    const missed = new Set<string>()
    for (const order of accepted) {
      const inserted = insert.run(activeChainKey(), id, order.address, order.side, order.stakeMicros, input.now)
      if (inserted.changes !== 1) {
        missed.add(order.address)
        continue
      }
      const updated = debit.run(order.stakeMicros, activeChainKey(), order.address, order.stakeMicros)
      if (updated.changes !== 1) {
        undo.run(activeChainKey(), id, order.address)
        missed.add(order.address)
      }
    }
    if (missed.size > 0) {
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!
        if (result.ok && missed.has(result.address)) results[i] = { address: result.address, ok: false, error: "Already in this window" }
      }
    }
    return { results, accepted: accepted.length - missed.size }
  })
  const done = run()
  const chain = activeChainKey()
  for (const row of done.results) {
    if (row.ok) markAccountDirty(chain, row.address)
  }
  return { ok: true, ...done }
}

export function tapeTail(now: number, tailMs: number): { t: number; price: string }[] {
  const from = now - tailMs
  const out: { t: number; price: string }[] = []
  for (const print of prints) {
    if (print.exchangeTs < from || print.exchangeTs > now) continue
    out.push({ t: print.exchangeTs, price: print.price })
  }
  return capTape(out)
}

export function openBook(now: number): {
  joinId: number
  windowEndsAt: number
  poolUpMicros: number
  poolDownMicros: number
  feed: "live" | "stale"
} {
  if (feedHeld(now)) {
    return {
      joinId: -1,
      windowEndsAt: handoff?.resumeAt ?? now,
      poolUpMicros: 0,
      poolDownMicros: 0,
      feed: feedStatus(now),
    }
  }
  reviveJoin(now)
  const clock = clockAt(now)
  let poolUpMicros = 0
  let poolDownMicros = 0
  if (clock.joinId >= 0) {
    ensureRound(clock.joinId)
    const sums = poolSums(clock.joinId)
    poolUpMicros = sums.poolUpMicros
    poolDownMicros = sums.poolDownMicros
  }
  return { joinId: clock.joinId, windowEndsAt: clock.windowEndsAt, poolUpMicros, poolDownMicros, feed: feedStatus(now) }
}

export type SettledBook = {
  id: number
  strike: string | null
  settle: string | null
  feeMicros: number
  poolUpMicros: number
  poolDownMicros: number
  winningSide: string | null
  resolution: string | null
}

export type RecentSettle = {
  id: number
  winningSide: Side
}

export function recentSettles(limit = 8): RecentSettle[] {
  const capped = Math.min(Math.max(limit, 1), 32)
  const rows = getDb()
    .query(
      `SELECT id, winning_side
       FROM rounds
       WHERE chain_key = ? AND status = 'settled' AND winning_side IN ('up', 'down')
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(activeChainKey(), capped) as { id: number; winning_side: Side }[]
  return rows.reverse().map((row) => ({ id: row.id, winningSide: row.winning_side }))
}

export function settledSince(sinceId: number, limit = 200): SettledBook[] {
  const capped = Math.min(Math.max(limit, 1), 200)
  const latest = getDb()
    .query("SELECT COALESCE(MAX(id), 0) AS max_id FROM rounds WHERE chain_key = ? AND status != 'open'")
    .get(activeChainKey()) as { max_id: number }
  const floorId = Math.max(0, latest.max_id - 2_000)
  const effectiveSince = Math.max(sinceId, floorId)
  const rows = getDb()
    .query(
      `SELECT id, strike, settle, fee_micros, pool_up_micros, pool_down_micros, winning_side, resolution
       FROM rounds WHERE chain_key = ? AND status != 'open' AND id > ? ORDER BY id ASC LIMIT ?`,
    )
    .all(activeChainKey(), effectiveSince, capped) as {
    id: number
    strike: string | null
    settle: string | null
    fee_micros: number
    pool_up_micros: number
    pool_down_micros: number
    winning_side: string | null
    resolution: string | null
  }[]
  return rows.map((row) => ({
    id: row.id,
    strike: row.strike,
    settle: row.settle,
    feeMicros: row.fee_micros,
    poolUpMicros: row.pool_up_micros,
    poolDownMicros: row.pool_down_micros,
    winningSide: row.winning_side,
    resolution: row.resolution,
  }))
}
