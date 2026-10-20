import { expect, test } from "bun:test"
import { TICK_MS } from "../shared/market"
import { takeTick } from "./tick"

test("two prices in one slot send the later one, once", () => {
  const first = { price: "100.00", exchangeTs: 1_000 }
  const later = { price: "100.02", exchangeTs: 1_040 }
  expect(takeTick(later, 1_000, 1_050, TICK_MS)).toEqual({ send: null, lastSentAt: 1_000 })
  const due = takeTick(later, 1_000, 1_100, TICK_MS)
  expect(due).toEqual({ send: later, lastSentAt: 1_100 })
  expect(due.send).not.toEqual(first)
  expect(takeTick(null, due.lastSentAt, 1_150, TICK_MS)).toEqual({ send: null, lastSentAt: 1_100 })
})

test("a slot with no new price sends nothing", () => {
  expect(takeTick(null, 0, TICK_MS, TICK_MS)).toEqual({ send: null, lastSentAt: 0 })
})
