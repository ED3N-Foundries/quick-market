import { expect, test } from "bun:test"
import { crossTime, glideHead, glideSeries, inTheMoney, pieceBaseline, priceInUse, priceY, ridePoints, scaleFrame, showLockLevel, strikeCaption, tapeInView, type TapePoint } from "./chart"
import { contentHalf } from "./scale"

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

test("a locked strike is the price in use, and a missing strike uses the stage fallback", () => {
  expect(priceInUse(101, 100)).toBe(101)
  expect(priceInUse(null, 100)).toBe(100)
  expect(priceInUse(Number.NaN, 100)).toBe(100)
  expect(priceInUse(null, null)).toBeNull()
})

test("a pegged strike leaves the left caption empty", () => {
  expect(strikeCaption({ price: 100, text: "100.5", peg: true }, points, 12_000)).toBeNull()
  expect(strikeCaption({ price: 100, text: "100.5" }, points, 12_000)).toBe("100.5000")
})

test("a bet window stays on the open print while later prints move", () => {
  const points = [
    { t: 9_000, price: 100 },
    { t: 10_000, price: 100 },
    { t: 12_000, price: 110 },
    { t: 14_000, price: 90 },
  ]
  expect(scaleFrame(null, points, 10_000)).toEqual({ center: 100, before: 100, after: null })
})

test("a fall into the strike keeps its open ink while the center is the strike", () => {
  const points = [
    { t: 9_000, price: 100 },
    { t: 10_000, price: 100 },
    { t: 14_000, price: 90 },
    { t: 15_000, price: 90 },
  ]
  const strike = { price: 90, at: 15_000, openAt: 10_000 }
  const during = scaleFrame(strike, points, 10_000)
  expect(during.center).toBe(90)
  expect(during.before).toBe(100)
  expect(during.after).toBe(90)
  expect(pieceBaseline(10_000, 15_000, strike.at, during.before, during.after)).toBe(100)
  expect(pieceBaseline(14_000, 14_000, strike.at, during.before, during.after)).toBe(100)

  const ride = scaleFrame(strike, points, 15_000)
  expect(ride.center).toBe(90)
  expect(ride.before).toBeNull()
  expect(ride.after).toBe(90)
  expect(pieceBaseline(15_000, 16_000, strike.at, ride.before, ride.after)).toBe(90)
})

test("a pegged ride's zoom ignores the run into the strike", () => {
  const at = 15_000
  const series = [
    { t: 10_000, price: 100 },
    { t: at, price: 100 },
    { t: at, price: 90 },
    { t: 16_000, price: 90.2 },
  ]
  const ride = ridePoints(series, at, 90)
  expect(ride).toEqual([
    { t: 16_000, price: 90.2 },
    { t: at, price: 90 },
  ])
  expect(contentHalf(ride, 90)).toBeCloseTo(0.2)
})

test("a step that crosses the strike splits once", () => {
  const at = 15_000
  expect(crossTime({ t: 10_000, price: 100 }, { t: 16_000, price: 100 }, at)).toEqual({ t: at, price: 100 })
  expect(crossTime({ t: 10_000, price: 100 }, { t: 12_000, price: 90 }, at)).toBeNull()
  const frame = scaleFrame(
    { price: 90, at, openAt: 10_000 },
    [
      { t: 10_000, price: 100 },
      { t: 16_000, price: 90 },
    ],
    10_000,
  )
  expect(pieceBaseline(10_000, at, at, frame.before, frame.after)).toBe(100)
  expect(pieceBaseline(at, 16_000, at, frame.before, frame.after)).toBe(90)
})

test("the live head blends the samples that bracket render time", () => {
  const tape: TapePoint[] = [
    { t: 0, price: 100, text: "100.00" },
    { t: 100, price: 110, text: "110.00" },
  ]
  expect(glideHead(tape, 50)).toEqual({ price: 105, text: null })
  expect(glideSeries(tape, 0, 300, 250, 200, true)).toEqual([
    { t: 0, price: 100, text: "100.00" },
    { t: 250, price: 105 },
  ])
})

