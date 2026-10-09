import { expect, test } from "bun:test"
import { HALF_FLOOR, contentHalf, halfSpan, openPrice, shownHalf } from "./scale"

const baseline = 100

test("the window opens on the price already printing, and later prints do not move it", () => {
  const points = [
    { t: 1_000, price: baseline },
    { t: 4_000, price: baseline + 40 },
    { t: 9_000, price: baseline - 15 },
  ]
  expect(openPrice(points, 1_000)).toBe(baseline)
  expect(openPrice(points, 1_500)).toBe(baseline)
  expect(openPrice(points, 0)).toBe(baseline)
})

test("a price carried into the window is the open", () => {
  expect(openPrice([{ t: 0, price: 50 }, { t: 2_000, price: 80 }], 1_500)).toBe(50)
})

test("a spike anywhere in the window stays on screen and the open stays centered", () => {
  const points = [
    { t: 0, price: baseline + 20 },
    { t: 9_000, price: baseline + 0.01 },
    { t: 10_000, price: baseline + 0.01 },
  ]
  const half = halfSpan(points, baseline)
  expect(half).toBeCloseTo(20 / 0.9)
  expect(half).toBeGreaterThan(20)
  for (const point of points) expect(Math.abs(point.price - baseline)).toBeLessThanOrEqual(half)
})

test("a four dollar swing around the open fills the chart and stays inside it", () => {
  const points = [
    { t: 8_000, price: 98 },
    { t: 8_500, price: 102 },
    { t: 9_000, price: 98 },
    { t: 10_000, price: baseline },
  ]
  const half = halfSpan(points, baseline)
  expect(half).toBeCloseTo(2 / 0.9)
  expect(half).toBeGreaterThan(2)
})

test("a price twenty dollars through the open stays on screen with the open centered", () => {
  const half = halfSpan([{ t: 10_000, price: baseline + 20 }], baseline)
  expect(half).toBeCloseTo(20 / 0.9)
  expect(half).toBeGreaterThan(20)
})

test("a flat tape uses the floor", () => {
  const half = halfSpan(
    [
      { t: 9_000, price: baseline },
      { t: 10_000, price: baseline },
    ],
    baseline,
  )
  expect(half).toBe(HALF_FLOOR)
})

test("content half is the furthest print from the open", () => {
  expect(
    contentHalf(
      [
        { t: 0, price: baseline + 20 },
        { t: 10_000, price: baseline + 0.01 },
      ],
      baseline,
    ),
  ).toBe(20)
})

test("a cent near a flat open stays visible on the floor", () => {
  const half = halfSpan([{ t: 10_000, price: baseline + 0.01 }], baseline)
  expect(half).toBe(HALF_FLOOR)
  expect(0.01 / half).toBeGreaterThan(0.2)
})

test("a larger target holds while the print still fits", () => {
  expect(shownHalf(1, 1.4, 0.9, false)).toBe(1)
})

test("a print past the scale snaps to the padded target", () => {
  expect(shownHalf(1, 1.8, 1.01, false)).toBe(1.8)
})

test("a print past a short target still lands on screen", () => {
  expect(shownHalf(1, 1.2, 1.5, false)).toBe(1.5)
})

test("a shrinking target snaps to a range that fits", () => {
  expect(shownHalf(2, 1, 0.5, false)).toBe(1)
  expect(shownHalf(2, 1, 1.4, true)).toBe(1.4)
})
