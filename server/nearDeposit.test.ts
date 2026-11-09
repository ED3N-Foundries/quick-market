import { expect, test } from "bun:test"
import { applyNearDeposit, parseNearDeposits } from "./near"
import { useDatabase } from "./db"
import { youFor } from "./rounds"

const treasury = "aa".repeat(32)
const token = "bb".repeat(32)
const sender = "cc".repeat(32)

function log(event: string, data: Record<string, unknown>): string {
  return `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event, data: [data] })}`
}

function outcome(executor: string, logs: string[], failed = false) {
  return { outcome: { executor_id: executor, logs, status: failed ? { Failure: {} } : { SuccessValue: "" } } }
}

test("deposit events credit only successful QM transfers to the treasury", () => {
  const incoming = log("ft_transfer", { old_owner_id: sender, new_owner_id: treasury, amount: "2500000" })
  const rows = parseNearDeposits(
    {
      transaction: { hash: "HashCase" },
      receipts_outcome: [
        outcome(token, [
          log("ft_mint", { owner_id: treasury, amount: "100" }),
          incoming,
          log("ft_transfer", { old_owner_id: treasury, new_owner_id: sender, amount: "100" }),
        ]),
        outcome("dd".repeat(32), [incoming]),
        outcome(token, [incoming], true),
      ],
    },
    treasury,
    token,
    10n,
  )
  expect(rows).toEqual([{ txHash: "HashCase", logIndex: 0, from: sender, amountMicros: 2_500_000, timestamp: 10n }])
})

test("a NEAR deposit is credited once", () => {
  useDatabase(":memory:")
  const deposit = { txHash: "hash", logIndex: 0, from: sender, amountMicros: 2_500_000, timestamp: 10n }
  expect(applyNearDeposit(deposit)).toBe(true)
  expect(applyNearDeposit(deposit)).toBe(false)
  expect(youFor(sender)?.balanceMicros).toBe(2_500_000)
})
