import { expect, test } from "bun:test"
import { addDecimal, averagePrice, compareDecimal, compareGap, dollarGap, microPrice, movedAtLeast, subDecimal, withinDollars } from "./blend"

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

test("compareGap ranks the closer decimal and treats a bad price as farther", () => {
  expect(compareGap("81620", "81600", "81400")).toBe(-1)
  expect(compareGap("81620", "81400", "81600")).toBe(1)
  expect(compareGap("100", "100.00", "100")).toBe(0)
  expect(compareGap("100", "nope", "101")).toBe(1)
})

test("decimal add, subtract, and compare trim zeros and reject bad input", () => {
  expect(addDecimal("1.50", "2.50")).toBe("4")
  expect(addDecimal("1.10", "nope")).toBe("0")
  expect(addDecimal("nope", "1")).toBe("0")
  expect(subDecimal("nope", "1")).toBe("0")
  expect(subDecimal("1.50", "nope")).toBe("1.50")
  expect(subDecimal("1.20", "0.20")).toBe("1")
  expect(subDecimal("1", "5")).toBe("0")
  expect(compareDecimal("nope", "bad")).toBe(0)
  expect(compareDecimal("nope", "1")).toBe(-1)
  expect(compareDecimal("1", "nope")).toBe(1)
  expect(compareDecimal("1.0", "1.00")).toBe(0)
  expect(compareDecimal("1.01", "1")).toBe(1)
})

test("withinDollars keeps a $25 gap and drops a wider one", () => {
  expect(withinDollars("81648.96", "81623.96", 25)).toBe(true)
  expect(withinDollars("81648.96", "81623.95", 25)).toBe(false)
  expect(withinDollars("81648.96", "81532.80", 25)).toBe(false)
  expect(movedAtLeast("100", "100.009", "0.01")).toBe(false)
  expect(movedAtLeast("100", "100.01", "0.01")).toBe(true)
})
