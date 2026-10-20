import { expect, test } from "bun:test"
import { HOLD_MS, bookStep, type SideBook } from "./sideFigures"

const full: SideBook = {
  roundId: 1,
  upPool: 5_000_000,
  downPool: 5_000_000,
  upPlayers: 2,
  downPlayers: 1,
  upShare: "50%",
  downShare: "50%",
  upQuote: "$1 gets $1.95",
  downQuote: "$1 gets $1.95",
}

const emptyNext: SideBook = {
  roundId: 2,
  upPool: 0,
  downPool: 0,
  upPlayers: 0,
  downPlayers: 0,
  upShare: "0%",
  downShare: "0%",
  upQuote: "$1 back",
  downQuote: "$1 back",
}

const filledNext: SideBook = {
  ...emptyNext,
  upPool: 2_000_000,
  downPool: 1_000_000,
  upPlayers: 1,
  downPlayers: 1,
  upShare: "67%",
  downShare: "33%",
  upQuote: "$1 gets $1.40",
  downQuote: "$1 gets $2.80",
}

test("same round updates immediately", () => {
  const next = { ...full, upPool: 6_000_000, upShare: "55%" }
  expect(bookStep(full, next, 0, false)).toEqual({ book: next, fade: false })
})

test("a zero book on a new round holds the previous figures", () => {
  expect(bookStep(full, emptyNext, 0, false)).toEqual({ book: full, fade: false })
  expect(bookStep(full, emptyNext, HOLD_MS - 1, false)).toEqual({ book: full, fade: false })
})

test("a zero book shows after the hold and fades", () => {
  expect(bookStep(full, emptyNext, HOLD_MS, false)).toEqual({ book: emptyNext, fade: true })
})

test("a non-zero new round fades immediately and skips an empty frame", () => {
  expect(bookStep(full, filledNext, 0, false)).toEqual({ book: filledNext, fade: true })
})

test("reduced motion skips the fade and still holds a zero frame", () => {
  expect(bookStep(full, emptyNext, 0, true)).toEqual({ book: full, fade: false })
  expect(bookStep(full, filledNext, 0, true)).toEqual({ book: filledNext, fade: false })
  expect(bookStep(full, emptyNext, HOLD_MS, true)).toEqual({ book: emptyNext, fade: false })
})

test("the first book paints immediately", () => {
  expect(bookStep(null, emptyNext, 0, false)).toEqual({ book: emptyNext, fade: false })
})
