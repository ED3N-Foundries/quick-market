import { beforeEach, expect, test } from "bun:test"
import { LATE_BUY_IN_CODE, LATE_BUY_IN_ERROR } from "../shared/buyIn"
import { windowAccepts } from "./config"
import { getDb, useDatabase } from "./db"
import { parseMicros } from "./money"
import { handoffBanner } from "../shared/source"
import { marketPreferences } from "../shared/market"
import { adoptFeed, advance, board, credit, ensureUser, failFeed, feedStatus, handoffNow, listRounds, noteAlive, notePrint, placeBuyIn, placeBuyIns, recentSettles, resetRuntime, resumeAtFor, roundDetail, tapePoints, tickerNow, withdraw, youFor, type Print, type Side } from "./rounds"

const USDC = 1_000_000
const T = 10_000_000_000_000
const WINDOW = 10_000
const MARKET = 10_000
const MARKET_ID = T / WINDOW

function print(price: string, at: number): Print {
  return { price, exchangeTs: at, receivedAt: at, source: "binance" }
}

function address(n: number) {
  return `0x${n.toString(16).padStart(40, "0")}`
}

function grant(who: string, micros = 10_000 * USDC) {
  const result = credit(who, micros)
  if (!result.ok) throw new Error(result.error)
}

function bet(input: { address: string; side: Side; stakeMicros: number; now: number; roundId?: number }) {
  return placeBuyIn({ ...input, roundId: input.roundId ?? Math.floor(input.now / WINDOW) })
}

beforeEach(() => {
  marketPreferences.chain = "base-sepolia"
  process.env.WINDOW_SECONDS = "10"
  process.env.MARKET_SECONDS = "10"
  process.env.BOT_COUNT = "0"
  process.env.FEE_BPS = "25"
  process.env.PRICE_SOURCE = "binance"
  resetRuntime()
  useDatabase(":memory:")
})

test("history lists a later market ahead of an older round with a higher id", () => {
  const insert = getDb().query(
    `INSERT INTO rounds (chain_key, id, starts_at, ends_at, status, winning_side, resolution)
     VALUES ('base-sepolia', ?, ?, ?, 'settled', 'up', 'paid')`,
  )
  insert.run(500, 1_000, 2_000)
  insert.run(100, 5_000, 6_000)
  expect(listRounds(10).map((row) => row.id)).toEqual([100, 500])
  const who = address(3)
  const betRow = getDb().query(
    `INSERT INTO buy_ins (chain_key, id, round_id, address, side, stake_micros, created_at) VALUES ('base-sepolia', ?, ?, ?, 'up', 1, 0)`,
  )
  betRow.run("old", 500, who)
  betRow.run("new", 100, who)
  expect(listRounds(10, who, true).map((row) => row.id)).toEqual([100, 500])
  const index = getDb().query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("rounds_closed_starts")
  expect(index).toEqual({ name: "rounds_closed_starts" })
})

test("recent settles keep directional markets, oldest first", () => {
  const insert = getDb().query(
    `INSERT INTO rounds (chain_key, id, starts_at, ends_at, status, winning_side, resolution)
     VALUES ('base-sepolia', ?, 0, 1, ?, ?, ?)`,
  )
  insert.run(1, "settled", "up", "paid")
  insert.run(2, "void", "up", "void")
  insert.run(3, "settled", "push", "push")
  insert.run(4, "settled", "down", "paid")
  insert.run(5, "open", "up", null)
  insert.run(6, "settled", "up", "paid")
  expect(recentSettles()).toEqual([
    { id: 1, winningSide: "up" },
    { id: 4, winningSide: "down" },
    { id: 6, winningSide: "up" },
  ])
})

test("parseMicros keeps six decimal places", () => {
  expect(parseMicros("1.2")).toBe(1_200_000)
  expect(parseMicros("1.000001")).toBe(1_000_001)
  expect(parseMicros("1.0000001")).toBeNull()
  expect(parseMicros("10")).toBe(10_000_000)
})

