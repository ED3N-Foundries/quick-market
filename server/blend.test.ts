import { expect, test } from "bun:test"
import { averagePrice, blendLegs, type Leg } from "./blend"

function leg(price: string, receivedAt: number): Leg {
  return { price, receivedAt }
}

test("averagePrice halves two decimal strings without binary rounding", () => {
  expect(averagePrice("67234.10", "67234.10")).toBe("67234.10")
  expect(averagePrice("100.10", "100.20")).toBe("100.15")
  expect(averagePrice("100", "100.5")).toBe("100.25")
  expect(averagePrice("100.25", "100.5")).toBe("100.375")
  expect(averagePrice("100", "100")).toBe("100")
})

test("averagePrice keeps a trailing 5 when the scaled sum is odd", () => {
  expect(averagePrice("100.1", "100.2")).toBe("100.15")
  expect(averagePrice("100", "101")).toBe("100.5")
})

test("averagePrice rejects a price that is not a decimal", () => {
  expect(averagePrice("100.1", "nope")).toBeNull()
  expect(averagePrice("0", "0")).toBeNull()
})

test("blendLegs waits for both venues", () => {
  const now = 10_000
  expect(blendLegs(leg("100", now), null, now)).toBeNull()
  expect(blendLegs(null, leg("100", now), now)).toBeNull()
  expect(blendLegs(leg("100.1", now), leg("100.2", now), now)).toBe("100.15")
})

test("blendLegs drops a leg older than the live window and keeps one at the edge", () => {
  const now = 10_000
  expect(blendLegs(leg("100", now - 5_000), leg("100", now), now)).toBe("100")
  expect(blendLegs(leg("100", now - 5_001), leg("100", now), now)).toBeNull()
  expect(blendLegs(leg("100", now), leg("100", now - 5_001), now)).toBeNull()
})

test("blendLegs drops a pair more than 1% apart and keeps a pair at 1%", () => {
  const now = 10_000
  expect(blendLegs(leg("19900", now), leg("20100", now), now)).toBe("20000")
  expect(blendLegs(leg("19900", now), leg("20101", now), now)).toBeNull()
  expect(blendLegs(leg("100", now), leg("200", now), now)).toBeNull()
})
