import { expect, test } from "bun:test"
import { balanceStep } from "./balanceMotion"

test("a balance count starts at the shown value and lands on the target", () => {
  expect(balanceStep(10_000_000, 18_500_000, 0)).toBe(10_000_000)
  expect(balanceStep(10_000_000, 18_500_000, -0.2)).toBe(10_000_000)
  expect(balanceStep(10_000_000, 18_500_000, 1)).toBe(18_500_000)
  expect(balanceStep(10_000_000, 18_500_000, 3)).toBe(18_500_000)
})

test("the midpoint sits between the two balances, closer to the landing value", () => {
  const mid = balanceStep(0, 1_000_000, 0.5)
  expect(mid).toBeGreaterThan(500_000)
  expect(mid).toBeLessThan(1_000_000)

  const down = balanceStep(1_000_000, 0, 0.5)
  expect(down).toBeGreaterThan(0)
  expect(down).toBeLessThan(500_000)
})