test("a new user starts at zero and credit adds a deposit", () => {
  const you = address(7)
  expect(ensureUser(you).balanceMicros).toBe(0)
  const funded = credit(you, 10 * USDC)
  expect(funded.ok).toBe(true)
  if (funded.ok) expect(funded.you.balanceMicros).toBe(10 * USDC)
  expect(credit(you, 0).ok).toBe(false)
  expect(youFor(you)!.balanceMicros).toBe(10 * USDC)
})

test("strike locks when the window closes and a winner is paid once", () => {
  const you = address(1)
  const them = address(2)
  grant(you)
  grant(them)
  notePrint(print("100.00", T - 20))
  advance(T + 10)
  expect(bet({ address: you, side: "up", stakeMicros: 50 * USDC, now: T + 100 }).ok).toBe(true)
  expect(bet({ address: them, side: "down", stakeMicros: 100 * USDC, now: T + 120 }).ok).toBe(true)

  notePrint(print("100.00", T + WINDOW - 20))
  advance(T + WINDOW + 5)
  const riding = bet({ address: you, side: "down", stakeMicros: USDC, now: T + WINDOW + 200 })
  expect(riding.ok).toBe(false)
  if (!riding.ok) expect(riding.error).toBe("Your last buy-in is still open")
  const struck = board(T + WINDOW + 5)
  expect(struck.phase).toBe("buy-in")
  expect(struck.join?.id).toBe(MARKET_ID + 1)
  expect(struck.live?.strike).toBe("100.00")

  notePrint(print("101.00", T + WINDOW + MARKET - 4_000))
  const first = advance(T + WINDOW + MARKET + 5)
  const again = advance(T + WINDOW + MARKET + 50)
  expect(first.settled.find((event) => event.roundId === MARKET_ID)?.winningSide).toBe("up")
  expect(first.settled.find((event) => event.roundId === MARKET_ID)?.payouts.find((payout) => payout.address === you)?.payoutMicros).toBe(
    150_000_000,
  )
  expect(again.settled).toHaveLength(0)
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC - 50 * USDC + 150_000_000)
  expect(youFor(you)?.openBuyIns).toEqual([])
})

test("same-side adds stack and the other side is rejected", () => {
  const you = address(3)
  grant(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  expect(bet({ address: you, side: "up", stakeMicros: 10 * USDC, now: T + 100 }).ok).toBe(true)
  expect(bet({ address: you, side: "down", stakeMicros: 5 * USDC, now: T + 150 }).ok).toBe(false)
  expect(bet({ address: you, side: "up", stakeMicros: 15 * USDC, now: T + 180 }).ok).toBe(true)
  expect(youFor(you)?.openBuyIns).toEqual([{ roundId: MARKET_ID, side: "up", stakeMicros: 25 * USDC }])
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC - 25 * USDC)
})

test("the next window is open at the boundary, and a stale feed rejects the bet", () => {
  const you = address(4)
  ensureUser(you)
  const early = bet({ address: you, side: "up", stakeMicros: USDC, now: T + 100 })
  expect(early.ok).toBe(false)
  if (!early.ok) expect(early.error).toBe("Price feed is delayed")

  notePrint(print("100", T - 20))
  advance(T + 10)
  notePrint(print("100", T + WINDOW - 20))
  const nextAddress = address(9)
  grant(nextAddress)
  const next = bet({ address: nextAddress, side: "up", stakeMicros: USDC, now: T + WINDOW })
  expect(next.ok).toBe(true)
  if (next.ok) expect(next.you.openBuyIns[0]?.roundId).toBe(MARKET_ID + 1)

  resetRuntime()
  notePrint(print("100", T - 6_000))
  expect(feedStatus(T + 100)).toBe("stale")
  const stale = bet({ address: you, side: "up", stakeMicros: USDC, now: T + 100 })
  expect(stale.ok).toBe(false)
  if (!stale.ok) expect(stale.error).toBe("Price feed is delayed")
})

