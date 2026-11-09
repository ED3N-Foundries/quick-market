import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getDb, importLegacySwarm, useDatabase } from "./db"

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

test("legacy Base rows keep their balances and history under the chain-scoped schema", () => {
  dir = mkdtempSync(join(tmpdir(), "qm-db-"))
  const path = join(dir, "market.sqlite")
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE users (address TEXT PRIMARY KEY, balance_micros INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES ('0xabc', 42000000, 1);
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
    INSERT INTO ticks VALUES (1700000000, '1', 'binance', 1700000000000);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('custody_v1', '1'), ('deposit_block', '91');
  `)
  legacy.close()

  useDatabase(path)
  const names = indexNames("buy_ins")
  expect(names).toContain("buy_ins_round_time")
  expect(names).toContain("buy_ins_address")
  expect(getDb().query("SELECT id FROM buy_ins WHERE chain_key = 'base-sepolia' AND round_id = 7").get()).toEqual({ id: "b1" })
  expect(getDb().query("SELECT source FROM rounds WHERE chain_key = 'base-sepolia' AND id = 7").get()).toEqual({ source: "binance" })
  expect(getDb().query("SELECT balance_micros FROM users WHERE chain_key = 'base-sepolia' AND address = '0xabc'").get()).toEqual({
    balance_micros: 42_000_000,
  })
  expect(getDb().query("SELECT value FROM meta WHERE key = 'base-sepolia:deposit_block'").get()).toEqual({ value: "91" })
  expect(getDb().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bets'").get()).toBeNull()
})

test("a new database indexes buy-ins and permits the same market id on two chains", () => {
  useDatabase(":memory:")
  const names = indexNames("buy_ins")
  expect(names).toContain("buy_ins_round_time")
  expect(names).toContain("buy_ins_address")
  expect(names).not.toContain("buy_ins_round")
  const insertRound = getDb().query("INSERT INTO rounds (chain_key, id, starts_at, ends_at, status) VALUES (?, 1, 0, 1, 'open')")
  insertRound.run("base-sepolia")
  insertRound.run("near-testnet")
  getDb()
    .query("INSERT INTO buy_ins (chain_key, id, round_id, address, side, stake_micros, created_at) VALUES ('base-sepolia', 'b1', 1, '0xabc', 'up', 100, 1)")
    .run()
  expect(getDb().query("SELECT COUNT(*) AS n FROM rounds WHERE id = 1").get()).toEqual({ n: 2 })
  expect(getDb().query("SELECT id FROM buy_ins WHERE chain_key = 'base-sepolia' AND address = '0xabc'").get()).toEqual({ id: "b1" })
})

test("the legacy agent database imports once into chain-scoped tables", () => {
  dir = mkdtempSync(join(tmpdir(), "qm-db-"))
  const path = join(dir, "legacy-swarm.sqlite")
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE wallets (
      address TEXT PRIMARY KEY, idx INTEGER NOT NULL, online INTEGER NOT NULL, bankroll INTEGER NOT NULL,
      wins INTEGER NOT NULL, losses INTEGER NOT NULL, enrolled INTEGER NOT NULL, handled INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO wallets VALUES ('0xabc', 4, 1, 500, 2, 1, 1, 0);
    CREATE TABLE windows (id INTEGER PRIMARY KEY, buy_ins INTEGER, skips INTEGER, up_micros INTEGER, down_micros INTEGER, at INTEGER);
    INSERT INTO windows VALUES (7, 2, 1, 100, 200, 1000);
    CREATE TABLE stakes (round_id INTEGER, address TEXT, side TEXT, stake_micros INTEGER, PRIMARY KEY (round_id, address));
    INSERT INTO stakes VALUES (7, '0xabc', 'up', 100);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('settle_cursor', '7');
  `)
  legacy.close()
  useDatabase(":memory:")
  importLegacySwarm(getDb(), ":memory:", path)
  importLegacySwarm(getDb(), ":memory:", path)
  expect(getDb().query("SELECT idx, bankroll FROM wallets WHERE chain_key = 'base-sepolia' AND address = '0xabc'").get()).toEqual({
    idx: 4,
    bankroll: 500,
  })
  expect(getDb().query("SELECT up_micros FROM windows WHERE chain_key = 'base-sepolia' AND id = 7").get()).toEqual({ up_micros: 100 })
  expect(getDb().query("SELECT stake_micros FROM stakes WHERE chain_key = 'base-sepolia' AND round_id = 7").get()).toEqual({
    stake_micros: 100,
  })
  expect(getDb().query("SELECT value FROM meta WHERE key = 'base-sepolia:agent:settle_cursor'").get()).toEqual({ value: "7" })
})
