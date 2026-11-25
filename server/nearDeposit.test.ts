import { expect, test } from "bun:test"
import { marketPreferences } from "../shared/market"
import {
  applyNearDeposit,
  nearDepositBlockQuery,
  nearDepositLag,
  nearWithdrawalWait,
  parseNearDeposits,
  resetNearRpcQuiet,
  startNearCustody,
  type NearCustodyLoop,
} from "./near"
import { getDb, useDatabase } from "./db"
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

test("NEAR deposits and withdrawals use optimistic execution for one confirmation", () => {
  const previous = marketPreferences.confirmations
  try {
    marketPreferences.confirmations = 1
    expect(nearWithdrawalWait()).toBe("EXECUTED_OPTIMISTIC")
    expect(nearDepositBlockQuery()).toEqual({ finality: "optimistic" })
    expect(nearDepositBlockQuery(12)).toEqual({ block_id: 12 })
    marketPreferences.confirmations = 2
    expect(nearWithdrawalWait()).toBe("EXECUTED")
    expect(nearDepositBlockQuery()).toEqual({ finality: "final" })
  } finally {
    marketPreferences.confirmations = previous
  }
})

test("a NEAR deposit is credited once", () => {
  marketPreferences.chain = "near-testnet"
  useDatabase(":memory:")
  const deposit = { txHash: "hash", logIndex: 0, from: sender, amountMicros: 2_500_000, timestamp: 10n }
  expect(applyNearDeposit(deposit)).toBe(true)
  expect(applyNearDeposit(deposit)).toBe(false)
  expect(youFor(sender)?.balanceMicros).toBe(2_500_000)
})

type RpcRequest = { method: string; params?: { block_id?: number } }

/** A minimal NEAR RPC: `block` by id or head. Other methods answer an empty result. */
function mockNearChain(options: {
  head: () => number
  blockDelayMs?: number
  pruned?: (height: number) => boolean
}) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as RpcRequest
      if (body.method !== "block") return Response.json({ jsonrpc: "2.0", id: "quick-market", result: {} })
      const height = body.params?.block_id
      if (height === undefined) {
        return Response.json({
          jsonrpc: "2.0",
          id: "quick-market",
          result: { header: { height: options.head() }, chunks: [] },
        })
      }
      if (options.pruned?.(height)) {
        return Response.json(
          { jsonrpc: "2.0", id: "quick-market", error: { message: "Server error", data: "DB Not Found Error: BLOCK: gone" } },
          { status: 422 },
        )
      }
      if (options.blockDelayMs) await Bun.sleep(options.blockDelayMs)
      return Response.json({
        jsonrpc: "2.0",
        id: "quick-market",
        result: { header: { height, timestamp_nanosec: "1000" }, chunks: [] },
      })
    },
  })
}

function seedCursor(cursor: number): void {
  useDatabase(":memory:")
  marketPreferences.chain = "near-testnet"
  getDb().query("INSERT INTO meta (key, value) VALUES ('near-testnet:near_deposit_height', ?)").run(String(cursor))
}

function envPatch(values: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key]
    process.env[key] = values[key]
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function awaitLag(reach: (lag: ReturnType<typeof nearDepositLag>) => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (reach(nearDepositLag("near-testnet"))) return
    if (Date.now() - started > timeoutMs) throw new Error(`deposit lag did not reach the expectation in ${timeoutMs} ms`)
    await Bun.sleep(50)
  }
}

test("custody self-schedules a catch-up backlog in bounded bites and settles to normal", async () => {
  resetNearRpcQuiet()
  const head = 220
  const server = mockNearChain({ head: () => head })
  const restore = envPatch({
    NEAR_RPC_1: `http://127.0.0.1:${server.port}/near 500 500 100`,
    NEAR_RPC_GAP_MS: "0",
    NEAR_DEPOSIT_CATCHUP_LAG: "100",
    NEAR_DEPOSIT_CATCHUP_GAP_MS: "250",
    NEAR_DEPOSIT_CATCHUP_BATCH: "40",
    NEAR_DEPOSIT_CATCHUP_BUDGET_MS: "1000",
  })
  seedCursor(0)
  const loop: NearCustodyLoop = startNearCustody(treasury)
  try {
    // The first bite is 40 blocks, not the normal 12: at the normal 5 s interval
    // reaching 40 would take three parked ticks, well past this timeout.
    await awaitLag((lag) => lag.head === head && (lag.cursor ?? 0) >= 40, 4_000)
    expect(nearDepositLag("near-testnet").mode).toBe("catchup")
    // The loop keeps ticking on its own: no interval skip, no polling flag, no manual arm.
    // Catch-up bites carry the cursor past the threshold (lag 100), where mode goes quiet.
    await awaitLag((lag) => (lag.cursor ?? 0) >= 120, 8_000)
    const settled = nearDepositLag("near-testnet")
    expect(settled.cursor).toBeGreaterThanOrEqual(120)
    expect(settled.mode).toBe("normal")
    expect(settled.budgetMs).toBe(0)
  } finally {
    loop.stop()
    restore()
    resetNearRpcQuiet()
    server.stop(true)
  }
})