test("windowAccepts is the half-open betting window", () => {
  expect(windowAccepts(MARKET_ID, T)).toBe(true)
  expect(windowAccepts(MARKET_ID, T + WINDOW - 1)).toBe(true)
  expect(windowAccepts(MARKET_ID, T + WINDOW)).toBe(false)
  expect(windowAccepts(MARKET_ID + 1, T + WINDOW)).toBe(true)
  expect(windowAccepts(-1, T)).toBe(false)
  expect(windowAccepts(1.5, T)).toBe(false)
})

test("an accepted request replays after window close without another debit", () => {
  const who = address(16)
  grant(who)
  notePrint(print("100", T - 20))
  advance(T + 10)
  const requestId = crypto.randomUUID()
  const input = { address: who, side: "up" as const, stakeMicros: USDC, now: T + 100, roundId: MARKET_ID, requestId }
  const first = placeBuyIn(input)
  expect(first.ok).toBe(true)
  const replay = placeBuyIn({ ...input, now: T + WINDOW + 1 })
  expect(replay.ok).toBe(true)
  expect(youFor(who)?.balanceMicros).toBe(10_000 * USDC - USDC)
  expect(youFor(who)?.openBuyIns).toEqual([{ roundId: MARKET_ID, side: "up", stakeMicros: USDC }])
  const mismatch = placeBuyIn({ ...input, stakeMicros: 2 * USDC })
  expect(mismatch.ok).toBe(false)
  expect(youFor(who)?.balanceMicros).toBe(10_000 * USDC - USDC)
})

test("placeBuyIn returns the debited balance and the open stake", () => {
  const you = address(15)
  grant(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  const first = bet({ address: you, side: "up", stakeMicros: USDC, now: T + 100 })
  expect(first.ok).toBe(true)
  if (!first.ok) return
  const afterFirst = youFor(you)
  if (!afterFirst) throw new Error("missing wallet")
  expect(first.you).toEqual(afterFirst)
  const second = bet({ address: you, side: "up", stakeMicros: 2 * USDC, now: T + 200 })
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.you.balanceMicros).toBe(10_000 * USDC - 3 * USDC)
  expect(second.you.openBuyIns).toEqual([{ roundId: MARKET_ID, side: "up", stakeMicros: 3 * USDC }])
  const afterSecond = youFor(you)
  if (!afterSecond) throw new Error("missing wallet")
  expect(second.you).toEqual(afterSecond)
})

test("a late receipt stays off the next market", () => {
  const you = address(12)
  grant(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  const late = placeBuyIn({ address: you, side: "up", stakeMicros: USDC, now: T + WINDOW + 1, roundId: MARKET_ID })
  expect(late.ok).toBe(false)
  if (!late.ok) {
    expect(late.error).toBe(LATE_BUY_IN_ERROR)
    expect(late.code).toBe(LATE_BUY_IN_CODE)
  }
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC)
  expect(youFor(you)?.openBuyIns).toEqual([])
  const next = board(T + WINDOW + 1).join
  expect(next?.id).toBe(MARKET_ID + 1)
  expect(next?.poolUpMicros).toBe(0)
  expect(next?.tray).toEqual([])

  const future = placeBuyIn({ address: you, side: "up", stakeMicros: USDC, now: T + WINDOW - 1, roundId: MARKET_ID + 1 })
  expect(future.ok).toBe(false)
  if (!future.ok) expect(future.error).toBe("That market is not open")
  expect(youFor(you)?.openBuyIns).toEqual([])

  const invalid = placeBuyIn({ address: you, side: "up", stakeMicros: USDC, now: T + 100, roundId: -1 })
  expect(invalid.ok).toBe(false)
  if (!invalid.ok) expect(invalid.error).toBe("Market is invalid")
})

