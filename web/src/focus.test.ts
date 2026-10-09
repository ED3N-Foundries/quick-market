import { expect, test } from "bun:test"
import { chartMarket, focusPool, followWindow, heldMarket, heldStrike } from "./focus"
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

test("the betting window stays fixed while a previous market is still live", () => {
  const current = board()
  expect(followWindow(current, [], 12_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(chartMarket(current, [], 12_000)).toBeNull()
  expect(heldMarket(current, [], 12_000)).toBeNull()
  expect(focusPool(current, [], 12_000)?.id).toBe(2)
})

test("the market phase scrolls with now on the right edge", () => {
  const next = board({
    blockStart: 10_000,
    blockEnd: 20_000,
    windowEndsAt: 15_000,
    phase: "market",
    join: null,
    live: card(band(2, 10_000, "101")),
    bands: [],
  })
  expect(followWindow(next, [], 15_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(followWindow(next, [], 19_000)).toEqual({ start: 14_000, end: 19_000 })
  expect(chartMarket(next, [], 16_000)?.id).toBe(2)
  expect(focusPool(next, [], 16_000)).toBeNull()
})

test("a held market scrolls two viewports and the bet window does not", () => {
  const market = card(band(2, 10_000, "101"))
  const betting = board({
    blockStart: 20_000,
    blockEnd: 30_000,
    windowEndsAt: 25_000,
    phase: "bets",
    join: card(band(3, 20_000)),
    live: market,
    bands: [market],
  })
  const bet = [{ roundId: 2, side: "down" as const, stakeMicros: 1_000_000 }]
  expect(followWindow(betting, [], 21_000)).toEqual({ start: 20_000, end: 25_000 })
  expect(followWindow(betting, bet, 15_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(followWindow(betting, bet, 24_999)).toEqual({ start: 19_999, end: 24_999 })
  expect(24_999 - 15_000).toBe(5_000 * 2 - 1)
})

test("an unstruck board still shows the betting window", () => {
  const current = board({ live: null })
  expect(followWindow(current, [], 12_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(followWindow(current, [], 16_000)).toEqual({ start: 15_000, end: 20_000 })
})

test("the follow view stays one window wide and always contains now", () => {
  const current = board()
  for (let now = 0; now <= 30_000; now += 250) {
    const frame = followWindow(current, [], now)
    expect(frame.end - frame.start).toBe(5_000)
    expect(now).toBeGreaterThanOrEqual(frame.start)
    expect(now).toBeLessThanOrEqual(frame.end)
  }
})

test("an open bet keeps one view wide and still focuses that market", () => {
  const current = board()
  const bet = [{ roundId: 1, side: "up" as const, stakeMicros: 1_000_000 }]
  expect(heldMarket(current, bet, 12_000)?.id).toBe(1)
  expect(followWindow(current, bet, 12_000)).toEqual({ start: 7_000, end: 12_000 })
  expect(focusPool(current, bet, 12_000)?.id).toBe(1)
  expect(followWindow(current, bet, 15_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(heldMarket(current, bet, 15_000)).toBeNull()
})

test("a struck market scrolls one view wide until it settles", () => {
  const live = card(band(2, 10_000, "101"))
  const current = board({
    blockStart: 10_000,
    blockEnd: 20_000,
    windowEndsAt: 15_000,
    phase: "market",
    join: null,
    live,
  })
  const bet = [{ roundId: 2, side: "down" as const, stakeMicros: 1_000_000 }]
  expect(followWindow(current, [], 16_000)).toEqual({ start: 11_000, end: 16_000 })
  expect(followWindow(current, bet, 16_000)).toEqual(followWindow(current, [], 16_000))
  expect(followWindow(current, bet, 21_000)).toEqual({ start: 16_000, end: 21_000 })
  expect(heldMarket(current, bet, 21_000)?.id).toBe(2)
  expect(followWindow(current, bet, 21_000).end - followWindow(current, bet, 21_000).start).toBe(5_000)
})

test("a bet waiting for its open does not borrow the other market's strike", () => {
  const current = board()
  const bet = [{ roundId: 2, side: "down" as const, stakeMicros: 1_000_000 }]
  const held = heldMarket(current, bet, 11_000)
  expect(followWindow(current, bet, 11_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(focusPool(current, bet, 11_000)?.id).toBe(2)
  expect(heldStrike(held)).toBeNull()
  expect(chartMarket(current, bet, 11_000)).toBeNull()
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
  expect(followWindow(current, bets, 12_000)).toEqual({ start: 7_000, end: 12_000 })
  expect(followWindow(current, bets, 12_000).end - followWindow(current, bets, 12_000).start).toBe(5_000)
})
