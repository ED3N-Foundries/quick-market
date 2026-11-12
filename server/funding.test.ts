import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"
import { CHAINS } from "../shared/chain"
import { describeTreasury } from "../shared/near"
import { getDb, useDatabase } from "./db"
import { collectFunding, type EvmBalances } from "./funding"
import { bindHttp, handle, handleInternal } from "./http"

afterEach(() => {
  useDatabase(":memory:")
})

function agent(id: string) {
  return { account: id, holding: { exists: false, nearYocto: 0n, tokenMicros: 0n } }
}

test("funding shows public addresses, the gap, and no key material", async () => {
  useDatabase(":memory:")
  const db = getDb()
  db.query("INSERT INTO users (chain_key, address, balance_micros, created_at) VALUES (?, ?, ?, ?)").run(
    "base-sepolia",
    "0x1111111111111111111111111111111111111111",
    5_000_000,
    1,
  )
  db.query(
    "INSERT INTO rounds (chain_key, id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?)",
  ).run("base-sepolia", 1, 1, 2, "open")
  db.query(
    "INSERT INTO buy_ins (chain_key, id, round_id, address, side, stake_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("base-sepolia", "b1", 1, "0x1111111111111111111111111111111111111111", "up", 2_000_000, 1)

  const treasury = "0x826020c36F4e1b6320e5E3dCade1a888E9fbDeF6"
  const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
  const readEvm = async (): Promise<EvmBalances> => ({ nativeWei: 0n, tokenMicros: 1_000_000n, error: null })
  const nearAccount = "a".repeat(64)
  const near = describeTreasury({
    account: "treasury.testnet",
    treasury: { exists: true, nearYocto: 1n, tokenMicros: 1_000_000n },
    ledgerMicros: 5_000_000n,
    agents: [agent(nearAccount)],
  })
  const report = await collectFunding({
    now: 10,
    db,
    readEvm,
    chains: [
      { chain: CHAINS["base-sepolia"], treasury, token, tokenLabel: "QM USDC", near: null },
      {
        chain: CHAINS["near-testnet"],
        treasury: "treasury.testnet",
        token: "qm.testnet",
        tokenLabel: "QM",
        near,
      },
    ],
  })

  expect(report.at).toBe(10)
  const evm = report.chains[0]
  expect(evm?.treasury).toBe(treasury)
  expect(evm?.token).toBe(token)
  expect(evm?.native.short).toBe(true)
  expect(evm?.native.need).toBe("0.00005")
  expect(evm?.tokenBalance.have).toBe("1")
  expect(evm?.tokenBalance.need).toBe("7")
  expect(evm?.tokenBalance.short).toBe(true)
  expect(evm?.explorer).toBe(`https://sepolia.basescan.org/address/${treasury}`)
  const nearChain = report.chains[1]
  expect(nearChain?.treasury).toBe("treasury.testnet")
  expect(nearChain?.token).toBe("qm.testnet")
  expect(nearChain?.native.short).toBe(true)
  expect(nearChain?.tokenBalance.short).toBe(true)
  expect(nearChain?.shortAgents).toEqual([])
  expect(nearChain?.explorer).toBe("https://testnet.nearblocks.io/address/treasury.testnet")

  const body = JSON.stringify(report)
  expect(body).not.toContain("privateKey")
  expect(body).not.toContain("ed25519:")
  expect(body).not.toMatch(/0x[0-9a-fA-F]{64}/)
})

test("the public health route is liveness only", async () => {
  bindHttp({
    config: () => {
      throw new Error("config")
    },
    markets: () => {
      throw new Error("markets")
    },
    liveChains: () => ["base-sepolia"],
    chainKey: () => "base-sepolia",
    treasuryReport: () => {
      throw new Error("treasury")
    },
    fundingReport: async () => ({ at: 1, chains: [{ treasury: "treasury.testnet" }] }),
    grantsOpen: () => false,
    mint: async () => undefined,
    withdraw: async () => ({ ok: false }),
    publish: () => undefined,
    streamMetrics: () => ({}),
    serveUi: false,
    distDir: "/tmp/none",
  })
  const health = await handle(new Request("http://market/api/health"))
  expect(health.status).toBe(200)
  expect(await health.json()).toEqual({ ok: true })
  expect((await handle(new Request("http://market/api/status"))).status).toBe(404)
  expect((await handle(new Request("http://market/api/health/history"))).status).toBe(404)
  const funding = await handleInternal(new Request("http://market/api/funding"))
  expect(await funding.json()).toEqual({ at: 1, chains: [{ treasury: "treasury.testnet" }] })
})

test("removed ops routes do not fall through to the player page", async () => {
  const distDir = mkdtempSync(join(tmpdir(), "qm-dist-"))
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>Quick Market</title>")
  bindHttp({
    config: () => {
      throw new Error("config")
    },
    markets: () => {
      throw new Error("markets")
    },
    liveChains: () => ["base-sepolia"],
    chainKey: () => "base-sepolia",
    treasuryReport: () => {
      throw new Error("treasury")
    },
    fundingReport: async () => ({ at: 1, chains: [] }),
    grantsOpen: () => false,
    mint: async () => undefined,
    withdraw: async () => ({ ok: false }),
    publish: () => undefined,
    streamMetrics: () => ({}),
    serveUi: true,
    distDir,
  })
  const status = await handle(new Request("http://market/api/status"))
  expect(status.status).toBe(404)
  expect(await status.text()).not.toContain("Quick Market")
  const history = await handle(new Request("http://market/api/health/history"))
  expect(history.status).toBe(404)
  const home = await handle(new Request("http://market/"))
  expect(home.status).toBe(200)
  expect(await home.text()).toContain("Quick Market")
})
