import { beforeEach, expect, test } from "bun:test"
import { applyDeposit, pollDeposits, treasuryFaultMessage } from "./custody"
import { getDb, migrateCustody, useDatabase } from "./db"
import { credit, youFor } from "./rounds"

const treasury = `0x${"11".repeat(20)}`
const from = `0x${"22".repeat(20)}`

beforeEach(() => {
  useDatabase(":memory:")
})

test("a deposit credits the sender once", () => {
  const input = { treasury, txHash: "0xabc", logIndex: 0, from, to: treasury, amountMicros: 5_000_000 }
  expect(applyDeposit(input)).toBe(true)
  expect(applyDeposit(input)).toBe(false)
  expect(youFor(from)?.balanceMicros).toBe(5_000_000)
})

test("a mint to the treasury is not a deposit", () => {
  expect(
    applyDeposit({
      treasury,
      txHash: "0xmint",
      logIndex: 2,
      from: `0x${"00".repeat(20)}`,
      to: treasury,
      amountMicros: 5_000_000,
    }),
  ).toBe(false)
  expect(youFor(`0x${"00".repeat(20)}`)).toBeNull()
})

test("a transfer to any other address is ignored", () => {
  expect(applyDeposit({ treasury, txHash: "0xdef", logIndex: 1, from, to: `0x${"33".repeat(20)}`, amountMicros: 5_000_000 })).toBe(false)
  expect(youFor(from)).toBeNull()
})

test("custody migration zeros demo balances and drops open bets", () => {
  const who = `0x${"44".repeat(20)}`
  credit(who, 5_000_000)
  const db = getDb()
  db.query("INSERT INTO rounds (id, starts_at, ends_at, status) VALUES (1, 0, 1, 'open')").run()
  db.query("INSERT INTO rounds (id, starts_at, ends_at, status) VALUES (2, 0, 1, 'settled')").run()
  db.query("INSERT INTO buy_ins (id, round_id, address, side, stake_micros, created_at) VALUES ('open', 1, ?, 'up', 100, 0)").run(who)
  db.query("INSERT INTO buy_ins (id, round_id, address, side, stake_micros, created_at) VALUES ('done', 2, ?, 'up', 100, 0)").run(who)
  db.query("DELETE FROM meta WHERE key = 'custody_v1'").run()
  migrateCustody(db)
  expect(youFor(who)?.balanceMicros).toBe(0)
  const bets = db.query("SELECT id FROM buy_ins ORDER BY id").all() as { id: string }[]
  expect(bets.map((bet) => bet.id)).toEqual(["done"])
})

test("a treasury with no ETH reports the gas failure", () => {
  expect(treasuryFaultMessage(new Error("insufficient funds for gas * price + value"), "Base Sepolia")).toBe(
    "Treasury needs Base Sepolia ETH for gas.",
  )
  expect(treasuryFaultMessage(new Error("nonce too low"), "Base Sepolia")).toBe("Treasury could not prepare the withdraw")
})

test("pollDeposits credits a transfer that landed ahead of the cursor", async () => {
  const db = getDb()
  db.query("INSERT INTO meta (key, value) VALUES ('deposit_block', '100')").run()
  await pollDeposits(
    {
      getBlockNumber: async () => 110n,
      getLogs: (async () => [
        {
          args: { from, value: 20_000_000n },
          logIndex: 4,
          transactionHash: `0x${"ab".repeat(32)}`,
        },
      ]) as never,
    },
    { usdc: `0x${"55".repeat(20)}` },
    treasury as `0x${string}`,
  )
  expect(youFor(from)?.balanceMicros).toBe(20_000_000)
  const saved = db.query("SELECT value FROM meta WHERE key = 'deposit_block'").get() as { value: string } | null
  expect(saved?.value).toBe("107")
})

test("pollDeposits reads only the configured token", async () => {
  const usdc = `0x${"66".repeat(20)}`
  getDb().query("INSERT INTO meta (key, value) VALUES ('deposit_block', '1')").run()
  let seen = ""
  await pollDeposits(
    {
      getBlockNumber: async () => 5n,
      getLogs: (async (params: { address: string }) => {
        seen = params.address
        return []
      }) as never,
    },
    { usdc: usdc as `0x${string}` },
    treasury as `0x${string}`,
  )
  expect(seen.toLowerCase()).toBe(usdc)
  expect(seen.toLowerCase()).not.toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7e")
})

test("pollDeposits chunks eth_getLogs into ranges of at most 200 blocks", async () => {
  const db = getDb()
  db.query("INSERT INTO meta (key, value) VALUES ('deposit_block', '100')").run()
  const ranges: [bigint, bigint][] = []
  await pollDeposits(
    {
      getBlockNumber: async () => 553n,
      getLogs: (async (params: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([params.fromBlock, params.toBlock])
        return []
      }) as never,
    },
    { usdc: `0x${"55".repeat(20)}` },
    treasury as `0x${string}`,
  )
  expect(ranges).toEqual([
    [101n, 300n],
    [301n, 500n],
    [501n, 550n],
  ])
  for (const [start, end] of ranges) {
    expect(end - start <= 199n).toBe(true)
  }
  const saved = db.query("SELECT value FROM meta WHERE key = 'deposit_block'").get() as { value: string } | null
  expect(saved?.value).toBe("550")
})
