import { expect, test } from "bun:test"
import { formatDollarMove, formatGainLoss, formatMoney, formatPrice, formatPriceDelta, parseAmountMicros, payoutMicros, quoteDollar } from "./format"
import { priceTone } from "./chart"

test("formatMoney rounds half-up to cents for display", () => {
  expect(formatMoney(1_234_567)).toBe("$1.23")
  expect(formatMoney(1_235_000)).toBe("$1.24")
  expect(formatMoney(10_000_000)).toBe("$10.00")
  expect(formatMoney(1_000_000_000)).toBe("$1,000.00")
  expect(formatMoney(-10_004_000)).toBe("-$10.00")
  expect(formatMoney(15_500_000, true)).toBe("+$15.50")
  expect(formatMoney(0)).toBe("$0.00")
})

test("formatGainLoss shows the lost stake or the stake plus winnings", () => {
  expect(formatGainLoss(10_000_000, 0)).toBe("-$10.00")
  expect(formatGainLoss(10_000_000, 18_500_000)).toBe("+$18.50")
  expect(formatGainLoss(10_000_000, 10_000_000)).toBe("$0.00")
})

test("formatPrice keeps the feed decimals", () => {
  expect(formatPrice("67234.10")).toBe("67,234.10")
  expect(formatPrice("100")).toBe("100.00")
  expect(formatPrice("100.12345600")).toBe("100.123456")
  expect(formatPrice("100.5")).toBe("100.50")
})

test("formatPriceDelta subtracts without rounding away decimals", () => {
  expect(formatPriceDelta("100.1234", "100.0000")).toEqual({ text: "+0.1234", side: "up" })
  expect(formatPriceDelta("99.9", "100.0")).toEqual({ text: "−0.10", side: "down" })
  expect(formatPriceDelta("100.00", "100.00")).toEqual({ text: "=", side: "push" })
})

test("formatDollarMove puts a dollar sign on the strike change", () => {
  expect(formatDollarMove("100.1234", "100.0000")).toEqual({ text: "+$0.1234", side: "up" })
  expect(formatDollarMove("99.9", "100.0")).toEqual({ text: "−$0.10", side: "down" })
  expect(formatDollarMove("100.00", "100.00")).toEqual({ text: "=$0.00", side: "push" })
})

test("payoutMicros matches a paid pool and refunds a one-sided pool", () => {
  expect(payoutMicros(50_000_000, "up", 50_000_000, 100_000_000, 25)).toBe(149_625_000)
  expect(payoutMicros(10_000_000, "up", 10_000_000, 0, 25)).toBe(10_000_000)
  expect(payoutMicros(10_000_000, "down", 0, 0, 25)).toBe(10_000_000)
})

test("quoteDollar prices one dollar and says when it only comes back", () => {
  expect(quoteDollar("up", 0, 0, 25)).toBe("$1 back")
  expect(quoteDollar("up", 50_000_000, 0, 25)).toBe("$1 back")
  expect(quoteDollar("up", 50_000_000, 100_000_000, 25)).toBe("$1 wins $2.95")
})

test("parseAmountMicros rejects empty and non-positive amounts", () => {
  expect(parseAmountMicros("10")).toBe(10_000_000)
  expect(parseAmountMicros("0")).toBeNull()
  expect(parseAmountMicros("0.00")).toBeNull()
  expect(parseAmountMicros("1.0000001")).toBeNull()
  expect(parseAmountMicros("")).toBeNull()
})

test("priceTone marks a price sitting on the baseline as a push", () => {
  expect(priceTone(100, 100)).toBe("push")
  expect(priceTone(100 + 1e-10, 100)).toBe("push")
  expect(priceTone(100.01, 100)).toBe("up")
  expect(priceTone(99.99, 100)).toBe("down")
})
