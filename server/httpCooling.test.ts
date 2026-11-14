import { afterEach, beforeEach, expect, test } from "bun:test"
import { marketPreferences } from "../shared/market"
import { withChain } from "./activeChain"
import { getDb, useDatabase } from "./db"
import { bindHttp, handle } from "./http"
import { NEAR_COOLDOWN_CODE } from "./near"
import { resetNearRpcQuiet, tripNearCooldown, resetNearCooldownForTest } from "./near"
import { ensureUser, resetRuntime, youFor } from "./rounds"

const address = "dd".repeat(32)
const token = "a".repeat(64)

function bindTestHttp() {
  bindHttp({
    config: () => ({ chainKey: "near-testnet" }) as never,
    markets: () => ({ defaultChainKey: "near-testnet", markets: [] }) as never,
    liveChains: () => ["near-testnet"],
    chainKey: () => "near-testnet",
    treasuryReport: () => null,
    fundingReport: async () => null,
    grantsOpen: () => true,
    mint: async () => {
      throw new Error("mint must not run while cooling")
    },
    withdraw: async () => {
      throw new Error("withdraw must not run while cooling")
    },
    publish: () => {},
    streamMetrics: () => ({}),
    serveUi: false,
    distDir: "",
  })
}

beforeEach(() => {
  marketPreferences.chain = "near-testnet"
  marketPreferences.grantMicros = 10_000_000
  marketPreferences.grantIntervalMs = 3_600_000
  resetNearRpcQuiet()
  resetNearCooldownForTest()
  resetRuntime()
  useDatabase(":memory:")
  withChain("near-testnet", () => {
    ensureUser(address)
  })
  getDb()
    .query("INSERT INTO sessions (chain_key, token, address, expires_at) VALUES (?, ?, ?, ?)")
    .run("near-testnet", token, address, Date.now() + 100_000)
  bindTestHttp()
})

afterEach(() => {
  resetNearCooldownForTest()
  resetNearRpcQuiet()
  resetRuntime()
  useDatabase(":memory:")
})

function authed(path: string, method = "POST", body?: unknown) {
  return new Request(`http://localhost${path}?chain=near-testnet`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

test("grant is gated with 503 and no slot is claimed while cooling", async () => {
  tripNearCooldown("test cooling")
  const response = await handle(authed("/api/grant"))
  expect(response.status).toBe(503)
  const body = (await response.json()) as Record<string, unknown>
  expect(body.code).toBe(NEAR_COOLDOWN_CODE)
  expect(typeof body.retryAfterMs).toBe("number")
  const pending = withChain("near-testnet", () => youFor(address)?.grantPending)
  expect(pending).toBeNull()
})

test("withdraw is gated with 503 while cooling", async () => {
  withChain("near-testnet", () => {
    getDb()
      .query("UPDATE users SET balance_micros = ? WHERE chain_key = ? AND address = ?")
      .run(5_000_000, "near-testnet", address)
  })
  tripNearCooldown("test cooling")
  const response = await handle(authed("/api/withdraw", "POST", { amount: "1" }))
  expect(response.status).toBe(503)
  const body = (await response.json()) as Record<string, unknown>
  expect(body.code).toBe(NEAR_COOLDOWN_CODE)
  const balance = withChain("near-testnet", () => youFor(address)?.balanceMicros)
  expect(balance).toBe(5_000_000)
})

test("state exposes nearFunding cooling and timer", async () => {
  tripNearCooldown("test cooling")
  const response = await handle(authed("/api/state", "GET"))
  expect(response.status).toBe(200)
  const body = (await response.json()) as { nearFunding?: { cooling?: unknown; retryAfterMs?: unknown; untilMs?: unknown } }
  expect(body.nearFunding?.cooling).toBe(true)
  expect(typeof body.nearFunding?.retryAfterMs).toBe("number")
  expect(typeof body.nearFunding?.untilMs).toBe("number")
})