test("a moving head is one slope to the clock", () => {
  const tape: TapePoint[] = [
    { t: 0, price: 100 },
    { t: 100, price: 110 },
    { t: 200, price: 120 },
  ]
  expect(glideSeries(tape, 0, 300, 250, 100, true)).toEqual([
    { t: 0, price: 100 },
    { t: 100, price: 110 },
    { t: 250, price: 115 },
  ])
})

test("a sample newer than render time is not the head", () => {
  const tape: TapePoint[] = [{ t: 100, price: 110, text: "110.00" }]
  expect(glideHead(tape, 50)).toBeNull()
  expect(glideSeries(tape, 0, 300, 250, 200, true)).toEqual([])
})

test("past the last sample the live line holds to the clock", () => {
  const tape: TapePoint[] = [
    { t: 0, price: 100, text: "100.00" },
    { t: 100, price: 110, text: "110.00" },
  ]
  expect(glideHead(tape, 200)).toEqual({ price: 110, text: "110.00" })
  expect(glideSeries(tape, 0, 300, 400, 200, true).map((point) => [point.t, point.price])).toEqual([
    [0, 100],
    [100, 110],
    [300, 110],
  ])
})

test("a head still left of the view runs to the clock", () => {
  const tape: TapePoint[] = [{ t: 0, price: 100, text: "100.00" }]
  expect(glideSeries(tape, 500, 1_000, 550, 100, true)).toEqual([
    { t: 500, price: 100 },
    { t: 550, price: 100 },
  ])
})

test("a head already past the view holds to the right edge", () => {
  const tape: TapePoint[] = [
    { t: 0, price: 100, text: "100.00" },
    { t: 100, price: 110, text: "110.00" },
  ]
  expect(glideSeries(tape, 0, 300, 500, 100, true).map((point) => [point.t, point.price])).toEqual([
    [0, 100],
    [100, 110],
    [300, 110],
  ])
})

test("in the money is the bet side of the strike, and a push is not", () => {
  expect(inTheMoney("up", 101, 100)).toBe(true)
  expect(inTheMoney("down", 101, 100)).toBe(false)
  expect(inTheMoney("down", 99, 100)).toBe(true)
  expect(inTheMoney("up", 100, 100)).toBe(false)
  expect(inTheMoney("down", 100, 100)).toBe(false)
})

test("a higher price sits above a lower one", () => {
  const scale = { yMin: 90, yMax: 110, plotTop: 16, plotHeight: 200 }
  const mid = priceY(100, scale)
  expect(mid).toBeCloseTo(116)
  expect(priceY(110, scale)).toBeLessThan(mid)
  expect(priceY(90, scale)).toBeGreaterThan(mid)
})

test("a panned view does not invent a hold out to its right edge", () => {
  const series = tapeInView(points, 10_000, 15_000, 18_000, true, false)
  expect(series[series.length - 1]).toEqual({ t: 12_000, price: 101 })
})

test("the lock level is the open follow window, not a ride, a scrub, or the last instant", () => {
  expect(showLockLevel({ follow: true, live: true, pegged: false, headTime: 12_000, viewEnd: 15_000 })).toBe(true)
  expect(showLockLevel({ follow: true, live: true, pegged: false, headTime: 14_700, viewEnd: 15_000 })).toBe(true)
  expect(showLockLevel({ follow: false, live: true, pegged: false, headTime: 12_000, viewEnd: 15_000 })).toBe(false)
  expect(showLockLevel({ follow: true, live: false, pegged: false, headTime: 12_000, viewEnd: 15_000 })).toBe(false)
  expect(showLockLevel({ follow: true, live: true, pegged: true, headTime: 12_000, viewEnd: 15_000 })).toBe(false)
  expect(showLockLevel({ follow: true, live: true, pegged: false, headTime: 14_750, viewEnd: 15_000 })).toBe(false)
})
