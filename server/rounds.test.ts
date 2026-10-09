import { beforeEach, expect, test } from "bun:test"
import { roundMs } from "./config"
import { useDatabase } from "./db"
import { parseMicros } from "./money"
import {
  advance,
  ensureUser,
  feedStatus,
  notePrint,
  placeBet,
  resetRuntime,
  withdraw,
  youFor,
  type Print,
} from "./rounds"

const USDC = 1_000_000
const START = 10_000_000_000_000

function print(price: string, at: number): Print {
  return { price, exchangeTs: at, receivedAt: at, source: "binance" }
}

function address(n: number) {
  return `0x${n.toString(16).padStart(40, "0")}`
}

beforeEach(() => {
  process.env.ROUND_SECONDS = "10"
  process.env.FEE_BPS = "25"
  process.env.BET_CUTOFF_MS = "1000"
  resetRuntime()
  useDatabase(":memory:")
})

test("parseMicros keeps six decimal places", () => {
  expect(parseMicros("1.2")).toBe(1_200_000)
  expect(parseMicros("1.000001")).toBe(1_000_001)
  expect(parseMicros("1.0000001")).toBeNull()
  expect(parseMicros("10")).toBe(10_000_000)
})

test("strike locks from the boundary print and a winner is paid once", () => {
  const you = address(1)
  const them = address(2)
  notePrint(print("100.00", START - 20))
  advance(START + 10)
  expect(placeBet({ address: you, side: "up", stakeMicros: 50 * USDC, now: START + 100 }).ok).toBe(true)
  expect(placeBet({ address: them, side: "down", stakeMicros: 100 * USDC, now: START + 120 }).ok).toBe(true)

  const blocked = placeBet({
    address: you,
    side: "up",
    stakeMicros: 1 * USDC,
    now: START + roundMs() + 200,
  })
  expect(blocked.ok).toBe(false)
  if (!blocked.ok) expect(blocked.error).toBe("Your last bet is still open")

  notePrint(print("101.00", START + roundMs() - 30))
  const first = advance(START + roundMs() + 5)
  const again = advance(START + roundMs() + 50)
  expect(first.settled).toHaveLength(1)
  expect(first.settled[0]?.winningSide).toBe("up")
  expect(first.settled[0]?.payouts.find((payout) => payout.address === you)?.payoutMicros).toBe(149_625_000)
  expect(again.settled).toHaveLength(0)
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC - 50 * USDC + 149_625_000)
  expect(youFor(you)?.openBet).toBeNull()

  const next = placeBet({ address: you, side: "down", stakeMicros: 1 * USDC, now: START + roundMs() + 80 })
  expect(next.ok).toBe(true)
})

test("same-side adds stack and the other side is rejected", () => {
  const you = address(3)
  notePrint(print("100", START - 20))
  advance(START + 10)
  expect(placeBet({ address: you, side: "up", stakeMicros: 10 * USDC, now: START + 100 }).ok).toBe(true)
  expect(placeBet({ address: you, side: "down", stakeMicros: 5 * USDC, now: START + 150 }).ok).toBe(false)
  expect(placeBet({ address: you, side: "up", stakeMicros: 15 * USDC, now: START + 180 }).ok).toBe(true)
  expect(youFor(you)?.openBet).toEqual({ roundId: START / roundMs(), side: "up", stakeMicros: 25 * USDC })
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC - 25 * USDC)
})

test("cutoff, stale feed, and a missing strike reject the bet", () => {
  const you = address(4)
  ensureUser(you)
  const early = placeBet({ address: you, side: "up", stakeMicros: USDC, now: START + 100 })
  expect(early.ok).toBe(false)
  if (!early.ok) expect(early.error).toBe("This round has no strike yet")

  notePrint(print("100", START - 20))
  advance(START + 10)
  const closed = placeBet({ address: you, side: "up", stakeMicros: USDC, now: START + roundMs() - 1000 })
  expect(closed.ok).toBe(false)
  if (!closed.ok) expect(closed.error).toBe("Betting is closed for this round")

  const staleNow = START + 3_000
  expect(feedStatus(staleNow)).toBe("stale")
  const stale = placeBet({ address: you, side: "up", stakeMicros: USDC, now: staleNow })
  expect(stale.ok).toBe(false)
  if (!stale.ok) expect(stale.error).toBe("Price feed is delayed")
})

test("a stale settle refunds the stake and withdraw cannot take it while it is in play", () => {
  const you = address(5)
  notePrint(print("100", START - 20))
  advance(START + 10)
  expect(placeBet({ address: you, side: "down", stakeMicros: 100 * USDC, now: START + 100 }).ok).toBe(true)
  expect(youFor(you)?.balanceMicros).toBe(9_900 * USDC)
  withdraw(you, 9_900 * USDC)
  expect(youFor(you)?.balanceMicros).toBe(0)
  const denied = withdraw(you, USDC)
  expect(denied.ok).toBe(false)
  if (!denied.ok) expect(denied.error).toBe("Insufficient balance")

  const closed = advance(START + roundMs() + 5)
  expect(closed.settled[0]?.resolution).toBe("void")
  expect(youFor(you)?.balanceMicros).toBe(100 * USDC)
})

test("insufficient balance does not open a bet", () => {
  const you = address(6)
  ensureUser(you)
  notePrint(print("100", START - 20))
  advance(START + 10)
  const result = placeBet({ address: you, side: "up", stakeMicros: 10_001 * USDC, now: START + 100 })
  expect(result.ok).toBe(false)
  expect(youFor(you)?.balanceMicros).toBe(10_000 * USDC)
  expect(youFor(you)?.openBet).toBeNull()
})
