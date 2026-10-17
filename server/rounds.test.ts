import { beforeEach, expect, test } from "bun:test"
import { getDb, useDatabase } from "./db"
import { parseMicros } from "./money"
import { advance, board, credit, ensureUser, feedStatus, notePrint, placeBet, resetRuntime, roundDetail, withdraw, youFor, type Print } from "./rounds"

const USDC = 1_000_000
const T = 10_000_000_000_000
const WINDOW = 5_000
const MARKET = 5_000
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

beforeEach(() => {
  process.env.WINDOW_SECONDS = "5"
  process.env.MARKET_SECONDS = "5"
  process.env.BOT_COUNT = "0"
  process.env.FEE_BPS = "25"
  process.env.PRICE_SOURCE = "binance"
  resetRuntime()
  useDatabase(":memory:")
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
  expect(placeBet({ address: you, side: "up", stakeMicros: 50 * USDC, now: T + 100 }).ok).toBe(true)
  expect(placeBet({ address: them, side: "down", stakeMicros: 100 * USDC, now: T + 120 }).ok).toBe(true)

  notePrint(print("100.00", T + WINDOW - 20))
  advance(T + WINDOW + 5)
  const riding = placeBet({ address: you, side: "down", stakeMicros: USDC, now: T + WINDOW + 200 })
  expect(riding.ok).toBe(false)
  if (!riding.ok) expect(riding.error).toBe("Your last bet is still open")
  const struck = board(T + WINDOW + 5)
  expect(struck.phase).toBe("bets")
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
  expect(youFor(you)?.openBets).toEqual([])
})

test("same-side adds stack and the other side is rejected", () => {
  const you = address(3)
  grant(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  expect(placeBet({ address: you, side: "up", stakeMicros: 10 * USDC, now: T + 100 }).ok).toBe(true)
  expect(placeBet({ address: you, side: "down", stakeMicros: 5 * USDC, now: T + 150 }).ok).toBe(false)
  expect(placeBet({ address: you, side: "up", stakeMicros: 15 * USDC, now: T + 180 }).ok).toBe(true)
  expect(youFor(you)?.openBets).toEqual([{ roundId: MARKET_ID, side: "up", stakeMicros: 25 * USDC }])
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC - 25 * USDC)
})

test("the next window is open at the boundary, and a stale feed rejects the bet", () => {
  const you = address(4)
  ensureUser(you)
  const early = placeBet({ address: you, side: "up", stakeMicros: USDC, now: T + 100 })
  expect(early.ok).toBe(false)
  if (!early.ok) expect(early.error).toBe("Price feed is delayed")

  notePrint(print("100", T - 20))
  advance(T + 10)
  notePrint(print("100", T + WINDOW - 20))
  const nextAddress = address(9)
  grant(nextAddress)
  const next = placeBet({ address: nextAddress, side: "up", stakeMicros: USDC, now: T + WINDOW })
  expect(next.ok).toBe(true)
  if (next.ok) expect(next.you.openBets[0]?.roundId).toBe(MARKET_ID + 1)

  resetRuntime()
  notePrint(print("100", T - 6_000))
  expect(feedStatus(T + 100)).toBe("stale")
  const stale = placeBet({ address: you, side: "up", stakeMicros: USDC, now: T + 100 })
  expect(stale.ok).toBe(false)
  if (!stale.ok) expect(stale.error).toBe("Price feed is delayed")
})

test("a market voids only when its whole life has no print", () => {
  const you = address(5)
  grant(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  expect(placeBet({ address: you, side: "down", stakeMicros: 100 * USDC, now: T + 100 }).ok).toBe(true)
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
  placeBet({ address: you, side: "up", stakeMicros: 10 * USDC, now: T + 100 })
  placeBet({ address: them, side: "down", stakeMicros: 10 * USDC, now: T + 120 })
  notePrint(print("100.10", T + WINDOW))
  advance(T + WINDOW + 5)
  const closed = advance(T + WINDOW + MARKET + 5)
  const event = closed.settled.find((row) => row.roundId === MARKET_ID)
  expect(event?.winningSide).toBe("push")
  expect(event?.resolution).toBe("refund")
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC)
})

test("the tray keeps humans and summarizes bots", () => {
  const human = address(30)
  grant(human, 20 * USDC)
  notePrint(print("100", T - 20))
  advance(T + 10)
  expect(placeBet({ address: human, side: "up", stakeMicros: 2 * USDC, now: T + 100 }).ok).toBe(true)
  for (let index = 0; index < 6; index++) {
    const bot = address(40 + index)
    grant(bot, 10 * USDC)
    getDb().query("UPDATE users SET is_bot = 1 WHERE address = ?").run(bot)
    expect(placeBet({ address: bot, side: index % 2 === 0 ? "up" : "down", stakeMicros: USDC, now: T + 120 + index }).ok).toBe(true)
  }
  const card = board(T + 200).join
  expect(card?.tray.filter((row) => !row.bot)).toHaveLength(1)
  expect(card?.tray.filter((row) => row.bot).length).toBeLessThanOrEqual(4)
  expect((card?.botSummary.upCount ?? 0) + (card?.botSummary.downCount ?? 0)).toBe(6)
  expect(card?.playersUp).toBe(1 + 3)
  expect(card?.playersDown).toBe(3)
})

test("settlement credits a bot and leaves that payout off the public event", () => {
  const you = address(21)
  const bot = address(22)
  grant(you, 100 * USDC)
  grant(bot, 100 * USDC)
  getDb().query("UPDATE users SET is_bot = 1 WHERE address = ?").run(bot)
  notePrint(print("100.00", T - 20))
  advance(T + 10)
  expect(placeBet({ address: bot, side: "up", stakeMicros: 50 * USDC, now: T + 100 }).ok).toBe(true)
  expect(placeBet({ address: you, side: "down", stakeMicros: 50 * USDC, now: T + 110 }).ok).toBe(true)
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
  expect(placeBet({ address: bot, side: "up", stakeMicros: USDC, now: T + 100 }).ok).toBe(true)
  notePrint(print("100", T + WINDOW - 20))
  const next = placeBet({ address: bot, side: "down", stakeMicros: USDC, now: T + WINDOW + 10 })
  expect(next.ok).toBe(true)
  expect(board(T + WINDOW + 10).join?.tray.some((row) => row.bot && row.side === "down")).toBe(true)
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

test("insufficient balance does not open a bet", () => {
  const you = address(6)
  grant(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  const result = placeBet({ address: you, side: "up", stakeMicros: 10_001 * USDC, now: T + 100 })
  expect(result.ok).toBe(false)
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC)
  expect(youFor(you)?.openBets).toEqual([])
})