test("the catch-up budget yields mid-batch so a bite cannot starve the market", async () => {
  resetNearRpcQuiet()
  const head = 130
  const server = mockNearChain({ head: () => head, blockDelayMs: 200 })
  const restore = envPatch({
    NEAR_RPC_1: `http://127.0.0.1:${server.port}/near 500 500 100`,
    NEAR_RPC_GAP_MS: "0",
    NEAR_DEPOSIT_CATCHUP_LAG: "100",
    NEAR_DEPOSIT_CATCHUP_GAP_MS: "250",
    NEAR_DEPOSIT_CATCHUP_BATCH: "40",
    NEAR_DEPOSIT_CATCHUP_BUDGET_MS: "1000",
  })
  seedCursor(0)
  const loop: NearCustodyLoop = startNearCustody(treasury)
  try {
    // 200 ms per block against a 1 s budget and a 40-block batch: the budget must yield
    // each bite after ~5 blocks. The budget itself caps every bite, so any read that
    // sees progress also proves the bite stopped far short of the whole batch.
    await awaitLag((lag) => (lag.cursor ?? 0) >= 3, 8_000)
    const yielded = nearDepositLag("near-testnet").cursor ?? 0
    expect(yielded).toBeGreaterThan(0)
    expect(yielded).toBeLessThan(40)
  } finally {
    loop.stop()
    restore()
    resetNearRpcQuiet()
    server.stop(true)
  }
})

test("a pruned range is recorded, not just logged, and the cursor jumps past it", async () => {
  resetNearRpcQuiet()
  const head = 150
  const server = mockNearChain({ head: () => head, pruned: () => true })
  const restore = envPatch({
    NEAR_RPC_1: `http://127.0.0.1:${server.port}/near 500 500 100`,
    NEAR_RPC_GAP_MS: "0",
  })
  seedCursor(0)
  const loop: NearCustodyLoop = startNearCustody(treasury)
  try {
    await awaitLag((lag) => (lag.cursor ?? 0) === head - 1, 4_000)
    const lag = nearDepositLag("near-testnet")
    expect(lag.skipped).toEqual([{ from: 1, to: head - 1, at: expect.any(Number) }])
    const stored = getDb().query("SELECT value FROM meta WHERE key = 'near-testnet:near_deposit_skips'").get() as {
      value: string
    }
    expect(JSON.parse(stored.value)).toEqual([{ from: 1, to: head - 1, at: expect.any(Number) }])
  } finally {
    loop.stop()
    restore()
    resetNearRpcQuiet()
    server.stop(true)
  }
})

test("starting custody again stops the previous loop instead of doubling the scanner", async () => {
  resetNearRpcQuiet()
  const head = 220
  const server = mockNearChain({ head: () => head })
  const restore = envPatch({
    NEAR_RPC_1: `http://127.0.0.1:${server.port}/near 500 500 100`,
    NEAR_RPC_GAP_MS: "0",
    NEAR_DEPOSIT_CATCHUP_LAG: "100",
    NEAR_DEPOSIT_CATCHUP_GAP_MS: "250",
    NEAR_DEPOSIT_CATCHUP_BATCH: "40",
    NEAR_DEPOSIT_CATCHUP_BUDGET_MS: "1000",
  })
  seedCursor(0)
  const first: NearCustodyLoop = startNearCustody(treasury)
  const second: NearCustodyLoop = startNearCustody(treasury)
  try {
    expect(second).not.toBe(first)
    // One loop drives the cursor: the second start replaced the first, not doubled it.
    await awaitLag((lag) => (lag.cursor ?? 0) >= 40, 4_000)
    second.stop()
    first.stop()
    // An in-flight bite finishes (deposit credit is idempotent), but nothing reschedules.
    await Bun.sleep(600)
    const frozen = nearDepositLag("near-testnet").cursor
    await Bun.sleep(400)
    expect(nearDepositLag("near-testnet").cursor).toBe(frozen)
  } finally {
    first.stop()
    second.stop()
    restore()
    resetNearRpcQuiet()
    server.stop(true)
  }
})
