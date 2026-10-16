import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { privateKeyToAccount } from "viem/accounts"
import { CHAINS } from "../shared/chain"
import {
  formatEth,
  formatUsd,
  latestMovements,
  movementsFromFeeds,
  movementsFromUsdcLogs,
  planTreasury,
  readLedger,
  renderTreasury,
  rpcFor,
  type ChainFunds,
  type LedgerSnapshot,
  type Movement,
  type TreasuryReport,
} from "./treasury"

const generated = `0x${"ab".repeat(32)}` as `0x${string}`
const existing = `0x${"cd".repeat(32)}` as `0x${string}`
const fromEnv = `0x${"11".repeat(32)}` as `0x${string}`

test("planTreasury fills an empty treasury line and leaves the rest", () => {
  const source = "CHAIN=base-sepolia\nTREASURY_PRIVATE_KEY=\nRPC_URL=\n"
  const plan = planTreasury(source, undefined, generated)
  expect(plan).toEqual({
    action: "write",
    text: `CHAIN=base-sepolia\nTREASURY_PRIVATE_KEY=${generated}\nRPC_URL=\n`,
    address: privateKeyToAccount(generated).address,
  })
})

test("planTreasury appends the key when the line is missing", () => {
  const plan = planTreasury("CHAIN=base-sepolia\n", undefined, generated)
  expect(plan).toEqual({
    action: "write",
    text: `CHAIN=base-sepolia\nTREASURY_PRIVATE_KEY=${generated}\n`,
    address: privateKeyToAccount(generated).address,
  })
})

test("planTreasury keeps an existing key", () => {
  const source = `FEE_BPS=0\nTREASURY_PRIVATE_KEY=${existing}\n`
  const plan = planTreasury(source, undefined, generated)
  expect(plan).toEqual({ action: "keep", address: privateKeyToAccount(existing).address })
})

test("planTreasury keeps the file key when the environment repeats it", () => {
  const source = `TREASURY_PRIVATE_KEY=${existing}\n`
  const plan = planTreasury(source, existing.toUpperCase().replace("0X", "0x"), generated)
  expect(plan).toEqual({ action: "keep", address: privateKeyToAccount(existing).address })
})

test("planTreasury refuses an environment key that is not in the file", () => {
  const plan = planTreasury("TREASURY_PRIVATE_KEY=\n", fromEnv, generated)
  expect(plan).toEqual({ action: "refuse", address: privateKeyToAccount(fromEnv).address })
  expect(JSON.stringify(plan)).not.toContain(generated)
})

test("planTreasury does not overwrite a damaged key", () => {
  expect(planTreasury("TREASURY_PRIVATE_KEY=nope\n", undefined, generated)).toEqual({ action: "invalid" })
  expect(planTreasury("TREASURY_PRIVATE_KEY=\n", "nope", generated)).toEqual({ action: "invalid" })
})

const treasury = "0x1111111111111111111111111111111111111111"
const payer = "0x2222222222222222222222222222222222222222"
const payee = "0x3333333333333333333333333333333333333333"
const usdc = CHAINS["base-sepolia"].usdc
const hash = (byte: string) => `0x${byte.repeat(32)}`

test("rpcFor applies RPC_URL only to the configured chain", () => {
  expect(rpcFor(CHAINS.base, "base-sepolia", "https://example.test")).toBe(CHAINS.base.rpc)
  expect(rpcFor(CHAINS["base-sepolia"], "base-sepolia", " https://example.test ")).toBe("https://example.test")
  expect(rpcFor(CHAINS.base, "base", "  ")).toBe(CHAINS.base.rpc)
})

test("formatUsd and formatEth keep exact dust and group thousands", () => {
  expect(formatUsd(0n)).toBe("$0.00")
  expect(formatUsd(1_500_000n)).toBe("$1.50")
  expect(formatUsd(1_234_567n)).toBe("$1.234567")
  expect(formatUsd(-1_000_000n)).toBe("-$1.00")
  expect(formatUsd(1_000_000_000n)).toBe("$1,000.00")
  expect(formatEth(0n)).toBe("0.0")
  expect(formatEth(1_000_000_000_000_000n)).toBe("0.001")
  expect(formatEth(1_230_000_000_000_000_000n)).toBe("1.23")
  expect(formatEth(1n)).toBe("0.000000000000000001")
})

