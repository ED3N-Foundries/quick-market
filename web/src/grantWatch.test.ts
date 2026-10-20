import { expect, test } from "bun:test"
import { confirmationDepth, grantLanded, grantTxUrl } from "./grantWatch"

const hash = "0x" + "ab".repeat(32)

test("confirmation depth counts the landing block", () => {
  expect(confirmationDepth(null, 10n)).toBe(0)
  expect(confirmationDepth(10n, null)).toBe(0)
  expect(confirmationDepth(9n, 10n)).toBe(0)
  expect(confirmationDepth(10n, 10n)).toBe(1)
  expect(confirmationDepth(12n, 10n)).toBe(3)
})

test("a grant has landed only when grantAt moves forward", () => {
  expect(grantLanded(null, null)).toBe(false)
  expect(grantLanded(null, 50)).toBe(true)
  expect(grantLanded(50, 50)).toBe(false)
  expect(grantLanded(50, 80)).toBe(true)
})

test("grant tx url points at the chain explorer", () => {
  expect(grantTxUrl(84532, hash)).toBe(`https://sepolia.basescan.org/tx/${hash}`)
  expect(grantTxUrl(8453, hash)).toBe(`https://basescan.org/tx/${hash}`)
  expect(grantTxUrl(84532, "0xabc")).toBeNull()
  expect(grantTxUrl(1, hash)).toBeNull()
})