test("a stale bot chunk does not fill the next window", () => {
  const who = address(14)
  grant(who, 10 * USDC)
  getDb().query("UPDATE users SET is_bot = 1 WHERE address = ?").run(who)
  notePrint(print("100", T - 20))
  advance(T + 10)
  const late = placeBuyIns({
    now: T + WINDOW + 1,
    roundId: MARKET_ID,
    orders: [{ address: who, side: "up", stakeMicros: USDC }],
  })
  expect(late.ok).toBe(false)
  if (!late.ok) {
    expect(late.code).toBe(LATE_BUY_IN_CODE)
    expect(late.error).toBe(LATE_BUY_IN_ERROR)
  }
  expect(youFor(who)?.balanceMicros).toBe(10 * USDC)
  expect(board(T + WINDOW + 1).join?.poolUpMicros).toBe(0)

  notePrint(print("100", T + WINDOW - 20))
  const onTime = placeBuyIns({
    now: T + WINDOW,
    roundId: MARKET_ID + 1,
    orders: [{ address: who, side: "down", stakeMicros: USDC }],
  })
  expect(onTime.ok).toBe(true)
  if (onTime.ok) expect(onTime.accepted).toBe(1)
  expect(youFor(who)?.openBuyIns[0]?.roundId).toBe(MARKET_ID + 1)
})

test("a market voids only when its whole life has no print", () => {
  const you = address(5)
  grant(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  expect(bet({ address: you, side: "down", stakeMicros: 100 * USDC, now: T + 100 }).ok).toBe(true)
  withdraw(you, 9_900 * USDC)
  const denied = withdraw(you, USDC)
  expect(denied.ok).toBe(false)
  if (!denied.ok) expect(denied.error).toBe("Insufficient balance")

  const closed = advance(T + WINDOW + MARKET + 5)
  const event = closed.settled.find((row) => row.roundId === MARKET_ID)
  expect(event?.resolution).toBe("void")
  expect(youFor(you)?.balanceMicros).toBe(100 * USDC)
})

test("a print a few seconds before the close still settles, and a tie is a push", () => {
  const you = address(7)
  const them = address(8)
  grant(you)
  grant(them)
  notePrint(print("100", T - 20))
  advance(T + 10)
  bet({ address: you, side: "up", stakeMicros: 10 * USDC, now: T + 100 })
  bet({ address: them, side: "down", stakeMicros: 10 * USDC, now: T + 120 })
  notePrint(print("100.10", T + WINDOW))
  advance(T + WINDOW + 5)
  const closed = advance(T + WINDOW + MARKET + 5)
  const event = closed.settled.find((row) => row.roundId === MARKET_ID)
  expect(event?.winningSide).toBe("push")
  expect(event?.resolution).toBe("refund")
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC)
})

test("the live board leaves the tray empty and the detail lists the newest buy-ins", () => {
  const human = address(30)
  grant(human, 20 * USDC)
  notePrint(print("100", T - 20))
  advance(T + 10)
  expect(bet({ address: human, side: "up", stakeMicros: 2 * USDC, now: T + 100 }).ok).toBe(true)
  for (let index = 0; index < 6; index++) {
    const bot = address(40 + index)
    grant(bot, 10 * USDC)
    getDb().query("UPDATE users SET is_bot = 1 WHERE address = ?").run(bot)
    expect(bet({ address: bot, side: index % 2 === 0 ? "up" : "down", stakeMicros: USDC, now: T + 120 + index }).ok).toBe(true)
  }
  const card = board(T + 200).join
  const newest = [5, 4, 3, 2, 1].map((index) => address(40 + index))
  expect(card?.tray).toEqual([])
  expect(card?.playersUp).toBe(4)
  expect(card?.playersDown).toBe(3)
  const detail = roundDetail(MARKET_ID)
  expect(detail?.buyIns.map((row) => row.address)).toEqual([...newest, address(40), human])
  expect(detail?.buyIns.every((row) => !("bot" in row))).toBe(true)
  expect(detail && "botSummary" in detail).toBe(false)
  expect(detail?.round && "feeMicros" in detail.round).toBe(false)
})

