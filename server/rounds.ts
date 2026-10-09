import {
  botCount,
  clockAt,
  feeBps,
  FUND_MICROS,
  LIVE_MS,
  marketBounds,
  MIN_STAKE_MICROS,
  STARTING_BALANCE_MICROS,
  TAPE_MS,
} from "./config"
import { getDb } from "./db"
import { settleRound, type Resolution, type Side } from "./settle"

export type { Side }

export type Print = {
  price: string
  exchangeTs: number
  receivedAt: number
  source: "binance" | "coinbase"
}

export type TrayRow = {
  address: string
  side: Side
  stakeMicros: number
  bot: boolean
}

export type Band = {
  id: number
  betsOpen: number
  strikeAt: number
  settlesAt: number
  strike: string | null
  status: "open" | "settled" | "void"
  poolUpMicros: number
  poolDownMicros: number
  playersUp: number
  playersDown: number
}

export type PoolCard = Band & { tray: TrayRow[] }

export type Board = {
  blockStart: number
  blockEnd: number
  windowEndsAt: number
  phase: "bets" | "market"
  join: PoolCard | null
  live: PoolCard | null
  bands: Band[]
}

export type OpenBet = {
  roundId: number
  side: Side
  stakeMicros: number
}

export type You = {
  address: string
  balanceMicros: number
  openBets: OpenBet[]
}

export type SettledEvent = {
  roundId: number
  status: "settled" | "void"
  resolution: Resolution
  winningSide: Side | "push" | null
  strike: string | null
  settle: string | null
  feeMicros: number
  payouts: {
    address: string
    side: Side
    stakeMicros: number
    payoutMicros: number
  }[]
  balances: { address: string; balanceMicros: number }[]
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
}

type BetRow = {
  id: string
  round_id: number
  address: string
  side: Side
  stake_micros: number
  payout_micros: number | null
  created_at: number
  is_bot?: number
}

class BetError extends Error {}

const prints: Print[] = []
let lastReceivedAt = 0
let secondBucket: { sec: number; price: string; source: string; exchangeTs: number } | null = null
let cachedKey = ""
let seatedMarket = -1

const STAKE_LADDER = [5, 10, 25, 50]

export function resetRuntime() {
  prints.length = 0
  lastReceivedAt = 0
  secondBucket = null
  cachedKey = ""
  seatedMarket = -1
}

