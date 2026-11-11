import { expect, test } from "bun:test"
import { clockReadout, createClock, easeClock, noteClock } from "./clock"

test("the first sample snaps", () => {
  const clock = noteClock(createClock(), 1_000, 1_050)
  expect(clock.offset).toBe(-50)
  expect(1_050 + clock.offset).toBe(1_000)
})

test("a late sample does not move now backward", () => {
  let clock = noteClock(createClock(), 1_000, 1_050)
  clock = noteClock(clock, 1_100, 1_200)
  expect(clock.offset).toBe(-50)
  expect(1_200 + clock.offset).toBe(1_150)
})

test("a better sample within 100ms snaps forward", () => {
  let clock = noteClock(createClock(), 1_000, 1_080)
  clock = noteClock(clock, 1_200, 1_220)
  expect(clock.offset).toBe(-20)
})

test("a better sample past 100ms eases forward", () => {
  let clock = noteClock(createClock(), -200, 0)
  clock = noteClock(clock, 1_000, 1_000)
  expect(clock.offset).toBe(-100)
  clock = easeClock(clock, 2_000)
  expect(clock.offset).toBe(0)
})

test("once the best sample ages out, now eases down", () => {
  let clock = noteClock(createClock(), 0, 0)
  clock = noteClock(clock, 60, 100)
  expect(clock.offset).toBe(0)
  clock = easeClock(clock, 2_100)
  expect(clock.offset).toBeCloseTo(-40, 5)
  clock = easeClock(clock, 2_600)
  expect(clock.offset).toBe(-40)
})

test("a 10s buy-in paints 9.9 at the open and 0.0 under a tenth", () => {
  expect(clockReadout(10_000, 10_000)).toBe("9.9")
  expect(clockReadout(9_950, 10_000)).toBe("9.9")
  expect(clockReadout(99, 10_000)).toBe("0.0")
  expect(clockReadout(100, 10_000)).toBe("0.1")
  expect(clockReadout(18_000, Number.POSITIVE_INFINITY)).toBe("18.0")
  expect(clockReadout(10_000, Number.POSITIVE_INFINITY)).toBe("10.0")
})

test("a sample after the 2s window snaps", () => {
  let clock = noteClock(createClock(), 0, 0)
  clock = noteClock(clock, 5_000, 3_000)
  expect(clock.offset).toBe(2_000)
})
