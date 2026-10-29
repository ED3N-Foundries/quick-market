import { expect, test } from "bun:test"
import { buyInSession } from "./buyInChart"
import type { Board } from "./types"

function board(over: Partial<Board> = {}): Board {
  return {
    blockStart: 10_000,
    blockEnd: 20_000,
    windowEndsAt: 15_000,
    phase: "buy-in",
    join: null,
    live: null,
    bands: [],
    ...over,
  }
}

test("an open betting window is the session", () => {
  expect(buyInSession(board(), 10_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(buyInSession(board(), 14_999)).toEqual({ start: 10_000, end: 15_000 })
})

test("the moment the window ends, the next window starts", () => {
  const closed = board({ blockEnd: 15_000, windowEndsAt: 15_000, phase: "buy-in" })
  expect(buyInSession(closed, 15_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(buyInSession(closed, 19_999)).toEqual({ start: 15_000, end: 20_000 })
  expect(buyInSession(closed, 20_000)).toEqual({ start: 20_000, end: 25_000 })
})

test("a stale board still rolls forward instead of parking", () => {
  const stale = board()
  expect(buyInSession(stale, 20_000)).toEqual({ start: 20_000, end: 25_000 })
  expect(buyInSession(stale, 26_000)).toEqual({ start: 25_000, end: 30_000 })
  expect(buyInSession(stale, 9_000)).toEqual({ start: 5_000, end: 10_000 })
})

