import { expect, test } from "bun:test"
import { buyInSession, rideWindow } from "./buyInChart"
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

test("a ride walks across one view, then keeps now on the right", () => {
  const market = { strikeAt: 15_000, settlesAt: 25_000 }
  expect(rideWindow(market, 15_000, 5_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(rideWindow(market, 17_500, 5_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(rideWindow(market, 20_000, 5_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(rideWindow(market, 22_500, 5_000)).toEqual({ start: 17_500, end: 22_500 })
  expect(rideWindow(market, 24_999, 5_000)).toEqual({ start: 19_999, end: 24_999 })
  expect(rideWindow(market, 15_100, 0).start).toBe(15_000)
})

test("a ride shorter than the view stays the whole market", () => {
  const market = { strikeAt: 15_000, settlesAt: 25_000 }
  expect(rideWindow(market, 18_000, 20_000)).toEqual({ start: 15_000, end: 25_000 })
  expect(rideWindow(market, 24_000, 20_000)).toEqual({ start: 15_000, end: 25_000 })
})

