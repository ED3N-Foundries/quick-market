import { expect, test } from "bun:test"
import { chartBaseline, focusPool, followWindow, heldMarket } from "./focus"
import type { Band, Board, PoolCard } from "./types"

function band(id: number, betsOpen: number, strike: string | null = null): Band {
  return {
    id,
    betsOpen,
    strikeAt: betsOpen + 5_000,
    settlesAt: betsOpen + 15_000,
    strike,
    status: "open",
    poolUpMicros: id * 10,
    poolDownMicros: id,
    playersUp: 1,
    playersDown: 1,
  }
}

function card(row: Band): PoolCard {
  return { ...row, tray: [] }
}

function board(over: Partial<Board> = {}): Board {
  const live = card(band(1, 0, "100"))
  const join = card(band(2, 10_000))
  return {
    blockStart: 10_000,
    blockEnd: 20_000,
    windowEndsAt: 15_000,
    phase: "bets",
    join,
    live,
    bands: [live, join],
    ...over,
  }
}

test("with no open bet the chart follows the clock block", () => {
  const current = board()
  expect(followWindow(current, [], 12_000)).toEqual({ start: 10_000, end: 20_000 })
  expect(heldMarket(current, [], 12_000)).toBeNull()
  expect(focusPool(current, [], 12_000)?.id).toBe(2)
  expect(focusPool(board({ phase: "market", join: null }), [], 16_000)?.id).toBe(1)
})

test("an open bet freezes the chart on that market until it settles", () => {
  const current = board()
  const bet = [{ roundId: 1, side: "up" as const, stakeMicros: 1_000_000 }]
  expect(heldMarket(current, bet, 12_000)?.id).toBe(1)
  expect(followWindow(current, bet, 12_000)).toEqual({ start: 0, end: 15_000 })
  expect(focusPool(current, bet, 12_000)?.id).toBe(1)
  expect(chartBaseline(current, bet, 12_000)).toBe(100)
  expect(followWindow(current, bet, 15_000)).toEqual({ start: 10_000, end: 20_000 })
  expect(heldMarket(current, bet, 15_000)).toBeNull()
})

test("a bet waiting for its open does not borrow the other market's strike", () => {
  const current = board()
  const bet = [{ roundId: 2, side: "down" as const, stakeMicros: 1_000_000 }]
  expect(followWindow(current, bet, 11_000)).toEqual({ start: 10_000, end: 25_000 })
  expect(chartBaseline(current, bet, 11_000)).toBeNull()
  expect(focusPool(current, bet, 11_000)?.id).toBe(2)
})

test("two open bets stay on the one that settles first", () => {
  const older = band(1, 0, "100")
  const newer = band(2, 10_000, "101")
  const current = board({
    live: card(older),
    join: card(newer),
    bands: [],
  })
  const bets = [
    { roundId: 2, side: "down" as const, stakeMicros: 1 },
    { roundId: 1, side: "up" as const, stakeMicros: 1 },
  ]
  expect(heldMarket(current, bets, 12_000)?.id).toBe(1)
  expect(followWindow(current, bets, 12_000)).toEqual({ start: 0, end: 15_000 })
})

test("with nothing held the baseline falls back to the latest strike", () => {
  const current = board({ live: null, join: null, bands: [band(4, 30_000, "88")] })
  expect(chartBaseline(current, [], 1)).toBe(88)
  expect(chartBaseline(null, [], 1)).toBeNull()
})
