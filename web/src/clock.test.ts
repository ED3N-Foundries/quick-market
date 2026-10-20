import { expect, test } from "bun:test"
import { createClock, easeClock, noteClock } from "./clock"

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
