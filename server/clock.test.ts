import { expect, test } from "bun:test"
import { nextMarketAt, planWake, rollMarketAt, runWake } from "./clock"
import { advance, notePrint, resetRuntime, type Print } from "./rounds"
import { useDatabase } from "./db"
import { marketPreferences } from "../shared/market"

const timing = { windowMs: 10_000, marketMs: 10_000, handoffResumeAt: null }

test("the next market instant is the upcoming window boundary", () => {
  expect(nextMarketAt(10_000, timing)).toBe(20_000)
  expect(nextMarketAt(10_001, timing)).toBe(20_000)
  expect(nextMarketAt(19_999, timing)).toBe(20_000)
})

test("a shorter ride settles between window boundaries", () => {
  expect(nextMarketAt(12_000, { windowMs: 10_000, marketMs: 3_000, handoffResumeAt: null })).toBe(13_000)
})

test("a handoff resume wakes before the next window", () => {
  expect(nextMarketAt(15_000, { ...timing, handoffResumeAt: 15_500 })).toBe(15_500)
  expect(nextMarketAt(15_000, { ...timing, handoffResumeAt: 25_000 })).toBe(20_000)
})

test("a due market instant is not moved to the next window", () => {
  expect(rollMarketAt(10_100, 10_000, 20_000)).toBe(10_000)
  expect(rollMarketAt(20_000, 20_000, 30_000)).toBe(20_000)
})

test("a future market instant stays, and a sooner handoff replaces it", () => {
  expect(rollMarketAt(15_000, 20_000, 20_000)).toBe(20_000)
  expect(rollMarketAt(15_000, 20_000, 15_500)).toBe(15_500)
  expect(rollMarketAt(15_000, 0, 20_000)).toBe(20_000)
})

test("a round due at T advances when the clock wakes at T", () => {
  const T = 20_000
  const plan = planWake({
    now: T,
    marketAt: T,
    lastTickAt: T - 40,
    tickMs: 100,
    hasPending: false,
    strikeKick: false,
  })
  expect(plan).toEqual({ advance: true, fanout: false })
  let advanced = 0
  runWake(plan, {
    advance: () => {
      advanced += 1
      return "closed"
    },
    fanout: () => {
      throw new Error("price-only work")
    },
  })
  expect(advanced).toBe(1)
})

test("a price-only wake does not advance and does no ledger work", () => {
  const plan = planWake({
    now: 15_100,
    marketAt: 20_000,
    lastTickAt: 15_000,
    tickMs: 100,
    hasPending: true,
    strikeKick: false,
  })
  expect(plan).toEqual({ advance: false, fanout: true })
  let sqlite = 0
  const result = runWake(plan, {
    advance: () => {
      sqlite += 1
    },
    fanout: () => {},
  })
  expect(result.advanced).toBeNull()
  expect(sqlite).toBe(0)
})

test("a price still inside its slot does not fan out", () => {
  const plan = planWake({
    now: 15_050,
    marketAt: 20_000,
    lastTickAt: 15_000,
    tickMs: 100,
    hasPending: true,
    strikeKick: false,
  })
  expect(plan).toEqual({ advance: false, fanout: false })
})

test("a print after the boundary kicks advance before the next window", () => {
  const early = planWake({
    now: 10_040,
    marketAt: 20_000,
    lastTickAt: 10_000,
    tickMs: 100,
    hasPending: true,
    strikeKick: true,
  })
  expect(early).toEqual({ advance: true, fanout: false })
  const due = planWake({
    now: 10_100,
    marketAt: 20_000,
    lastTickAt: 10_000,
    tickMs: 100,
    hasPending: true,
    strikeKick: true,
  })
  expect(due).toEqual({ advance: true, fanout: true })
})

test("a round due at T is closed when the clock wakes at T", () => {
  const previous = marketPreferences.chain
  marketPreferences.chain = "base-sepolia"
  try {
    process.env.WINDOW_SECONDS = "10"
    process.env.MARKET_SECONDS = "10"
    process.env.FEE_BPS = "0"
    process.env.PRICE_SOURCE = "binance"
    resetRuntime()
    useDatabase(":memory:")
    const open = 10_000
    const T = 10_000_000_000_000
    const due = T + open + open
    const print = (price: string, at: number): Print => ({ price, exchangeTs: at, receivedAt: at, source: "binance" })
    notePrint(print("100", T - 20))
    advance(T + 10)
    notePrint(print("100", T + open - 20))
    advance(T + open)
    notePrint(print("101", due - 1_000))
    const plan = planWake({
      now: due,
      marketAt: due,
      lastTickAt: due - 50,
      tickMs: 100,
      hasPending: true,
      strikeKick: false,
    })
    expect(plan.advance).toBe(true)
    const closed = runWake(plan, {
      advance: () => advance(due),
      fanout: () => {},
    })
    expect(closed.advanced?.settled.some((event) => event.roundId === T / open)).toBe(true)
    const later = planWake({
      now: due + 40,
      marketAt: nextMarketAt(due, timing),
      lastTickAt: due,
      tickMs: 100,
      hasPending: true,
      strikeKick: false,
    })
    expect(later).toEqual({ advance: false, fanout: false })
    let sqlite = 0
    runWake(later, {
      advance: () => {
        sqlite += 1
        return advance(due + 40)
      },
      fanout: () => {},
    })
    expect(sqlite).toBe(0)
  } finally {
    marketPreferences.chain = previous
  }
})
