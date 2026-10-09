import { expect, test } from "bun:test"
import { priceInUse, tapeInView, type TapePoint } from "./chart"

const points: TapePoint[] = [
  { t: 0, price: 100 },
  { t: 12_000, price: 101 },
  { t: 16_000, price: 102 },
]

test("a print from before the window is held at the left edge through now", () => {
  expect(tapeInView(points, 10_000, 15_000, 13_000, true, true)).toEqual([
    { t: 10_000, price: 100 },
    { t: 12_000, price: 100 },
    { t: 12_000, price: 101 },
    { t: 13_000, price: 101 },
  ])
})

test("a closed follow window holds the last price to the right edge", () => {
  const series = tapeInView(points, 10_000, 15_000, 18_000, true, true)
  expect(series[0]).toEqual({ t: 10_000, price: 100 })
  expect(series[series.length - 1]).toEqual({ t: 15_000, price: 101 })
})

test("a view that has not started does not get a line across it", () => {
  expect(tapeInView(points, 20_000, 25_000, 16_000, true, true)).toEqual([{ t: 20_000, price: 102 }])
})

test("replay stops at the last print inside the window", () => {
  expect(tapeInView(points, 10_000, 15_000, 99_000, false, false)).toEqual([
    { t: 10_000, price: 100 },
    { t: 12_000, price: 100 },
    { t: 12_000, price: 101 },
  ])
})

test("a locked strike is the price in use, and a missing strike falls back to the latest price", () => {
  expect(priceInUse(101, 100)).toBe(101)
  expect(priceInUse(null, 100)).toBe(100)
  expect(priceInUse(Number.NaN, 100)).toBe(100)
  expect(priceInUse(null, null)).toBeNull()
})

test("a panned view does not invent a hold out to its right edge", () => {
  const series = tapeInView(points, 10_000, 15_000, 18_000, true, false)
  expect(series[series.length - 1]).toEqual({ t: 12_000, price: 101 })
})
