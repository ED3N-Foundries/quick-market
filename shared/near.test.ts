import { expect, test } from "bun:test"
import {
  AGENT_FLOOR_YOCTO,
  TREASURY_RESERVE_YOCTO,
  describeTreasury,
  englishReport,
  formatQm,
  formatYocto,
  isImplicitAccount,
  isNearAccountId,
  ledgerChainConflict,
  ledgerChainMessage,
  planSeed,
  reportLines,
  requireNearToken,
} from "./near"
import { copy } from "../web/src/copy"

const floor = AGENT_FLOOR_YOCTO
const reserve = TREASURY_RESERVE_YOCTO

test("account ids accept implicit keys and reject EVM addresses", () => {
  const implicit = "ab".repeat(32)
  expect(isImplicitAccount(implicit)).toBe(true)
  expect(isNearAccountId(implicit)).toBe(true)
  expect(isNearAccountId("alice.testnet")).toBe(true)
  expect(isNearAccountId("0x" + "ab".repeat(20))).toBe(false)
  expect(isImplicitAccount("alice.testnet")).toBe(false)
})

test("the planner mints the QM shortfall and funds agents in account order", () => {
  const plan = planSeed({
    treasury: { exists: true, nearYocto: reserve + floor * 3n, tokenMicros: 40n },
    ledgerMicros: 100n,
    agents: [
      { account: "b".repeat(64), holding: { exists: true, nearYocto: floor, tokenMicros: 0n } },
      { account: "c".repeat(64), holding: { exists: false, nearYocto: 0n, tokenMicros: 0n } },
      { account: "a".repeat(64), holding: { exists: true, nearYocto: floor / 2n, tokenMicros: 0n } },
    ],
  })
  expect(plan.mintMicros).toBe(60n)
  expect(plan.transfers.map((row) => row.to)).toEqual(["a".repeat(64), "c".repeat(64)])
  expect(plan.transfers[0]!.yocto).toBe(floor / 2n)
  expect(plan.transfers[1]!.yocto).toBe(floor)
})

test("transfers that would break the treasury reserve are skipped", () => {
  const plan = planSeed({
    treasury: { exists: true, nearYocto: reserve + floor / 2n, tokenMicros: 0n },
    ledgerMicros: 0n,
    agents: [
      { account: "a".repeat(64), holding: { exists: false, nearYocto: 0n, tokenMicros: 0n } },
      { account: "b".repeat(64), holding: { exists: false, nearYocto: 0n, tokenMicros: 0n } },
    ],
  })
  expect(plan.transfers).toEqual([])
  expect(plan.mintMicros).toBe(0n)
})

test("a treasury with no NEAR does not plan a mint", () => {
  const plan = planSeed({
    treasury: { exists: false, nearYocto: 0n, tokenMicros: 0n },
    ledgerMicros: 10n,
    agents: [],
  })
  expect(plan.mintMicros).toBe(0n)
})

test("the report names a short treasury and a short agent in token units", () => {
  const report = describeTreasury({
    account: "treasury.testnet",
    treasury: { exists: true, nearYocto: reserve / 2n, tokenMicros: 50_000_000n },
    ledgerMicros: 100_000_000n,
    agents: [{ account: "a".repeat(64), holding: { exists: false, nearYocto: 0n, tokenMicros: 0n } }],
  })
  expect(report.ok).toBe(false)
  expect(report.near).toBe("0.25")
  expect(report.nearNeed).toBe("0.5")
  expect(report.token).toBe("50")
  expect(report.tokenNeed).toBe("100")
  expect(report.lines[0]).toBe("near-testnet treasury treasury.testnet")
  expect(report.lines).toContain("NEAR 0.25 (need 0.5)")
  expect(report.lines).toContain("QM 50 (need 100)")
  expect(report.lines).toContain("agents 0/1")
  expect(report.lines).toContain(`${"a".repeat(64)} missing`)
  expect(formatYocto(floor)).toBe("0.05")
  expect(formatQm(100_000_000n)).toBe("100")
  const chinese = reportLines(report, copy("zh-TW").nearReport)
  expect(chinese[0]).toContain("金庫")
  expect(chinese.join("\n")).toContain("尚未建立")
  expect(reportLines(report, englishReport)[1]).toBe("NEAR 0.25 (need 0.5)")
})

test("a ready treasury and an empty agent set are ready", () => {
  const report = describeTreasury({
    account: "t",
    treasury: { exists: true, nearYocto: reserve, tokenMicros: 1n },
    ledgerMicros: 1n,
    agents: [],
  })
  expect(report.ok).toBe(true)
  expect(report.lines).toContain("treasury ready")
  expect(report.lines).toContain("agents ready")
})

test("the ledger guard names DB_PATH and does not mix chains", () => {
  expect(ledgerChainConflict(["0x" + "ab".repeat(20)], "near-testnet")).toBe("base")
  expect(ledgerChainConflict(["ab".repeat(32)], "base-sepolia")).toBe("near")
  expect(ledgerChainConflict(["alice.testnet"], "base")).toBe("near")
  expect(ledgerChainMessage("base", "data/near.sqlite")).toBe(
    "This database has Base accounts. Use a separate DB_PATH for NEAR testnet. DB_PATH=data/near.sqlite",
  )
  expect(ledgerChainMessage("near", "data/quick-market.sqlite")).toContain("DB_PATH=data/quick-market.sqlite")
  expect(() => requireNearToken("near-testnet", "")).toThrow("TOKEN_ACCOUNT")
  expect(() => requireNearToken("base-sepolia", "")).not.toThrow()
})