test("settlement credits a bot and leaves that payout off the public event", () => {
  const you = address(21)
  const bot = address(22)
  grant(you, 100 * USDC)
  grant(bot, 100 * USDC)
  getDb().query("UPDATE users SET is_bot = 1 WHERE address = ?").run(bot)
  notePrint(print("100.00", T - 20))
  advance(T + 10)
  expect(bet({ address: bot, side: "up", stakeMicros: 50 * USDC, now: T + 100 }).ok).toBe(true)
  expect(bet({ address: you, side: "down", stakeMicros: 50 * USDC, now: T + 110 }).ok).toBe(true)
  notePrint(print("100.00", T + WINDOW - 20))
  advance(T + WINDOW + 5)
  notePrint(print("101.00", T + WINDOW + MARKET - 4_000))
  const closed = advance(T + WINDOW + MARKET + 5)
  const event = closed.settled.find((row) => row.roundId === MARKET_ID)
  expect(event?.winningSide).toBe("up")
  expect(event?.payouts.some((payout) => payout.address === bot)).toBe(false)
  expect(event?.balances.some((row) => row.address === bot)).toBe(false)
  expect(event?.payouts.find((payout) => payout.address === you)?.payoutMicros).toBe(0)
  expect(youFor(bot)!.balanceMicros).toBeGreaterThan(100 * USDC - 50 * USDC)
})

test("a bot can bet the next window while a bet is still open", () => {
  const bot = address(11)
  grant(bot, 10 * USDC)
  getDb().query("UPDATE users SET is_bot = 1 WHERE address = ?").run(bot)
  notePrint(print("100", T - 20))
  advance(T + 10)
  expect(bet({ address: bot, side: "up", stakeMicros: USDC, now: T + 100 }).ok).toBe(true)
  notePrint(print("100", T + WINDOW - 20))
  const next = bet({ address: bot, side: "down", stakeMicros: USDC, now: T + WINDOW + 10 })
  expect(next.ok).toBe(true)
  const join = board(T + WINDOW + 10).join
  expect(join?.tray).toEqual([])
  expect(join?.poolDownMicros).toBe(USDC)
  expect(join?.playersDown).toBe(1)
})

test("round detail includes the tape and the price held into the open", () => {
  notePrint(print("99.50", T - 50))
  advance(T + 10)
  notePrint(print("100.25", T + WINDOW + 2_000))
  notePrint(print("100.75", T + WINDOW + MARKET - 500))
  advance(T + WINDOW + MARKET + 5)
  const detail = roundDetail(MARKET_ID)
  expect(detail).not.toBeNull()
  const tape = detail?.tape ?? []
  expect(tape[0]).toEqual({ t: T - 50, price: "99.50" })
  expect(tape.map((point) => point.price)).toContain("100.25")
  expect(tape.map((point) => point.price)).toContain("100.75")
  expect(tape.every((point) => point.t <= T + WINDOW + MARKET)).toBe(true)
})

