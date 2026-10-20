import { beforeEach, expect, test } from "bun:test"
import { getDb, useDatabase } from "./db"
import { loadMarket } from "../shared/market"
import { applyGrant, cutoverAmount, grantDue, grantOnSignIn, grantSettings } from "./grant"
import { youFor } from "./rounds"

const who = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const hour = 60 * 60 * 1000

beforeEach(() => {
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

test("a failed mint does not change the balance", async () => {
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
  expect(youFor(who)).toBeNull()
})

test("a bot session does not take the grant", async () => {
  getDb().query("INSERT INTO users (address, balance_micros, created_at, is_bot) VALUES (?, 0, 0, 1)").run(who)
  let minted = false
  const credited = await applyGrant({
    address: who,
    now: 0,
    chainKey: "base-sepolia",
    amount: 100_000_000,
    intervalMs: hour,
    mint: async () => {
      minted = true
    },
  })
  expect(credited).toBe(false)
  expect(minted).toBe(false)
  expect(youFor(who)?.balanceMicros).toBe(0)
  expect(youFor(who)?.grantAt).toBeNull()
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