test("movementsFromFeeds merges a withdrawal and keeps a deposit the transaction list cannot see", () => {
  const withdraw = hash("ab")
  const deposit = hash("cd")
  const rows = movementsFromFeeds({
    chainName: "Base Sepolia",
    treasury,
    usdc,
    transactions: {
      items: [
        {
          hash: withdraw,
          timestamp: "2026-10-15T00:00:02.000000Z",
          block_number: 8,
          value: "0",
          from: { hash: treasury },
          to: { hash: usdc },
          status: "ok",
          method: "transfer",
        },
        {
          hash: hash("ef"),
          timestamp: "2026-10-15T00:00:03.000000Z",
          block_number: 9,
          value: "0",
          from: { hash: payer },
          to: { hash: treasury },
          status: "ok",
          method: null,
        },
        {
          hash: hash("11"),
          timestamp: "2026-10-15T00:00:04.000000Z",
          block_number: 10,
          value: "1000000000000000",
          from: { hash: payer },
          to: { hash: treasury },
          status: "ok",
        },
        {
          hash: hash("22"),
          timestamp: "2026-10-15T00:00:01.000000Z",
          block_number: 7,
          value: "0",
          from: { hash: treasury },
          to: { hash: usdc },
          status: "error",
          method: "transfer",
        },
      ],
    },
    transfers: {
      items: [
        {
          transaction_hash: withdraw,
          timestamp: "2026-10-15T00:00:02.000000Z",
          block_number: 8,
          from: { hash: treasury },
          to: { hash: payee },
          token: { address_hash: usdc, decimals: "6", symbol: "USDC" },
          total: { value: "10000000", decimals: "6" },
        },
        {
          transaction_hash: deposit,
          timestamp: "2026-10-15T00:00:05.000000Z",
          block_number: 11,
          from: { hash: payer },
          to: { hash: treasury },
          token: { address_hash: usdc, decimals: "6" },
          total: { value: "2500000", decimals: "6" },
        },
        {
          transaction_hash: hash("33"),
          timestamp: "2026-10-15T00:00:06.000000Z",
          block_number: 12,
          from: { hash: payer },
          to: { hash: treasury },
          token: { address_hash: "0x4444444444444444444444444444444444444444", decimals: "18", symbol: "SPAM" },
          total: { value: "1", decimals: "18" },
        },
      ],
    },
  })
  expect(rows.map((row) => row.hash)).toEqual([withdraw, hash("11"), hash("22"), deposit])
  expect(rows[0]).toMatchObject({ usdcMicros: -10_000_000n, ethWei: 0n, ok: true, parties: [payee] })
  expect(rows[1]).toMatchObject({ ethWei: 1_000_000_000_000_000n, usdcMicros: 0n, parties: [payer] })
  expect(rows[2]).toMatchObject({ ok: false, label: "transfer", usdcMicros: 0n, ethWei: 0n })
  expect(rows[3]).toMatchObject({ usdcMicros: 2_500_000n, parties: [payer] })
})

test("movementsFromUsdcLogs nets both legs of one transaction", () => {
  const rows = movementsFromUsdcLogs("Base", treasury, [
    { block: 4n, hash: hash("aa"), from: payer, to: treasury, amount: 5_000_000n, timeMs: 2_000 },
    { block: 4n, hash: hash("aa"), from: treasury, to: payee, amount: 2_000_000n, timeMs: 2_000 },
  ])
  expect(rows).toEqual([
    {
      chainName: "Base",
      timeMs: 2_000,
      block: 4n,
      hash: hash("aa"),
      usdcMicros: 3_000_000n,
      ethWei: 0n,
      parties: [payer, payee],
      ok: true,
      label: null,
    },
  ])
})

test("latestMovements keeps the ten newest across chains", () => {
  const rows: Movement[] = Array.from({ length: 12 }, (_, index) => ({
    chainName: index % 2 === 0 ? "Base" : "Base Sepolia",
    timeMs: index * 1_000,
    block: BigInt(index),
    hash: hash(index.toString(16).padStart(2, "0")),
    usdcMicros: 1n,
    ethWei: 0n,
    parties: [],
    ok: true,
    label: null,
  }))
  const latest = latestMovements(rows)
  expect(latest).toHaveLength(10)
  expect(latest[0]?.timeMs).toBe(11_000)
  expect(latest.at(-1)?.timeMs).toBe(2_000)
})

function funds(chain: (typeof CHAINS)[keyof typeof CHAINS], configured: boolean, ethWei: bigint, usdcMicros: bigint): ChainFunds {
  return {
    key: chain.key,
    name: chain.name,
    id: chain.id,
    configured,
    rpc: chain.rpc,
    usdc: chain.usdc,
    block: 100n,
    blockTimeMs: Date.parse("2026-10-15T00:00:00.000Z"),
    ethWei,
    usdcMicros,
    sentTxs: 1,
    error: null,
    ethError: null,
    usdcError: null,
  }
}