export function botAddress(index: number): string {
  return `0xb07${index.toString(16).padStart(37, "0")}`
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

export function tapePoints(): { t: number; price: string }[] {
  const map = (print: Print) => ({ t: print.exchangeTs, price: print.price })
  if (prints.length <= 4_000) return prints.map(map)
  const lastTs = prints[prints.length - 1]?.exchangeTs ?? 0
  const recentCut = lastTs - 60_000
  const older: Print[] = []
  const recent: Print[] = []
  for (const print of prints) {
    if (print.exchangeTs >= recentCut) recent.push(print)
    else older.push(print)
  }
  const out: { t: number; price: string }[] = []
  const step = Math.max(1, older.length / 800)
  for (let i = 0; i < older.length; i += step) {
    const print = older[Math.floor(i)]
    if (print) out.push(map(print))
  }
  for (const print of recent) out.push(map(print))
  return out
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
    | { price: string; source: "binance" | "coinbase"; exchange_ts: number }
    | null
  if (!row || boundary - row.exchange_ts > maxAge) return null
  return { price: row.price, exchangeTs: row.exchange_ts, receivedAt: row.exchange_ts, source: row.source }
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
  return (getDb().query("SELECT * FROM rounds WHERE id = ?").get(id) as RoundRow | null) ?? null
}

function ensureRound(id: number): void {
  if (id < 0) return
  const bounds = marketBounds(id)
  getDb()
    .query(
      `INSERT INTO rounds (id, starts_at, ends_at, status, fee_micros, pool_up_micros, pool_down_micros)
       VALUES (?, ?, ?, 'open', 0, 0, 0)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, bounds.strikeAt, bounds.settlesAt)
}

function poolSums(roundId: number) {
  const rows = getDb()
    .query(
      `SELECT side, COALESCE(SUM(stake_micros), 0) AS pool, COUNT(*) AS players
       FROM bets WHERE round_id = ? GROUP BY side`,
    )
    .all(roundId) as { side: Side; pool: number; players: number }[]
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

function trayFor(roundId: number): TrayRow[] {
  const rows = getDb()
    .query(
      `SELECT b.address, b.side, b.stake_micros, COALESCE(u.is_bot, 0) AS bot
       FROM bets b LEFT JOIN users u ON u.address = b.address
       WHERE b.round_id = ?
       ORDER BY b.created_at ASC, b.address ASC`,
    )
    .all(roundId) as { address: string; side: Side; stake_micros: number; bot: number }[]
  return rows.map((row) => ({
    address: row.address,
    side: row.side,
    stakeMicros: row.stake_micros,
    bot: row.bot === 1,
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
    betsOpen: bounds.betsOpen,
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
  return { ...toBand(row), ...poolSums(id), tray: trayFor(id) }
}

export function board(now = Date.now()): Board {
  const clock = clockAt(now)
  if (clock.joinId !== null) ensureRound(clock.joinId)
  if (clock.liveId >= 0) ensureRound(clock.liveId)
  const rows = getDb()
    .query("SELECT * FROM rounds WHERE ends_at > ? ORDER BY id ASC")
    .all(now - TAPE_MS) as RoundRow[]
  return {
    blockStart: clock.blockStart,
    blockEnd: clock.blockEnd,
    windowEndsAt: clock.windowEndsAt,
    phase: clock.windowOpen ? "bets" : "market",
    join: clock.joinId === null ? null : cardFor(clock.joinId),
    live: cardFor(clock.liveId),
    bands: rows.map(toBand),
  }
}

function openBetsFor(address: string): OpenBet[] {
  const rows = getDb()
    .query(
      `SELECT b.round_id, b.side, b.stake_micros
       FROM bets b JOIN rounds r ON r.id = b.round_id
       WHERE b.address = ? AND r.status = 'open'
       ORDER BY b.round_id ASC`,
    )
    .all(address) as { round_id: number; side: Side; stake_micros: number }[]
  return rows.map((row) => ({ roundId: row.round_id, side: row.side, stakeMicros: row.stake_micros }))
}

export function youFor(address: string): You | null {
  const row = getDb().query("SELECT balance_micros FROM users WHERE address = ?").get(address) as
    | { balance_micros: number }
    | null
  if (!row) return null
  return { address, balanceMicros: row.balance_micros, openBets: openBetsFor(address) }
}

export function ensureUser(address: string): You {
  const existing = youFor(address)
  if (existing) return existing
  getDb()
    .query("INSERT INTO users (address, balance_micros, created_at, is_bot) VALUES (?, ?, ?, 0)")
    .run(address, STARTING_BALANCE_MICROS, Date.now())
  return youFor(address)!
}

function ensureBot(address: string, now: number) {
  const row = getDb().query("SELECT balance_micros FROM users WHERE address = ?").get(address) as
    | { balance_micros: number }
    | null
  if (!row) {
    getDb()
      .query("INSERT INTO users (address, balance_micros, created_at, is_bot) VALUES (?, ?, ?, 1)")
      .run(address, STARTING_BALANCE_MICROS, now)
    return
  }
  if (row.balance_micros < 1_000 * MIN_STAKE_MICROS) {
    getDb()
      .query("UPDATE users SET balance_micros = ?, is_bot = 1 WHERE address = ?")
      .run(STARTING_BALANCE_MICROS, address)
  }
}

export function fund(address: string): You {
  const tx = getDb().transaction(() => {
    ensureUser(address)
    getDb()
      .query("UPDATE users SET balance_micros = balance_micros + ? WHERE address = ?")
      .run(FUND_MICROS, address)
  })
  tx()
  return youFor(address)!
}

export function withdraw(
  address: string,
  amountMicros: number,
): { ok: true; you: You } | { ok: false; error: string } {
  try {
    const tx = getDb().transaction(() => {
      const you = youFor(address)
      if (!you) throw new BetError("Unknown wallet")
      if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new BetError("Amount is invalid")
      if (amountMicros > you.balanceMicros) throw new BetError("Insufficient balance")
      getDb()
        .query("UPDATE users SET balance_micros = balance_micros - ? WHERE address = ?")
        .run(amountMicros, address)
    })
    tx()
  } catch (error) {
    if (error instanceof BetError) return { ok: false, error: error.message }
    throw error
  }
  return { ok: true, you: youFor(address)! }
}

export function placeBet(input: {
  address: string
  side: Side
  stakeMicros: number
  now: number
}): { ok: true; you: You; board: Board } | { ok: false; error: string } {
  try {
    const tx = getDb().transaction(() => {
      if (input.side !== "up" && input.side !== "down") throw new BetError("Side is invalid")
      if (!Number.isSafeInteger(input.stakeMicros) || input.stakeMicros < MIN_STAKE_MICROS) {
        throw new BetError("Minimum stake is 1 USDC")
      }

      const clock = clockAt(input.now)
      const id = clock.joinId
      if (id === null) throw new BetError("Betting is closed")
      ensureRound(id)
      const round = getRound(id)
      if (!round || round.status !== "open") throw new BetError("Betting is closed")

      ensureUser(input.address)
      const opens = openBetsFor(input.address)
      const onThis = opens.find((bet) => bet.roundId === id)
      for (const bet of opens) {
        if (bet.roundId !== id && bet.roundId !== clock.liveId) throw new BetError("Your last bet is still open")
      }
      if (onThis && onThis.side !== input.side) throw new BetError("You are already on the other side")
      if (feedStatus(input.now) !== "live") throw new BetError("Price feed is delayed")

      const user = youFor(input.address)!
      if (input.stakeMicros > user.balanceMicros) throw new BetError("Insufficient balance")

      if (onThis) {
        getDb()
          .query("UPDATE bets SET stake_micros = stake_micros + ? WHERE round_id = ? AND address = ?")
          .run(input.stakeMicros, id, input.address)
      } else {
        getDb()
          .query(
            `INSERT INTO bets (id, round_id, address, side, stake_micros, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(crypto.randomUUID(), id, input.address, input.side, input.stakeMicros, input.now)
      }
      getDb()
        .query("UPDATE users SET balance_micros = balance_micros - ? WHERE address = ?")
        .run(input.stakeMicros, input.address)
    })
    tx()
    return { ok: true, you: youFor(input.address)!, board: board(input.now) }
  } catch (error) {
    if (error instanceof BetError) return { ok: false, error: error.message }
    throw error
  }
}

