import { beforeEach, expect, test } from "bun:test"
import { applyDeposit } from "./custody"
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
  db.query("INSERT INTO bets (id, round_id, address, side, stake_micros, created_at) VALUES ('open', 1, ?, 'up', 100, 0)").run(who)
  db.query("INSERT INTO bets (id, round_id, address, side, stake_micros, created_at) VALUES ('done', 2, ?, 'up', 100, 0)").run(who)
  db.query("DELETE FROM meta WHERE key = 'custody_v1'").run()
  migrateCustody(db)
  expect(youFor(who)?.balanceMicros).toBe(0)
  const bets = db.query("SELECT id FROM bets ORDER BY id").all() as { id: string }[]
  expect(bets.map((bet) => bet.id)).toEqual(["done"])
})
