import { expect, test } from "bun:test"
import { useDatabase } from "./db"
import { nearBootShouldMint, nearDepositLag } from "./near"
import { nearDepositScanActive, pollNearDepositIndex } from "./nearDepositPoll"

test("ledger-only boot does not mint the treasury gap", () => {
  expect(nearBootShouldMint(5n, {})).toBe(true)
  expect(nearBootShouldMint(0n, {})).toBe(false)
  expect(nearBootShouldMint(5n, { NEAR_LEDGER_ONLY: "1" })).toBe(false)
  expect(nearBootShouldMint(5n, { NEAR_LEDGER_ONLY: "true" })).toBe(false)
  expect(nearBootShouldMint(5n, { NEAR_LEDGER_ONLY: "0" })).toBe(true)
})

test("ledger-only idles the deposit poll and the block walk", async () => {
  useDatabase(":memory:")
  const previous = process.env.NEAR_LEDGER_ONLY
  process.env.NEAR_LEDGER_ONLY = "1"
  try {
    expect(nearDepositScanActive(Date.now(), { NEAR_LEDGER_ONLY: "1", NEAR_DEPOSIT_INDEX_URL: "" })).toBe(false)
    const health = nearDepositLag("near-testnet")
    expect(health.source).toBe("off")
    expect(health.cursor).toBeUndefined()
    expect(health.lastError).toBeNull()
    await expect(pollNearDepositIndex("treasury.testnet")).resolves.toEqual({
      ok: true,
      pages: 0,
      events: 0,
      credits: 0,
      held: false,
    })
  } finally {
    if (previous === undefined) delete process.env.NEAR_LEDGER_ONLY
    else process.env.NEAR_LEDGER_ONLY = previous
  }
})
