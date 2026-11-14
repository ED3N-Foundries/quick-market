import { expect, test } from "bun:test"
import { GRANT_FOLLOW_MS, MINT_CONFIRMATIONS, MINT_RECEIPT_TIMEOUT_MS, confirmationDepth, grantStep, mintReceiptWait } from "./mint"

test("a grant mint waits on one block past a single slot", () => {
  expect(MINT_CONFIRMATIONS).toBe(1)
  expect(MINT_RECEIPT_TIMEOUT_MS).toBe(45_000)
  expect(GRANT_FOLLOW_MS).toBeGreaterThan(MINT_RECEIPT_TIMEOUT_MS)
  const hash = `0x${"ab".repeat(32)}` as `0x${string}`
  expect(mintReceiptWait(hash)).toEqual({
    hash,
    confirmations: 1,
    timeout: 45_000,
    pollingInterval: 1_000,
  })
})

test("the grant meter is done as soon as the hash exists", () => {
  expect(confirmationDepth(10n, 10n)).toBe(1)
  expect(confirmationDepth(12n, 10n)).toBe(3)
  expect(grantStep(0, false)).toBe(0)
  expect(grantStep(0, true)).toBe(1)
  expect(grantStep(1, true)).toBe(1)
  expect(grantStep(2, true)).toBe(1)
  expect(grantStep(9, true)).toBe(1)
})
