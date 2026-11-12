import { expect, test } from "bun:test"
import { chartMarket, clockFace, focusPool, followWindow, heldMarket, heldStrike, listedRoundIds } from "./focus"
import type { Band, Board, PoolCard } from "./types"

function band(id: number, buyInOpen: number, strike: string | null = null): Band {
  return {
    id,
    buyInOpen,
    strikeAt: buyInOpen + 5_000,
    settlesAt: buyInOpen + 15_000,
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
    phase: "buy-in",
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

test("an unbetted user stays on the betting window while a market is live", () => {
  const next = board({
    blockStart: 15_000,
    blockEnd: 20_000,
    windowEndsAt: 20_000,
    phase: "market",
    join: card(band(3, 15_000)),
    live: card(band(2, 10_000, "101")),
    bands: [],
  })
  expect(chartMarket(next, [], 16_000)).toBeNull()
  expect(followWindow(next, [], 16_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(followWindow(next, [], 19_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(focusPool(next, [], 16_000)?.id).toBe(3)
})

test("a held market walks across one view, then rides with now on the right", () => {
  const market = card(band(2, 10_000, "101"))
  const betting = board({
    blockStart: 20_000,
    blockEnd: 30_000,
    windowEndsAt: 25_000,
    phase: "buy-in",
    join: card(band(3, 20_000)),
    live: market,
    bands: [market],
  })
  const bet = [{ roundId: 2, side: "down" as const, stakeMicros: 1_000_000 }]
  expect(followWindow(betting, [], 21_000)).toEqual({ start: 20_000, end: 25_000 })
  expect(followWindow(betting, bet, 15_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(followWindow(betting, bet, 19_999)).toEqual({ start: 15_000, end: 20_000 })
  expect(followWindow(betting, bet, 22_500)).toEqual({ start: 17_500, end: 22_500 })
  expect(followWindow(betting, bet, 24_999)).toEqual({ start: 19_999, end: 24_999 })
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

test("an open bet shows its market once struck and still focuses it", () => {
  const current = board()
  const bet = [{ roundId: 1, side: "up" as const, stakeMicros: 1_000_000 }]
  expect(heldMarket(current, bet, 12_000)?.id).toBe(1)
  expect(followWindow(current, bet, 12_000)).toEqual({ start: 7_000, end: 12_000 })
  expect(focusPool(current, bet, 12_000)?.id).toBe(1)
  expect(followWindow(current, bet, 15_000)).toEqual({ start: 10_000, end: 15_000 })
  expect(followWindow(current, bet, 15_250)).toEqual({ start: 15_000, end: 20_000 })
  expect(heldMarket(current, bet, 15_000)).toBeNull()
})

test("a struck market stays on its own span until it settles", () => {
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
  expect(chartMarket(current, [], 16_000)).toBeNull()
  expect(followWindow(current, [], 16_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(followWindow(current, bet, 16_000)).toEqual({ start: 15_000, end: 20_000 })
  expect(followWindow(current, bet, 21_000)).toEqual({ start: 16_000, end: 21_000 })
  expect(heldMarket(current, bet, 21_000)?.id).toBe(2)
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
})

test("a delay-sized miss stays on the server join id", () => {
  const current = board()
  const id = current.join?.id ?? -1
  const early = followWindow(current, [], current.blockStart - 100)
  const late = followWindow(current, [], current.windowEndsAt + 100)
  expect(Math.floor(early.start / 5_000)).toBe(id)
  expect(Math.floor(late.start / 5_000)).toBe(id)
  expect(focusPool(current, [], current.windowEndsAt + 100)?.id).toBe(id)
  const rolled = followWindow(current, [], current.windowEndsAt + 1_000)
  expect(Math.floor(rolled.start / 5_000)).toBe(id + 1)
  expect(focusPool(current, [], current.windowEndsAt + 1_000)).toBeNull()
})

test("an expired join is not the bet id", () => {
  const current = board()
  expect(listedRoundIds(current, 15_000)).toEqual([])
  expect(focusPool(current, [], 20_000)).toBeNull()
})

test("a past resume does not hold the clock at zero", () => {
  const current = board()
  const face = clockFace(current, 12_000, null, 11_000)
  expect(face.kind).toBe("buy-in")
  expect(face.endsAt).toBe(15_000)
})

test("a published window end that is behind rolls to the window that contains now", () => {
  const current = board()
  const now = current.windowEndsAt + 1_000
  const face = clockFace(current, now, null, null)
  expect(face.kind).toBe("buy-in")
  expect(face.endsAt).toBe(20_000)
  expect(face.endsAt).toBeGreaterThan(now)
  const held = clockFace(current, current.windowEndsAt + 100, null, null)
  expect(held.endsAt).toBe(current.windowEndsAt)
})

test("a struck round that is still open counts to settlement", () => {
  const live = card(band(2, 10_000, "101"))
  const current = board({
    blockStart: 20_000,
    blockEnd: 30_000,
    windowEndsAt: 25_000,
    join: card(band(4, 20_000)),
    live,
    bands: [live],
  })
  const bet = [{ roundId: 2, side: "up" as const, stakeMicros: 1_000_000 }]
  const held = heldMarket(current, bet, 16_000)
  const face = clockFace(current, 16_000, held, null)
  expect(face.kind).toBe("settles")
  expect(face.endsAt).toBe(25_000)
  expect(face.spanMs).toBe(Number.POSITIVE_INFINITY)
  expect(listedRoundIds(current, 16_000)).toContain(2)
})

test("a stale feed does not count a buy-in, and a running position still counts down", () => {
  const current = board()
  expect(clockFace(current, 12_000, null, null, "stale").kind).toBe("waiting")
  const live = card(band(2, 10_000, "101"))
  const riding = board({
    blockStart: 20_000,
    blockEnd: 30_000,
    windowEndsAt: 25_000,
    join: card(band(4, 20_000)),
    live,
    bands: [live],
  })
  const held = heldMarket(riding, [{ roundId: 2, side: "up", stakeMicros: 1_000_000 }], 16_000)
  expect(clockFace(riding, 16_000, held, null, "stale").kind).toBe("settles")
})