function report(ledger: LedgerSnapshot, sepoliaEth: bigint, sepoliaUsdc: bigint, baseUsdc: bigint): TreasuryReport {
  return {
    address: treasury,
    configured: CHAINS["base-sepolia"],
    rpc: CHAINS["base-sepolia"].rpc,
    chains: [funds(CHAINS["base-sepolia"], true, sepoliaEth, sepoliaUsdc), funds(CHAINS.base, false, 0n, baseUsdc)],
    ledger,
    movements: [],
    historyNotes: ["Base transfers unavailable: HTTP 403."],
  }
}

const emptyLedger: LedgerSnapshot = {
  path: "data/quick-market.sqlite",
  spendableMicros: 2_000_000,
  openStakeMicros: 500_000,
  pendingMicros: 0,
  pendingCount: 0,
  users: 1,
  deposits: 0,
  withdrawals: 0,
  entries: [],
}

test("renderTreasury states coverage, gas, and funds on the other network", () => {
  const ahead = renderTreasury(report(emptyLedger, 50_000_000_000_000n, 3_000_000n, 0n))
  expect(ahead).toContain("Treasury summary")
  expect(ahead).toContain("Base Sepolia (84532)  configured")
  expect(ahead).toContain("Base (8453)")
  expect(ahead).toContain("Owed           $2.50")
  expect(ahead).toContain("On-chain USDC  $3.00 on Base Sepolia")
  expect(ahead).toContain("Ahead of owed  $0.50")
  expect(ahead).not.toContain("under 0.00005")
  expect(ahead).not.toContain("no ETH")

  const short = renderTreasury(report({ ...emptyLedger, pendingCount: 1, pendingMicros: 1_000_000 }, 0n, 1_000_000n, 4_000_000n))
  expect(short).toContain("Short of owed  -$1.50")
  expect(short).toContain("Base Sepolia has no ETH for withdrawal gas.")
  expect(short).toContain("Base holds 4.00 USDC. This process uses Base Sepolia.")
  expect(short).toContain("Pending withdrawals are already removed from spendable and may still be in the wallet.")
  expect(short).toContain("Base transfers unavailable: HTTP 403.")
  expect(short).toContain("No deposits or withdrawals.")
  expect(short).toContain("No transfers found.")
})

test("readLedger sums spendable, open stakes, and the newest book rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "treasury-"))
  const path = join(dir, "market.sqlite")
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE users (address TEXT PRIMARY KEY, balance_micros INTEGER NOT NULL);
      CREATE TABLE rounds (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE bets (id TEXT PRIMARY KEY, round_id INTEGER NOT NULL, address TEXT NOT NULL, stake_micros INTEGER NOT NULL);
      CREATE TABLE deposits (tx_hash TEXT, log_index INTEGER, address TEXT, amount_micros INTEGER, created_at INTEGER);
      CREATE TABLE withdrawals (id TEXT, address TEXT, amount_micros INTEGER, tx_hash TEXT, status TEXT, created_at INTEGER);
    `)
    db.exec(`
      INSERT INTO users VALUES ('${payer}', 4000000), ('${payee}', 6000000);
      INSERT INTO rounds VALUES (1, 'open'), (2, 'settled');
      INSERT INTO bets VALUES ('open', 1, '${payer}', 2500000), ('done', 2, '${payer}', 9000000);
      INSERT INTO deposits VALUES ('${hash("a1")}', 0, '${payer}', 5000000, 100), ('${hash("a2")}', 0, '${payer}', 2000000, 200);
      INSERT INTO withdrawals VALUES
        ('w1', '${payee}', 1000000, '${hash("b1")}', 'pending', 300),
        ('w2', '${payee}', 9000000, NULL, 'sent', 50);
    `)
    db.close()
    const ledger = readLedger(path)
    expect(ledger).toEqual({
      path,
      spendableMicros: 10_000_000,
      openStakeMicros: 2_500_000,
      pendingMicros: 1_000_000,
      pendingCount: 1,
      users: 2,
      deposits: 2,
      withdrawals: 2,
      entries: [
        { direction: "out", kind: "withdraw", address: payee, amountMicros: 1_000_000, txHash: hash("b1"), status: "pending", createdAt: 300 },
        { direction: "in", kind: "deposit", address: payer, amountMicros: 2_000_000, txHash: hash("a2"), status: "credited", createdAt: 200 },
        { direction: "in", kind: "deposit", address: payer, amountMicros: 5_000_000, txHash: hash("a1"), status: "credited", createdAt: 100 },
        { direction: "out", kind: "withdraw", address: payee, amountMicros: 9_000_000, txHash: null, status: "sent", createdAt: 50 },
      ],
    })
    expect(readLedger(join(dir, "missing.sqlite"))).toEqual({ path: join(dir, "missing.sqlite"), missing: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
