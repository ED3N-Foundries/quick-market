import { beforeEach, expect, test } from "bun:test"
import { useDatabase } from "./db"
import { parseMicros } from "./money"
import { advance, board, ensureUser, feedStatus, fund, notePrint, placeBet, resetRuntime, roundDetail, withdraw, youFor, type Print } from "./rounds"

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

test("fund adds the requested amount and rejects a non-positive one", () => {
  const you = address(7)
  ensureUser(you)
  const before = youFor(you)!.balanceMicros
  const funded = fund(you, 10 * USDC)
  expect(funded.ok).toBe(true)
  if (funded.ok) expect(funded.you.balanceMicros).toBe(before + 10 * USDC)
  expect(fund(you, 0).ok).toBe(false)
  expect(youFor(you)!.balanceMicros).toBe(before + 10 * USDC)
})

test("strike locks when the window closes and a winner is paid once", () => {
  const you = address(1)
  const them = address(2)
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
    149_625_000,
  )
  expect(again.settled).toHaveLength(0)
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC - 50 * USDC + 149_625_000)
  expect(youFor(you)?.openBets).toEqual([])
})

test("same-side adds stack and the other side is rejected", () => {
  const you = address(3)
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
  const next = placeBet({ address: address(9), side: "up", stakeMicros: USDC, now: T + WINDOW })
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

test("bots take both sides once per window", () => {
  process.env.BOT_COUNT = "4"
  notePrint(print("100", T - 20))
  advance(T + 10)
  const card = board(T + 50).join
  const bots = card?.tray.filter((row) => row.bot) ?? []
  expect(bots).toHaveLength(4)
  expect(bots.some((row) => row.side === "up")).toBe(true)
  expect(bots.some((row) => row.side === "down")).toBe(true)
  const pot = (card?.poolUpMicros ?? 0) + (card?.poolDownMicros ?? 0)
  advance(T + 80)
  const again = board(T + 90).join
  expect((again?.poolUpMicros ?? 0) + (again?.poolDownMicros ?? 0)).toBe(pot)

  notePrint(print("100", T + WINDOW - 20))
  advance(T + WINDOW + 10)
  const next = board(T + WINDOW + 50).join
  const nextBots = next?.tray.filter((row) => row.bot) ?? []
  expect(nextBots).toHaveLength(4)
  expect(nextBots.some((row) => row.side === "up")).toBe(true)
  expect(nextBots.some((row) => row.side === "down")).toBe(true)
})

test("bots fill the next window while the previous market is still resolving", () => {
  process.env.MARKET_SECONDS = "10"
  process.env.BOT_COUNT = "2"
  notePrint(print("100", T - 20))
  advance(T + 10)
  notePrint(print("100", T + WINDOW - 20))
  advance(T + WINDOW + 10)
  const riding = board(T + WINDOW + 50)
  expect(riding.live?.id).toBe(MARKET_ID)
  expect(riding.live?.status).toBe("open")
  const nextBots = riding.join?.tray.filter((row) => row.bot) ?? []
  expect(nextBots).toHaveLength(2)
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
  ensureUser(you)
  notePrint(print("100", T - 20))
  advance(T + 10)
  const result = placeBet({ address: you, side: "up", stakeMicros: 10_001 * USDC, now: T + 100 })
  expect(result.ok).toBe(false)
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC)
  expect(youFor(you)?.openBets).toEqual([])
})
