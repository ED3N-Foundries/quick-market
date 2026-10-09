import {
  betCutoffMs,
  feeBps,
  FUND_MICROS,
  MIN_STAKE_MICROS,
  roundBounds,
  roundIdAt,
  STARTING_BALANCE_MICROS,
  STALE_MS,
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
}

export type RoundSnapshot = {
  id: number
  startsAt: number
  endsAt: number
  strike: string | null
  status: "open" | "settled" | "void"
  poolUpMicros: number
  poolDownMicros: number
  playersUp: number
  playersDown: number
  tray: TrayRow[]
}

export type OpenBet = {
  roundId: number
  side: Side
  stakeMicros: number
}

export type You = {
  address: string
  balanceMicros: number
  openBet: OpenBet | null
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
}

class BetError extends Error {}

const prints: Print[] = []
let lastReceivedAt = 0
let secondBucket: { sec: number; price: string; source: string; exchangeTs: number } | null = null
let cachedRoundId = -1

export function resetRuntime() {
  prints.length = 0
  lastReceivedAt = 0
  secondBucket = null
  cachedRoundId = -1
}

export function notePrint(print: Print) {
  if (!/^\d+(\.\d+)?$/.test(print.price)) return
  prints.push(print)
  lastReceivedAt = print.receivedAt
  const cutoff = print.receivedAt - TAPE_MS
  while (prints.length > 8000 || (prints[0] && prints[0].receivedAt < cutoff)) prints.shift()
  recordSecond(print)
}

export function feedStatus(now: number): "live" | "stale" {
  if (!lastReceivedAt) return "stale"
  return now - lastReceivedAt <= STALE_MS ? "live" : "stale"
}

export function tapePoints(): { t: number; price: string }[] {
  if (prints.length <= 1500) return prints.map((print) => ({ t: print.exchangeTs, price: print.price }))
  const step = prints.length / 1500
  const out: { t: number; price: string }[] = []
  for (let i = 0; i < 1500; i++) {
    const print = prints[Math.floor(i * step)]
    if (print) out.push({ t: print.exchangeTs, price: print.price })
  }
  const last = prints[prints.length - 1]
  if (last) out.push({ t: last.exchangeTs, price: last.price })
  return out
}

