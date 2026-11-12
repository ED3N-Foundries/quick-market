import { beforeEach, expect, test } from "bun:test"
import { getDb, useDatabase } from "./db"
import { GRANT_FOLLOW_MS, MINT_CONFIRMATIONS } from "../shared/mint"
import { loadMarket, marketPreferences } from "../shared/market"
import { applyGrant, cutoverAmount, grantDue, grantOnSignIn, grantSettings, noteGrantTx, resumePendingGrants, settleGrantRequest } from "./grant"
import { youFor } from "./rounds"

const who = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const hour = 60 * 60 * 1000

beforeEach(() => {
  marketPreferences.chain = "base-sepolia"
  useDatabase(":memory:")
})

test("a grant is 100, skips the same hour, and does not bank missed hours", async () => {
  const minted: number[] = []
  const mint = async (amount: number) => {
    minted.push(amount)
  }
  const input = { address: who, chainKey: "base-sepolia" as const, amount: 100_000_000, intervalMs: hour, mint }
  expect(await applyGrant({ ...input, now: 0 })).toBe(true)
  expect(await applyGrant({ ...input, now: hour - 1 })).toBe(false)
  expect(await applyGrant({ ...input, now: 5 * hour })).toBe(true)
  expect(youFor(who)?.balanceMicros).toBe(200_000_000)
  expect(youFor(who)?.grantAt).toBe(5 * hour)
  expect(minted).toEqual([100_000_000, 100_000_000])
})

test("a failed mint does not change the balance and clears the slot", async () => {
  const mint = async () => {
    throw new Error("rpc down")
  }
  await expect(
    applyGrant({
      address: who,
      now: 0,
      chainKey: "base-sepolia",
      amount: 100_000_000,
      intervalMs: hour,
      mint,
    }),
  ).rejects.toThrow("rpc down")
  expect(youFor(who)?.balanceMicros).toBe(0)
  expect(youFor(who)?.grantAt).toBeNull()
  expect(youFor(who)?.grantPending).toBeNull()
  const again = await applyGrant({
    address: who,
    now: 1,
    chainKey: "base-sepolia",
    amount: 100_000_000,
    intervalMs: hour,
    mint: async () => {},
  })
  expect(again).toBe(true)
  expect(youFor(who)?.balanceMicros).toBe(100_000_000)
})

