import { beforeEach, expect, test } from "bun:test"
import {
  NEAR_COOLDOWN_CODE,
  callNearRpc,
  isNearCooling,
  nearCooldownStatus,
  nearCustodyIntervalMs,
  nearDepositBatch,
  nearDepositCatchupBatch,
  nearDepositCatchupBudgetMs,
  nearDepositCatchupGapMs,
  nearDepositCatchupLag,
  nearDepositLag,
  nearRpcGapMs,
  requestNearWithdraw,
  resetNearCooldownForTest,
  resetNearRpcQuiet,
  tripNearCooldown,
} from "./near"
import { marketPreferences } from "../shared/market"
import { withChain } from "./activeChain"
import { getDb, useDatabase } from "./db"
import { credit, ensureUser, youFor } from "./rounds"

const sender = "cc".repeat(32)

beforeEach(() => {
  resetNearRpcQuiet()
  resetNearCooldownForTest()
  marketPreferences.chain = "near-testnet"
  marketPreferences.confirmations = 1
  useDatabase(":memory:")
})

test("tripping records retry math and fast-fails without network", async () => {
  const before = Date.now()
  const status = tripNearCooldown("test trip")
  expect(status.cooling).toBe(true)
  expect(status.untilMs).not.toBeNull()
  expect(status.reason).toBe("test trip")
  expect(status.retryAfterMs).toBeGreaterThan(0)
  expect(status.untilMs!).toBeGreaterThanOrEqual(before)
  expect(status.untilMs! - before - status.retryAfterMs).toBeLessThan(1000)
  const live = nearCooldownStatus()
  expect(live.cooling).toBe(true)
  expect(live.retryAfterMs).toBeLessThanOrEqual(status.retryAfterMs)

  let hits = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits += 1
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: { ok: true } })
    },
  })
  try {
    const endpoints = [{ url: `http://127.0.0.1:${server.port}/near`, timeoutMs: 500, sendTimeoutMs: 500, backoffMs: 1_000 }]
    try {
      await callNearRpc(endpoints, "query", {})
      expect.unreachable("expected cooling")
    } catch (error) {
      expect(isNearCooling(error)).toBe(true)
    }
    expect(hits).toBe(0)
  } finally {
    server.stop(true)
  }
})

test("cooldown clears on reset and success resets the streak", () => {
  tripNearCooldown("first")
  expect(nearCooldownStatus().cooling).toBe(true)
  resetNearCooldownForTest()
  expect(nearCooldownStatus()).toEqual({ cooling: false, retryAfterMs: 0, untilMs: null, reason: null })
})

test("two rate-limited endpoints trip the cooldown", async () => {
  resetNearRpcQuiet()
  const limited = Bun.serve({
    port: 0,
    fetch() {
      return new Response("limited", { status: 429 })
    },
  })
  const other = Bun.serve({
    port: 0,
    fetch() {
      return new Response("limited", { status: 429 })
    },
  })
  try {
    const endpoints = [
      { url: `http://127.0.0.1:${limited.port}/near`, timeoutMs: 500, sendTimeoutMs: 500, backoffMs: 1_000 },
      { url: `http://127.0.0.1:${other.port}/near`, timeoutMs: 500, sendTimeoutMs: 500, backoffMs: 1_000 },
    ]
    try {
      await callNearRpc(endpoints, "query", {})
      expect.unreachable("expected cooling")
    } catch (error) {
      expect(isNearCooling(error)).toBe(true)
    }
    expect(nearCooldownStatus().cooling).toBe(true)
  } finally {
    limited.stop(true)
    other.stop(true)
  }
})

test("scanner caps come from env with safe defaults", () => {
  expect(nearDepositBatch({})).toBe(12)
  expect(nearDepositBatch({ NEAR_DEPOSIT_BATCH: "8" })).toBe(8)
  expect(nearDepositBatch({ NEAR_DEPOSIT_BATCH: "999" })).toBe(32)
  expect(nearCustodyIntervalMs({})).toBe(20_000)
  expect(nearCustodyIntervalMs({ NEAR_CUSTODY_INTERVAL_MS: "8000" })).toBe(8_000)
  expect(nearRpcGapMs({})).toBe(75)
})

