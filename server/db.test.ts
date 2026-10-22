import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getDb, useDatabase } from "./db"

let dir: string | null = null

afterEach(() => {
  useDatabase(":memory:")
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function indexNames(table: string): string[] {
  const rows = getDb().query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table) as {
    name: string
  }[]
  return rows.map((row) => row.name)
}

test("renaming bets keeps the ledger indexes and fills round source", () => {
  dir = mkdtempSync(join(tmpdir(), "qm-db-"))
  const path = join(dir, "market.sqlite")
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE bets (
      id TEXT PRIMARY KEY,
      round_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      side TEXT NOT NULL,
      stake_micros INTEGER NOT NULL,
      payout_micros INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(round_id, address)
    );
    CREATE INDEX bets_round ON bets(round_id);
    CREATE INDEX bets_round_time ON bets(round_id, created_at);
    CREATE INDEX bets_address ON bets(address);
    INSERT INTO bets (id, round_id, address, side, stake_micros, created_at)
    VALUES ('b1', 7, '0xabc', 'up', 100, 1);
    CREATE TABLE rounds (
      id INTEGER PRIMARY KEY,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      strike TEXT,
      settle TEXT,
      status TEXT NOT NULL,
      fee_micros INTEGER NOT NULL DEFAULT 0,
      winning_side TEXT,
      resolution TEXT,
      pool_up_micros INTEGER NOT NULL DEFAULT 0,
      pool_down_micros INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO rounds (id, starts_at, ends_at, status) VALUES (7, 1700000000000, 1700000005000, 'settled');
    CREATE TABLE ticks (
      second_ts INTEGER PRIMARY KEY,
      price TEXT NOT NULL,
      source TEXT NOT NULL,
      exchange_ts INTEGER NOT NULL
    );
    INSERT INTO ticks (second_ts, price, source, exchange_ts) VALUES (1700000000, '1', 'binance', 1700000000000);
  `)
  legacy.close()

  useDatabase(path)
  const names = indexNames("buy_ins")
  expect(names).toContain("bets_round")
  expect(names).toContain("bets_round_time")
  expect(names).toContain("bets_address")
  expect(names).not.toContain("buy_ins_round")
  expect(names).not.toContain("buy_ins_round_time")
  expect(names).not.toContain("buy_ins_address")
  expect(getDb().query("SELECT id FROM buy_ins WHERE round_id = 7").get()).toEqual({ id: "b1" })
  expect(getDb().query("SELECT source FROM rounds WHERE id = 7").get()).toEqual({ source: "binance" })
  expect(getDb().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bets'").get()).toBeNull()
})

test("a new database indexes buy-ins without a second round_id index", () => {
  useDatabase(":memory:")
  const names = indexNames("buy_ins")
  expect(names).toContain("buy_ins_round_time")
  expect(names).toContain("buy_ins_address")
  expect(names).not.toContain("buy_ins_round")
  getDb()
    .query("INSERT INTO buy_ins (id, round_id, address, side, stake_micros, created_at) VALUES ('b1', 1, '0xabc', 'up', 100, 1)")
    .run()
  expect(getDb().query("SELECT id FROM buy_ins WHERE address = ?").get("0xabc")).toEqual({ id: "b1" })
})
