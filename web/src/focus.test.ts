import { expect, test } from "bun:test"
import { focusPool, followWindow, heldMarket } from "./focus"
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

test("with no open bet the chart rolls into the next session when the window ends", () => {
  const current = board()
  expect(followWindow(current, [], 12_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(heldMarket(current, [], 12_000)).toBeNull()
  expect(focusPool(current, [], 12_000)?.id).toBe(2)

  const closed = board({ phase: "market", join: null })
  expect(followWindow(closed, [], 15_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(followWindow(closed, [], 16_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(followWindow(closed, [], 19_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(focusPool(closed, [], 16_000)).toBeNull()

  const next = board({
    blockStart: 20_000,
    blockEnd: 30_000,
    windowEndsAt: 25_000,
    phase: "bets",
    join: card(band(3, 20_000)),
    live: card(band(2, 10_000, "101")),
    bands: [],
  })
  expect(followWindow(next, [], 20_000)).toEqual({ start: 20_000, end: 25_000 })
  expect(followWindow(next, [], 24_000)).toEqual({ start: 20_000, end: 25_000 })
})

test("the no-bet view stays one window wide and always contains now", () => {
  const current = board()
  for (let now = 0; now <= 30_000; now += 250) {
    const frame = followWindow(current, [], now)
    expect(frame.end - frame.start).toBe(5_000)
    expect(now).toBeGreaterThanOrEqual(frame.start)
    expect(now).toBeLessThan(frame.end)
  }
})

test("an open bet freezes the chart on that market until it settles", () => {
  const current = board()
  const bet = [{ roundId: 1, side: "up" as const, stakeMicros: 1_000_000 }]
  expect(heldMarket(current, bet, 12_000)?.id).toBe(1)
  expect(followWindow(current, bet, 12_000)).toEqual({ start: 0, end: 15_000 })
  expect(focusPool(current, bet, 12_000)?.id).toBe(1)
  expect(followWindow(current, bet, 15_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(heldMarket(current, bet, 15_000)).toBeNull()
})

test("a bet waiting for its open does not borrow the other market's strike", () => {
  const current = board()
  const bet = [{ roundId: 2, side: "down" as const, stakeMicros: 1_000_000 }]
  expect(followWindow(current, bet, 11_000)).toEqual({ start: 10_000, end: 25_000 })
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