test("a feed break voids open markets, refunds the stake, and resumes the same window after 5s", () => {
  const you = address(21)
  const who = address(22)
  grant(you)
  grant(who, 10 * USDC)
  getDb().query("UPDATE users SET is_bot = 1 WHERE address = ?").run(who)
  notePrint(print("100.00", T - 20))
  advance(T + 10)
  expect(bet({ address: you, side: "up", stakeMicros: 50 * USDC, now: T + 100 }).ok).toBe(true)
  notePrint(print("100.00", T + WINDOW - 20))
  advance(T + WINDOW + 5)
  expect(board(T + WINDOW + 5).live?.strike).toBe("100.00")
  expect(bet({ address: who, side: "down", stakeMicros: 4 * USDC, now: T + WINDOW + 50 }).ok).toBe(true)
  notePrint(print("110.00", T + WINDOW + 1_000))

  const at = T + WINDOW + 2_000
  const settled = failFeed("binance", "bybit", at)
  const event = settled.find((row) => row.roundId === MARKET_ID)
  expect(event?.resolution).toBe("void")
  expect(event?.feeMicros).toBe(0)
  expect(event?.settle).toBeNull()
  expect(event?.payouts.find((payout) => payout.address === you)?.payoutMicros).toBe(50 * USDC)
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC)
  expect(youFor(you)?.openBuyIns).toEqual([])
  const row = getDb().query("SELECT status, fee_micros, resolution, settle, strike FROM rounds WHERE id = ?").get(MARKET_ID) as {
    status: string
    fee_micros: number
    resolution: string
    settle: string | null
    strike: string
  }
  expect(row).toEqual({ status: "void", fee_micros: 0, resolution: "void", settle: null, strike: "100.00" })
  expect(getDb().query("SELECT COUNT(*) AS n FROM rounds WHERE status = 'open'").get() as { n: number }).toEqual({ n: 0 })

  expect(tickerNow()).toEqual({ venue: "bybit", label: "Bybit BTCUSDT" })
  expect(handoffNow()).toEqual({ from: "binance", to: "bybit", resumeAt: resumeAtFor(at) })
  expect(board(at).join).toBeNull()
  expect(board(at).live).toBeNull()
  expect(board(at).windowEndsAt).toBe(resumeAtFor(at))

  const held = bet({ address: you, side: "down", stakeMicros: USDC, now: at + 100 })
  expect(held.ok).toBe(false)
  if (!held.ok) expect(held.error).toBe(handoffBanner("binance", "bybit"))
  const bots = placeBuyIns({
    now: at + 100,
    roundId: Math.floor((at + 100) / WINDOW),
    orders: [{ address: who, side: "up", stakeMicros: USDC }],
  })
  expect(bots.ok).toBe(false)
  if (!bots.ok) expect(bots.error).toBe(handoffBanner("binance", "bybit"))
  expect(youFor(who)?.balanceMicros).toBe(10 * USDC)

  const resume = resumeAtFor(at)
  expect(resume - at).toBe(5_000)
  expect(advance(resume - 1).settled).toHaveLength(0)
  expect(board(resume - 1).join).toBeNull()
  expect(handoffNow()?.to).toBe("bybit")
  notePrint(print("110.00", resume - 50))
  const opened = board(resume)
  expect(handoffNow()?.to).toBe("bybit")
  expect(opened.join?.id).toBe(Math.floor(resume / WINDOW))
  expect(opened.join?.status).toBe("open")
  expect(opened.join?.strike).toBeNull()
  expect(opened.join?.poolUpMicros).toBe(0)
  expect(opened.join?.poolDownMicros).toBe(0)
  expect(opened.live).toBeNull()
  expect(getDb().query("SELECT status, strike FROM rounds WHERE id = ?").get(MARKET_ID)).toEqual({ status: "void", strike: "100.00" })
  expect(getDb().query("SELECT source FROM rounds WHERE id = ?").get(opened.join?.id)).toEqual({ source: "bybit" })
  expect(bet({ address: you, side: "up", stakeMicros: USDC, now: resume + 10 }).ok).toBe(true)
  expect(board(resume + 10).join?.poolUpMicros).toBe(USDC)
  expect(board(resume + 10).join?.poolDownMicros).toBe(0)
  expect(youFor(who)?.balanceMicros).toBe(10 * USDC)
  advance(resume + 10)
  expect(handoffNow()).toBeNull()
})

test("a repeated break does not extend the hold, and a later venue does", () => {
  notePrint(print("100", T - 20))
  advance(T + 10)
  failFeed("binance", "bybit", T + 100)
  const first = resumeAtFor(T + 100)
  expect(first).toBe(T + 5_100)
  failFeed("binance", "bybit", T + 4_000)
  expect(handoffNow()?.resumeAt).toBe(first)
  failFeed("bybit", "okx", T + 6_000)
  expect(handoffNow()).toEqual({ from: "bybit", to: "okx", resumeAt: resumeAtFor(T + 6_000) })
  expect(tickerNow().label).toBe("OKX BTC-USDT")
})

