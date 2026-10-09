import { expect, test } from "bun:test"
import { betSession, marketScroll } from "./betChart"
import type { Board } from "./types"

function board(over: Partial<Board> = {}): Board {
  return {
    blockStart: 10_000,
    blockEnd: 20_000,
    windowEndsAt: 15_000,
    phase: "bets",
    join: null,
    live: null,
    bands: [],
    ...over,
  }
}

test("an open betting window is the session", () => {
  expect(betSession(board(), 10_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(betSession(board(), 14_999)).toEqual({ start: 10_000, end: 15_000 })
})

test("the moment the window ends, the next session starts", () => {
  const closed = board({ phase: "market" })
  expect(betSession(closed, 15_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(betSession(closed, 19_999)).toEqual({ start: 15_000, end: 20_000 })
})

test("a stale board still rolls forward instead of parking", () => {
  const stale = board()
  expect(betSession(stale, 20_000)).toEqual({ start: 20_000, end: 25_000 })
  expect(betSession(stale, 26_000)).toEqual({ start: 25_000, end: 30_000 })
  expect(betSession(stale, 9_000)).toEqual({ start: 5_000, end: 10_000 })
})

test("the market camera keeps now on the right edge", () => {
  expect(marketScroll(15_000, 5_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(marketScroll(19_250, 5_000)).toEqual({ start: 14_250, end: 19_250 })
})

test("two viewports of scroll cover the default settle wait", () => {
  const viewMs = 5_000
  const strikeAt = 5_000
  const settlesAt = strikeAt + viewMs * 2
  expect(marketScroll(settlesAt, viewMs).end - marketScroll(strikeAt, viewMs).end).toBe(viewMs * 2)
})
