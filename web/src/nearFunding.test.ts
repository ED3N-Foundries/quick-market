import { expect, test } from "bun:test"
import {
  emptyNearFunding,
  formatNearRetry,
  isNearCoolingBody,
  nearRetryMs,
  nearRetrySeconds,
  parseNearFunding,
} from "./nearFunding"

test("parseNearFunding never throws and defaults to open", () => {
  expect(parseNearFunding(null)).toEqual(emptyNearFunding())
  expect(parseNearFunding({})).toEqual(emptyNearFunding())
  expect(parseNearFunding({ cooling: true, retryAfterMs: 12_000, untilMs: 1_700_000_000_000, reason: "429" })).toEqual({
    cooling: true,
    retryAfterMs: 12_000,
    untilMs: 1_700_000_000_000,
    reason: "429",
  })
})

test("retry countdown prefers untilMs and survives clock skew", () => {
  const now = 1_700_000_000_000
  expect(nearRetryMs({ cooling: true, retryAfterMs: 5_000, untilMs: now + 23_000, reason: null }, now)).toBe(23_000)
  expect(nearRetryMs({ cooling: true, retryAfterMs: 5_000, untilMs: null, reason: null }, now)).toBe(5_000)
  expect(nearRetryMs({ cooling: false, retryAfterMs: 5_000, untilMs: now + 5_000, reason: null }, now)).toBe(0)
  expect(nearRetryMs({ cooling: true, retryAfterMs: 5_000, untilMs: now - 1_000, reason: null }, now)).toBe(0)
})

test("retry label is whole seconds, at least one", () => {
  expect(nearRetrySeconds(0)).toBe(1)
  expect(nearRetrySeconds(23_000)).toBe(23)
  expect(formatNearRetry(23_400)).toBe("24s")
})

test("503 bodies map to cooling", () => {
  expect(isNearCoolingBody({ code: "NEAR_COOLING" })).toBe(true)
  expect(isNearCoolingBody({ code: "OTHER" })).toBe(false)
  expect(isNearCoolingBody(null)).toBe(false)
})
