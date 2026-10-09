import { expect, test } from "bun:test"
import { HALF_FLOOR, halfSpan } from "./scale"

const now = 10_000
const baseline = 100

test("a cent near the open stays on the floor when an older print is far away", () => {
  const half = halfSpan(
    [
      { t: 0, price: baseline + 20 },
      { t: 9_000, price: baseline + 0.01 },
      { t: now, price: baseline + 0.01 },
    ],
    baseline,
    now,
  )
  expect(half).toBe(HALF_FLOOR)
  expect(0.01 / half).toBeGreaterThan(0.2)
})

test("a four dollar swing near the open fills the chart and stays inside it", () => {
  const half = halfSpan(
    [
      { t: 8_000, price: 98 },
      { t: 8_500, price: 102 },
      { t: 9_000, price: 98 },
      { t: now, price: baseline },
    ],
    baseline,
    now,
  )
  expect(half).toBeCloseTo(4 / 1.1)
  expect(half).toBeGreaterThan(2)
})

test("a price twenty dollars through the open stays on screen with the open centered", () => {
  const half = halfSpan([{ t: now, price: baseline + 20 }], baseline, now)
  expect(half).toBeCloseTo(20 / 0.72)
  expect(half).toBeGreaterThan(20)
})

test("a flat tape uses the floor", () => {
  const half = halfSpan(
    [
      { t: 9_000, price: baseline },
      { t: now, price: baseline },
    ],
    baseline,
    now,
  )
  expect(half).toBe(HALF_FLOOR)
})