function loadBets(roundId: number): BetRow[] {
  return getDb()
    .query(
      `SELECT b.*, COALESCE(u.is_bot, 0) AS is_bot
       FROM bets b LEFT JOIN users u ON u.address = b.address
       WHERE b.round_id = ? ORDER BY b.created_at ASC`,
    )
    .all(roundId) as BetRow[]
}

function closeRound(round: RoundRow): SettledEvent {
  const life = round.ends_at - round.starts_at
  let strike = round.strike
  if (!strike) strike = priceAt(round.starts_at, life)?.price ?? null
  const settlePrint = priceAt(round.ends_at, life)
  const bets = loadBets(round.id)
  const outcome = settleRound({
    bets: bets.map((bet) => ({
      id: bet.id,
      address: bet.address,
      side: bet.side,
      stakeMicros: bet.stake_micros,
    })),
    strike,
    settle: settlePrint?.price ?? null,
    feeBps: feeBps(),
    stale: !strike || !settlePrint,
  })

  const tx = getDb().transaction(() => {
    const current = getRound(round.id)
    if (!current || current.status !== "open") return
    for (const payout of outcome.payouts) {
      getDb().query("UPDATE bets SET payout_micros = ? WHERE id = ?").run(payout.payoutMicros, payout.id)
      if (payout.payoutMicros > 0) {
        getDb()
          .query("UPDATE users SET balance_micros = balance_micros + ? WHERE address = ?")
          .run(payout.payoutMicros, payout.address)
      }
    }
    const status = outcome.resolution === "void" ? "void" : "settled"
    getDb()
      .query(
        `UPDATE rounds
         SET strike = COALESCE(strike, ?), settle = ?, status = ?, fee_micros = ?, winning_side = ?, resolution = ?,
             pool_up_micros = ?, pool_down_micros = ?
         WHERE id = ? AND status = 'open'`,
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
        round.id,
      )
  })
  tx()

  const addresses = [...new Set(outcome.payouts.map((payout) => payout.address))]
  return {
    roundId: round.id,
    status: outcome.resolution === "void" ? "void" : "settled",
    resolution: outcome.resolution,
    winningSide: outcome.winningSide,
    strike,
    settle: outcome.settle,
    feeMicros: outcome.feeMicros,
    payouts: outcome.payouts.map((payout) => ({
      address: payout.address,
      side: payout.side,
      stakeMicros: payout.stakeMicros,
      payoutMicros: payout.payoutMicros,
    })),
    balances: addresses.map((address) => ({
      address,
      balanceMicros: youFor(address)?.balanceMicros ?? 0,
    })),
  }
}

