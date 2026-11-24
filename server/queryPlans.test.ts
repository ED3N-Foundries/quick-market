import { expect, test } from "bun:test"
import { getDb, useDatabase } from "./db"
import { BOARD_ROUNDS_SQL, DUE_ROUNDS_SQL, OPEN_BUY_INS_SQL, OPEN_ROUNDS_SQL, STRIKE_ROUNDS_SQL } from "./rounds"
import { TAPE_MS } from "./config"

const CHAIN = "base-sepolia"
const WINDOW = 10_000
const T = 10_000_000_000_000
const ROUNDS = 100_000
const BUY_INS = 600_000
const TARGET = `0x${"ab".repeat(20)}`

function plan(sql: string, ...params: (string | number)[]): string {
  const rows = getDb().query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
  return rows.map((row) => row.detail).join(" | ")
}

test("a 100k-round fixture uses indexes for open buy-ins, board, advance, and strike", () => {
  useDatabase(":memory:")
  const db = getDb()
  const openId = ROUNDS - 1
  const insertRound = db.query(
    `INSERT INTO rounds (chain_key, id, starts_at, ends_at, status, strike, pool_up_micros, pool_down_micros)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
  )
  const insertBet = db.query(
    "INSERT INTO buy_ins (chain_key, round_id, address, side, stake_micros, created_at) VALUES (?, ?, ?, 'up', ?, ?)",
  )
  const load = db.transaction(() => {
    for (let index = 0; index < ROUNDS; index++) {
      const id = index + 1
      const startsAt = T - (ROUNDS - id) * WINDOW
      const open = id >= openId
      const strike = open ? null : String(100 + (id % 50))
      insertRound.run(CHAIN, id, startsAt, startsAt + WINDOW, open ? "open" : "settled", strike)
    }
    let made = 0
    for (let index = 0; index < ROUNDS && made < BUY_INS; index++) {
      const id = index + 1
      // Six distinct wallets per round. Only the two open rounds carry TARGET.
      for (let slot = 0; slot < 6 && made < BUY_INS; slot++, made++) {
        const address = id >= openId && slot === 0 ? TARGET : `0x${(made + 1).toString(16).padStart(40, "0")}`
        insertBet.run(CHAIN, id, address, 1_000_000 + slot, T - (ROUNDS - id) * WINDOW)
      }
    }
  })
  load()
  // The production migration analyzes after the indexes exist on a full ledger.
  db.exec("ANALYZE")

  const openPlan = plan(OPEN_BUY_INS_SQL, TARGET, CHAIN)
  expect(openPlan).toMatch(/sqlite_autoindex_buy_ins_\d+/)
  expect(openPlan).not.toContain("SCAN buy_ins")

  const boardPlan = plan(BOARD_ROUNDS_SQL, CHAIN, T - TAPE_MS)
  expect(boardPlan).toContain("rounds_ends")
  expect(boardPlan).not.toContain("SCAN rounds")

  const duePlan = plan(DUE_ROUNDS_SQL, CHAIN, T)
  expect(duePlan).toContain("rounds_open_ends")
  expect(duePlan).not.toContain("SCAN rounds")

  const strikePlan = plan(STRIKE_ROUNDS_SQL, CHAIN, T)
  expect(strikePlan).toContain("rounds_open_strike")
  expect(strikePlan).not.toContain("SCAN rounds")

  const voidPlan = plan(OPEN_ROUNDS_SQL, CHAIN)
  expect(voidPlan).toContain("rounds_open_ends")
  expect(voidPlan).not.toContain("SCAN rounds")

  // The open lookup returns only the two rounds that actually hold TARGET.
  const rows = db.query(OPEN_BUY_INS_SQL).all(TARGET, CHAIN) as { id: number; side: string; stake_micros: number }[]
  expect(rows).toHaveLength(2)
  expect(rows.every((row) => row.id >= openId)).toBe(true)
}, 30_000)
