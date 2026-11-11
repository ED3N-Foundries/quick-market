import { afterEach, expect, test } from "bun:test"
import { CHAINS } from "../shared/chain"
import { describeTreasury } from "../shared/near"
import { getDb, useDatabase } from "./db"
import { collectFunding, type EvmBalances } from "./funding"

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
  expect(nearChain?.shortAgents.map((row) => row.account)).toEqual([nearAccount])
  expect(nearChain?.explorer).toBe("https://testnet.nearblocks.io/address/treasury.testnet")

  const body = JSON.stringify(report)
  expect(body).not.toContain("privateKey")
  expect(body).not.toContain("ed25519:")
  expect(body).not.toMatch(/0x[0-9a-fA-F]{64}/)
})