test("betting stays closed until a standby is adopted", () => {
  const you = address(23)
  grant(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  expect(bet({ address: you, side: "up", stakeMicros: USDC, now: T + 100 }).ok).toBe(true)
  const settled = failFeed("binance", null, T + 200)
  expect(settled[0]?.resolution).toBe("void")
  expect(tickerNow().venue).toBe("binance")
  expect(handoffNow()).toEqual({ from: "binance", to: null, resumeAt: null })
  expect(board(T + 300).join).toBeNull()
  expect(board(T + 300).windowEndsAt).toBeGreaterThan(0)
  const waiting = bet({ address: you, side: "up", stakeMicros: USDC, now: T + 300 })
  expect(waiting.ok).toBe(false)
  if (!waiting.ok) expect(waiting.error).toBe(handoffBanner("binance", null))

  adoptFeed("okx", T + 400)
  expect(tickerNow()).toEqual({ venue: "okx", label: "OKX BTC-USDT" })
  const resume = resumeAtFor(T + 400)
  expect(handoffNow()).toEqual({ from: "binance", to: "okx", resumeAt: resume })
  adoptFeed("kraken", T + 3_000)
  expect(handoffNow()?.to).toBe("okx")
  expect(handoffNow()?.resumeAt).toBe(resume)
  expect(board(resume - 1).join).toBeNull()
  advance(resume)
  expect(handoffNow()).toBeNull()
  expect(board(resume).join?.id).toBe(Math.floor(resume / WINDOW))
  expect(board(resume).join?.poolUpMicros).toBe(0)
  expect(board(resume).live).toBeNull()
  expect(getDb().query("SELECT source FROM rounds WHERE id = ?").get(Math.floor(resume / WINDOW))).toEqual({ source: "okx" })
})

test("a quiet book still counts as a live feed", () => {
  notePrint(print("100", T - 6_000))
  expect(feedStatus(T)).toBe("stale")
  noteAlive(T)
  expect(feedStatus(T)).toBe("live")
  expect(tapePoints()).toEqual([{ t: T - 6_000, price: "100" }])
})

test("insufficient balance does not open a bet", () => {
  const you = address(6)
  grant(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  const result = bet({ address: you, side: "up", stakeMicros: 10_001 * USDC, now: T + 100 })
  expect(result.ok).toBe(false)
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC)
  expect(youFor(you)?.openBuyIns).toEqual([])
})


test("one database keeps chain balances, rounds, and history separate", () => {
  const baseAddress = address(77)
  const nearAddress = "ab".repeat(32)
  try {
    marketPreferences.chain = "base-sepolia"
    grant(baseAddress, 5 * USDC)
    getDb().query("INSERT INTO rounds (chain_key, id, starts_at, ends_at, status) VALUES ('base-sepolia', 9, 10, 20, 'settled')").run()
    getDb().query("INSERT INTO ticks (second_ts, price, source, exchange_ts) VALUES (1, '100', 'binance', 1000)").run()

    marketPreferences.chain = "near-testnet"
    expect(youFor(baseAddress)).toBeNull()
    grant(nearAddress, 7 * USDC)
    getDb().query("INSERT INTO rounds (chain_key, id, starts_at, ends_at, status) VALUES ('near-testnet', 9, 30, 40, 'settled')").run()
    expect(youFor(nearAddress)?.balanceMicros).toBe(7 * USDC)
    expect(listRounds(10).map((row) => row.startsAt)).toEqual([30])
    expect(roundDetail(9)?.round.startsAt).toBe(30)

    marketPreferences.chain = "base-sepolia"
    expect(youFor(baseAddress)?.balanceMicros).toBe(5 * USDC)
    expect(youFor(nearAddress)).toBeNull()
    expect(listRounds(10).map((row) => row.startsAt)).toEqual([10])
    expect(roundDetail(9)?.round.startsAt).toBe(10)
    expect(getDb().query("SELECT price FROM ticks WHERE second_ts = 1").get()).toEqual({ price: "100" })
  } finally {
    marketPreferences.chain = "base-sepolia"
  }
})