function mix(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function seatBots(marketId: number, now: number): boolean {
  const requested = botCount()
  if (requested <= 0) return false
  if (seatedMarket === marketId) return false
  const seats = Math.max(requested, 2)
  const present = new Set(
    (
      getDb()
        .query(
          `SELECT b.address FROM bets b JOIN users u ON u.address = b.address
           WHERE b.round_id = ? AND u.is_bot = 1`,
        )
        .all(marketId) as { address: string }[]
    ).map((row) => row.address),
  )
  const rng = mix(marketId + 1)
  let seated = false
  let missing = 0
  for (let index = 0; index < seats; index++) {
    const address = botAddress(index)
    const side: Side = index === 0 ? "up" : index === 1 ? "down" : rng() < 0.5 ? "up" : "down"
    const stake = STAKE_LADDER[Math.floor(rng() * STAKE_LADDER.length)]! * MIN_STAKE_MICROS
    if (present.has(address)) continue
    missing += 1
    ensureBot(address, now)
    const result = placeBet({ address, side, stakeMicros: stake, now })
    if (result.ok) {
      seated = true
      missing -= 1
    }
  }
  if (missing === 0) seatedMarket = marketId
  return seated
}

export function advance(now: number): { settled: SettledEvent[]; broadcastRound: boolean } {
  const clock = clockAt(now)
  const settled: SettledEvent[] = []
  let broadcastRound = false

  const due = getDb()
    .query("SELECT * FROM rounds WHERE status = 'open' AND ends_at <= ? ORDER BY id ASC")
    .all(now) as RoundRow[]
  for (const round of due) settled.push(closeRound(round))
  if (settled.length) broadcastRound = true

  if (clock.joinId !== null) ensureRound(clock.joinId)
  if (clock.liveId >= 0) ensureRound(clock.liveId)

  const locking = getDb()
    .query("SELECT * FROM rounds WHERE status = 'open' AND strike IS NULL AND starts_at <= ?")
    .all(now) as RoundRow[]
  for (const round of locking) {
    const print = priceAt(round.starts_at, round.ends_at - round.starts_at)
    if (!print) continue
    const result = getDb()
      .query("UPDATE rounds SET strike = ? WHERE id = ? AND strike IS NULL")
      .run(print.price, round.id)
    if (result.changes > 0) broadcastRound = true
  }

  if (clock.joinId !== null && feedStatus(now) === "live" && seatBots(clock.joinId, now)) broadcastRound = true

  const key = `${clock.cycle}:${clock.windowOpen ? "bets" : "market"}`
  if (key !== cachedKey) {
    cachedKey = key
    broadcastRound = true
  }
  return { settled, broadcastRound }
}

export type HistoryRow = {
  id: number
  startsAt: number
  endsAt: number
  strike: string | null
  settle: string | null
  status: string
  feeMicros: number
  winningSide: string | null
  resolution: string | null
  poolUpMicros: number
  poolDownMicros: number
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
    feeMicros: row.fee_micros,
    winningSide: row.winning_side,
    resolution: row.resolution,
    poolUpMicros: row.pool_up_micros,
    poolDownMicros: row.pool_down_micros,
  }
  if (row.my_side) {
    base.mySide = row.my_side
    base.myStakeMicros = row.my_stake
    base.myPayoutMicros = row.my_payout
  }
  return base
}

export function listRounds(limit: number, address?: string | null, mine = false): HistoryRow[] {
  const capped = Math.min(Math.max(limit, 1), 100)
  if (mine && address) {
    const rows = getDb()
      .query(
        `SELECT r.*, b.side AS my_side, b.stake_micros AS my_stake, b.payout_micros AS my_payout
         FROM rounds r
         JOIN bets b ON b.round_id = r.id AND b.address = ?
         WHERE r.status != 'open'
         ORDER BY r.id DESC
         LIMIT ?`,
      )
      .all(address, capped) as (RoundRow & { my_side: Side; my_stake: number; my_payout: number | null })[]
    return rows.map(mapHistory)
  }
  const rows = getDb()
    .query("SELECT * FROM rounds WHERE status != 'open' ORDER BY id DESC LIMIT ?")
    .all(capped) as RoundRow[]
  return rows.map(mapHistory)
}

function roundTape(round: RoundRow): { t: number; price: string }[] {
  const bounds = marketBounds(round.id)
  const from = bounds.betsOpen
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
  const held = priceAt(round.starts_at, life)
  if (held) byTime.set(held.exchangeTs, held.price)
  return [...byTime.entries()].sort((left, right) => left[0] - right[0]).map(([t, price]) => ({ t, price }))
}

export function roundDetail(id: number) {
  const round = getRound(id)
  if (!round) return null
  const bets = loadBets(id).map((bet) => ({
    address: bet.address,
    side: bet.side,
    stakeMicros: bet.stake_micros,
    payoutMicros: bet.payout_micros,
    bot: bet.is_bot === 1,
  }))
  return { round: mapHistory(round), bets, tape: roundTape(round) }
}
