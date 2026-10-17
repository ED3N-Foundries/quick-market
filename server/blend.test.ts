import { expect, test } from "bun:test"
import { averagePrice, dollarGap, microPrice, movedAtLeast, withinDollars } from "./blend"

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

test("microPrice weights the touch and rounds to 4 decimal places", () => {
  expect(microPrice("100", "102", "1", "1")).toBe("101.0000")
  expect(microPrice("100", "102", "3", "1")).toBe("101.5000")
  expect(microPrice("100.00", "102.00")).toBe("101.00")
  expect(microPrice("100", "102", "0", "1")).toBe("101")
  expect(microPrice("nope", "102", "1", "1")).toBeNull()
})

test("dollarGap is the absolute decimal distance", () => {
  expect(dollarGap("67420.12", "67419.80")).toBe("0.32")
  expect(dollarGap("100", "125")).toBe("25")
  expect(dollarGap("100.00", "100.000")).toBe("0")
  expect(dollarGap("nope", "1")).toBeNull()
})

test("withinDollars keeps a $25 gap and drops a wider one", () => {
  expect(withinDollars("81648.96", "81623.96", 25)).toBe(true)
  expect(withinDollars("81648.96", "81623.95", 25)).toBe(false)
  expect(withinDollars("81648.96", "81532.80", 25)).toBe(false)
  expect(movedAtLeast("100", "100.009", "0.01")).toBe(false)
  expect(movedAtLeast("100", "100.01", "0.01")).toBe(true)
})