test("a second grant does not mint while one is still in flight", async () => {
  const hash = `0x${"ab".repeat(32)}`
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let mints = 0
  const first = applyGrant({
    address: who,
    now: 0,
    chainKey: "base-sepolia",
    amount: 100_000_000,
    intervalMs: hour,
    mint: async () => {
      mints += 1
      noteGrantTx(who, hash)
      await gate
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(mints).toBe(1)
  expect(youFor(who)?.grantPending).toEqual({ startedAt: 0, txHash: hash, seen: 1, confirmations: MINT_CONFIRMATIONS })
  const second = await applyGrant({
    address: who,
    now: 0,
    chainKey: "base-sepolia",
    amount: 100_000_000,
    intervalMs: hour,
    mint: async () => {
      mints += 1
    },
  })
  expect(second).toBe(false)
  expect(mints).toBe(1)
  release()
  expect(await first).toBe(true)
  expect(youFor(who)?.grantPending).toBeNull()
  expect(youFor(who)?.grantAt).toBe(0)
  expect(youFor(who)?.balanceMicros).toBe(100_000_000)
})

test("a stale pending grant clears on read when this process is not minting", () => {
  const started = Date.now() - GRANT_FOLLOW_MS - 1
  getDb()
    .query(
      "INSERT INTO users (chain_key, address, balance_micros, created_at, grant_pending_at, grant_tx) VALUES ('base-sepolia', ?, 0, 0, ?, ?)",
    )
    .run(who, started, "0xabc")
  expect(youFor(who)?.grantPending).toBeNull()
  const row = getDb().query("SELECT grant_pending_at, grant_tx, grant_at FROM users WHERE address = ?").get(who) as {
    grant_pending_at: number | null
    grant_tx: string | null
    grant_at: number | null
  }
  expect(row.grant_pending_at).toBeNull()
  expect(row.grant_tx).toBeNull()
  expect(row.grant_at).toBeNull()
})

test("a pending grant stays while this process is still minting", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const now = Date.now()
  const first = applyGrant({
    address: who,
    now,
    chainKey: "base-sepolia",
    amount: 100_000_000,
    intervalMs: hour,
    mint: async () => {
      await gate
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  getDb()
    .query("UPDATE users SET grant_pending_at = ? WHERE address = ?")
    .run(Date.now() - GRANT_FOLLOW_MS - 1, who)
  expect(youFor(who)?.grantPending?.confirmations).toBe(MINT_CONFIRMATIONS)
  release()
  expect(await first).toBe(true)
})



test("NEAR testnet grants the same way as Base Sepolia", async () => {
  marketPreferences.chain = "near-testnet"
  const account = "ab".repeat(32)
  const minted: number[] = []
  const credited = await applyGrant({
    address: account,
    now: 0,
    chainKey: "near-testnet",
    amount: 100_000_000,
    intervalMs: hour,
    mint: async (amount) => {
      minted.push(amount)
    },
  })
  expect(credited).toBe(true)
  expect(minted).toEqual([100_000_000])
  expect(youFor(account)?.balanceMicros).toBe(100_000_000)
})

test("Base does not grant", async () => {
  let minted = false
  const credited = await applyGrant({
    address: who,
    now: 0,
    chainKey: "base",
    amount: 100_000_000,
    intervalMs: hour,
    mint: async () => {
      minted = true
    },
  })
  expect(credited).toBe(false)
  expect(minted).toBe(false)
  expect(youFor(who)).toBeNull()
})

test("a broadcast hash is pending while the mint is still confirming", async () => {
  let release: (granted: boolean) => void = () => {}
  const done = new Promise<boolean>((resolve) => {
    release = resolve
  })
  let report: (hash: string) => void = () => {}
  const hash = new Promise<string>((resolve) => {
    report = resolve
  })
  const pending = settleGrantRequest({ done, hash })
  report("0xabc")
  await expect(pending).resolves.toEqual({ kind: "pending", txHash: "0xabc" })
  release(true)
  await expect(done).resolves.toBe(true)
})

test("a grant that finishes without a hash is done", async () => {
  const settled = await settleGrantRequest({
    done: Promise.resolve(false),
    hash: new Promise<string>(() => {}),
  })
  expect(settled).toEqual({ kind: "done", value: false })
})

test("grant progress moves from zero to the hash and then up to three", async () => {
  const hash = `0x${"cd".repeat(32)}`
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const done = applyGrant({
    address: who,
    now: 0,
    chainKey: "base-sepolia",
    amount: 100_000_000,
    intervalMs: hour,
    mint: async (_amount, progress) => {
      expect(youFor(who)?.grantPending).toEqual({ startedAt: 0, txHash: null, seen: 0, confirmations: MINT_CONFIRMATIONS })
      progress({ txHash: hash, seen: 1 })
      progress({ seen: 2 })
      progress({ seen: 1 })
      expect(youFor(who)?.grantPending?.seen).toBe(2)
      await gate
      progress({ seen: 3 })
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(youFor(who)?.grantPending?.seen).toBe(2)
  expect(youFor(who)?.grantPending?.txHash).toBe(hash)
  release()
  expect(await done).toBe(true)
  expect(youFor(who)?.grantPending).toBeNull()
  expect(youFor(who)?.balanceMicros).toBe(100_000_000)
})

test("a resumed hash is watched and credited without minting again", async () => {
  const hash = `0x${"ef".repeat(32)}`
  getDb()
    .query(
      "INSERT INTO users (chain_key, address, balance_micros, created_at, grant_pending_at, grant_tx, grant_seen) VALUES ('base-sepolia', ?, 0, 0, ?, ?, 1)",
    )
    .run(who, 40, hash)
  let watched = ""
  await resumePendingGrants({
    chainKey: "base-sepolia",
    amount: 100_000_000,
    watch: async (got, report) => {
      watched = got
      report({ seen: 2 })
      expect(youFor(who)?.grantPending?.seen).toBe(2)
      report({ seen: 3 })
    },
  })
  expect(watched).toBe(hash)
  expect(youFor(who)?.grantPending).toBeNull()
  expect(youFor(who)?.grantAt).toBe(40)
  expect(youFor(who)?.balanceMicros).toBe(100_000_000)
})

test("a pending grant with no hash is cleared on resume", async () => {
  getDb()
    .query("INSERT INTO users (chain_key, address, balance_micros, created_at, grant_pending_at) VALUES ('base-sepolia', ?, 0, 0, ?)")
    .run(who, Date.now())
  await resumePendingGrants({
    chainKey: "base-sepolia",
    amount: 100_000_000,
    watch: async () => {
      throw new Error("no hash to watch")
    },
  })
  expect(youFor(who)?.grantPending).toBeNull()
  expect(youFor(who)?.balanceMicros).toBe(0)
  expect(youFor(who)?.grantAt).toBeNull()
})

test("grant timing and cutover are pure", () => {
  expect(grantDue(null, 5_000, hour)).toBe(true)
  expect(grantDue(0, hour - 1, hour)).toBe(false)
  expect(grantDue(0, hour, hour)).toBe(true)
  expect(grantOnSignIn(null)).toBe(true)
  expect(grantOnSignIn(0)).toBe(false)
  expect(grantOnSignIn(hour)).toBe(false)
  expect(grantSettings()).toEqual({ amount: 100_000_000, intervalMs: 2 * 60 * 1000 })
  expect(cutoverAmount(null, 40)).toBe(40)
  expect(cutoverAmount(null, 0)).toBe(0)
  expect(cutoverAmount("40", 40)).toBeNull()
  expect(() => cutoverAmount(null, -1)).toThrow("Balance sum")
  expect(() => loadMarket({ GRANT_MICROS: "nope" })).toThrow("GRANT_MICROS")
})