test("a withdraw during cooling keeps the ledger and reports the code", async () => {
  await withChain("near-testnet", async () => {
    ensureUser(sender)
    credit(sender, 5_000_000)
    getDb().query("UPDATE users SET balance_micros = ? WHERE chain_key = ? AND address = ?").run(5_000_000, "near-testnet", sender)
  })
  tripNearCooldown("test cooling")
  const result = await withChain("near-testnet", () => requestNearWithdraw(sender, 1_000_000))
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.code).toBe(NEAR_COOLDOWN_CODE)
    expect(typeof result.retryAfterMs).toBe("number")
  }
  const balance = withChain("near-testnet", () => youFor(sender)?.balanceMicros)
  expect(balance).toBe(5_000_000)
})

test("a background read keeps working during funding cooldown and never trips it", async () => {
  resetNearRpcQuiet()
  resetNearCooldownForTest()
  let hits = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits += 1
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: { height: 7 } })
    },
  })
  try {
    const endpoints = [{ url: `http://127.0.0.1:${server.port}/near`, timeoutMs: 500, sendTimeoutMs: 500, backoffMs: 1_000 }]
    tripNearCooldown("funding only")
    await expect(callNearRpc(endpoints, "block", {}, { background: true })).resolves.toEqual({ height: 7 })
    expect(hits).toBe(1)
    // A background success must not clear an active funding cooldown.
    expect(nearCooldownStatus().cooling).toBe(true)
  } finally {
    server.stop(true)
  }
})

test("a failing background walk does not trip the funding breaker", async () => {
  resetNearRpcQuiet()
  resetNearCooldownForTest()
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("busy", { status: 503 })
    },
  })
  try {
    const endpoints = [{ url: `http://127.0.0.1:${server.port}/near`, timeoutMs: 500, sendTimeoutMs: 500, backoffMs: 1_000 }]
    await expect(callNearRpc(endpoints, "block", {}, { background: true })).rejects.toThrow()
    expect(nearCooldownStatus().cooling).toBe(false)
  } finally {
    server.stop(true)
  }
})

test("deposit lag reads the stored cursor without touching history", () => {
  getDb()
    .query("INSERT INTO meta (key, value) VALUES (?, ?)")
    .run("near-testnet:near_deposit_height", "111326")
  const lag = nearDepositLag("near-testnet")
  expect(lag.chain).toBe("near-testnet")
  expect(lag.cursor).toBe(111326)
  expect(lag.batch).toBe(12)
  expect(lag.mode).toBe("normal")
  expect(lag.budgetMs).toBe(0)
  expect(lag.skipped).toEqual([])
})

test("catch-up caps come from env and bypass the 32-block batch ceiling", () => {
  expect(nearDepositCatchupLag({})).toBe(1_000)
  expect(nearDepositCatchupLag({ NEAR_DEPOSIT_CATCHUP_LAG: "50" })).toBe(100)
  expect(nearDepositCatchupLag({ NEAR_DEPOSIT_CATCHUP_LAG: "999999" })).toBe(100_000)
  expect(nearDepositCatchupBatch({})).toBe(200)
  expect(nearDepositCatchupBatch({ NEAR_DEPOSIT_CATCHUP_BATCH: "999" })).toBe(999)
  expect(nearDepositCatchupBatch({ NEAR_DEPOSIT_CATCHUP_BATCH: "5" })).toBe(12)
  expect(nearDepositCatchupBudgetMs({})).toBe(10_000)
  expect(nearDepositCatchupBudgetMs({ NEAR_DEPOSIT_CATCHUP_BUDGET_MS: "500" })).toBe(1_000)
  expect(nearDepositCatchupGapMs({})).toBe(2_000)
  expect(nearDepositCatchupGapMs({ NEAR_DEPOSIT_CATCHUP_GAP_MS: "10" })).toBe(250)
})