function priceAt(boundary: number): Print | null {
  let best: Print | null = null
  for (const print of prints) {
    if (print.exchangeTs > boundary) continue
    if (boundary - print.exchangeTs > STALE_MS) continue
    if (!best || print.exchangeTs > best.exchangeTs) best = print
  }
  return best
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

function ensureRound(id: number): boolean {
  const bounds = roundBounds(id)
  const result = getDb()
    .query(
      `INSERT INTO rounds (id, starts_at, ends_at, status, fee_micros, pool_up_micros, pool_down_micros)
       VALUES (?, ?, ?, 'open', 0, 0, 0)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, bounds.startsAt, bounds.endsAt)
  return result.changes > 0
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

export function snapshot(now = Date.now()): RoundSnapshot {
  const id = roundIdAt(now)
  ensureRound(id)
  const round = getRound(id)
  const bounds = roundBounds(id)
  const sums = poolSums(id)
  const tray = (
    getDb()
      .query(
        `SELECT address, side, stake_micros FROM bets WHERE round_id = ? ORDER BY created_at ASC, address ASC`,
      )
      .all(id) as { address: string; side: Side; stake_micros: number }[]
  ).map((row) => ({ address: row.address, side: row.side, stakeMicros: row.stake_micros }))

  return {
    id,
    startsAt: round?.starts_at ?? bounds.startsAt,
    endsAt: round?.ends_at ?? bounds.endsAt,
    strike: round?.strike ?? null,
    status: round?.status ?? "open",
    ...sums,
    tray,
  }
}

function openBetFor(address: string): OpenBet | null {
  const row = getDb()
    .query(
      `SELECT b.round_id, b.side, b.stake_micros
       FROM bets b JOIN rounds r ON r.id = b.round_id
       WHERE b.address = ? AND r.status = 'open'
       LIMIT 1`,
    )
    .get(address) as { round_id: number; side: Side; stake_micros: number } | null
  if (!row) return null
  return { roundId: row.round_id, side: row.side, stakeMicros: row.stake_micros }
}

export function youFor(address: string): You | null {
  const row = getDb().query("SELECT balance_micros FROM users WHERE address = ?").get(address) as
    | { balance_micros: number }
    | null
  if (!row) return null
  return { address, balanceMicros: row.balance_micros, openBet: openBetFor(address) }
}

export function ensureUser(address: string): You {
  const existing = youFor(address)
  if (existing) return existing
  getDb()
    .query("INSERT INTO users (address, balance_micros, created_at) VALUES (?, ?, ?)")
    .run(address, STARTING_BALANCE_MICROS, Date.now())
  return youFor(address)!
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
}): { ok: true; you: You; round: RoundSnapshot } | { ok: false; error: string } {
  try {
    const tx = getDb().transaction(() => {
      if (input.side !== "up" && input.side !== "down") throw new BetError("Side is invalid")
      if (!Number.isSafeInteger(input.stakeMicros) || input.stakeMicros < MIN_STAKE_MICROS) {
        throw new BetError("Minimum stake is 1 USDC")
      }

      const id = roundIdAt(input.now)
      ensureRound(id)
      const round = getRound(id)
      if (!round || round.status !== "open") throw new BetError("This round is not open")

      ensureUser(input.address)
      const open = openBetFor(input.address)
      if (open && open.roundId !== id) throw new BetError("Your last bet is still open")
      if (open && open.side !== input.side) throw new BetError("You are already on the other side")
      if (!round.strike) throw new BetError("This round has no strike yet")
      if (input.now >= round.ends_at - betCutoffMs()) throw new BetError("Betting is closed for this round")
      if (feedStatus(input.now) !== "live") throw new BetError("Price feed is delayed")

      const user = youFor(input.address)!
      if (input.stakeMicros > user.balanceMicros) throw new BetError("Insufficient balance")

      if (open) {
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
    return { ok: true, you: youFor(input.address)!, round: snapshot(input.now) }
  } catch (error) {
    if (error instanceof BetError) return { ok: false, error: error.message }
    throw error
  }
}

function loadBets(roundId: number): BetRow[] {
  return getDb().query("SELECT * FROM bets WHERE round_id = ? ORDER BY created_at ASC").all(roundId) as BetRow[]
}

function closeRound(round: RoundRow): SettledEvent {
  const bets = loadBets(round.id)
  const print = priceAt(round.ends_at)
  const outcome = settleRound({
    bets: bets.map((bet) => ({
      id: bet.id,
      address: bet.address,
      side: bet.side,
      stakeMicros: bet.stake_micros,
    })),
    strike: round.strike,
    settle: print?.price ?? null,
    feeBps: feeBps(),
    stale: !round.strike || !print,
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
         SET settle = ?, status = ?, fee_micros = ?, winning_side = ?, resolution = ?,
             pool_up_micros = ?, pool_down_micros = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(
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
    strike: round.strike,
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

export function advance(now: number): { settled: SettledEvent[]; broadcastRound: boolean } {
  const currentId = roundIdAt(now)
  const settled: SettledEvent[] = []
  let broadcastRound = cachedRoundId !== currentId

  const due = getDb()
    .query("SELECT * FROM rounds WHERE status = 'open' AND id < ? ORDER BY id ASC")
    .all(currentId) as RoundRow[]
  for (const round of due) settled.push(closeRound(round))
  if (settled.length) broadcastRound = true

  ensureRound(currentId)
  if (cachedRoundId !== currentId) cachedRoundId = currentId

  const current = getRound(currentId)
  if (current && !current.strike) {
    const print = priceAt(current.starts_at)
    if (print) {
      const result = getDb()
        .query("UPDATE rounds SET strike = ? WHERE id = ? AND strike IS NULL")
        .run(print.price, currentId)
      if (result.changes > 0) broadcastRound = true
    }
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

export function roundDetail(id: number) {
  const round = getRound(id)
  if (!round) return null
  const bets = loadBets(id).map((bet) => ({
    address: bet.address,
    side: bet.side,
    stakeMicros: bet.stake_micros,
    payoutMicros: bet.payout_micros,
  }))
  return { round: mapHistory(round), bets }
}
