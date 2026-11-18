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

test("the production Base schema preserves balances, open activity, sessions, and custody", () => {
  dir = mkdtempSync(join(tmpdir(), "qm-db-"))
  const path = join(dir, "market.sqlite")
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE users (
      address TEXT PRIMARY KEY, balance_micros INTEGER NOT NULL, created_at INTEGER NOT NULL,
      is_bot INTEGER NOT NULL DEFAULT 0, grant_at INTEGER, grant_pending_at INTEGER, grant_tx TEXT
    );
    INSERT INTO users VALUES ('0xabc', 42000000, 1, 0, 2, 3, 'grant-tx');
    CREATE TABLE rounds (
      id INTEGER PRIMARY KEY, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      strike TEXT, settle TEXT, status TEXT NOT NULL, fee_micros INTEGER NOT NULL DEFAULT 0,
      winning_side TEXT, resolution TEXT, pool_up_micros INTEGER NOT NULL DEFAULT 0,
      pool_down_micros INTEGER NOT NULL DEFAULT 0, source TEXT
    );
    INSERT INTO rounds VALUES
      (7, 1700000000000, 1700000005000, '1', '2', 'settled', 0, 'up', 'paid', 100, 0, 'coinbase'),
      (8, 1700000010000, 1700000015000, NULL, NULL, 'open', 0, NULL, NULL, 25, 0, NULL);
    CREATE TABLE buy_ins (
      id TEXT PRIMARY KEY, round_id INTEGER NOT NULL, address TEXT NOT NULL, side TEXT NOT NULL,
      stake_micros INTEGER NOT NULL, payout_micros INTEGER, created_at INTEGER NOT NULL,
      UNIQUE(round_id, address)
    );
    INSERT INTO buy_ins VALUES
      ('settled', 7, '0xabc', 'up', 100, 200, 1),
      ('open', 8, '0xabc', 'up', 25, NULL, 2);
    CREATE TABLE ticks (second_ts INTEGER PRIMARY KEY, price TEXT NOT NULL, source TEXT NOT NULL, exchange_ts INTEGER NOT NULL);
    INSERT INTO ticks VALUES (1700000010, '1', 'bybit', 1700000010000);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, address TEXT NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('session', '0xabc', 99);
    CREATE TABLE login_sigs (signature TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    INSERT INTO login_sigs VALUES ('signature', 99);
    CREATE TABLE deposits (
      tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, address TEXT NOT NULL,
      amount_micros INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (tx_hash, log_index)
    );
    INSERT INTO deposits VALUES ('deposit', 0, '0xabc', 10, 1);
    CREATE TABLE withdrawals (
      id TEXT PRIMARY KEY, address TEXT NOT NULL, amount_micros INTEGER NOT NULL,
      tx_hash TEXT, raw_tx TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO withdrawals VALUES ('withdraw', '0xabc', 5, 'tx', 'raw', 'sent', 1);
    CREATE TABLE burns (
      id TEXT PRIMARY KEY, address TEXT NOT NULL, amount_micros INTEGER NOT NULL,
      tx_hash TEXT, raw_tx TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO burns VALUES ('burn', '0xabc', 5, 'tx', 'raw', 'sent', 1);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('custody_v1', '1'), ('deposit_block', '91');
  `)
  legacy.close()

  useDatabase(path)
  const db = getDb()
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  expect(db.query("SELECT value FROM meta WHERE key = 'chain_schema_v1'").get()).toEqual({ value: "1" })
  expect(db.query("SELECT value FROM meta WHERE key = 'base-sepolia:deposit_block'").get()).toEqual({ value: "91" })
  expect(db.query("SELECT balance_micros, grant_pending_at, grant_tx FROM users WHERE chain_key = 'base-sepolia'").get()).toEqual({
    balance_micros: 42_000_000,
    grant_pending_at: 3,
    grant_tx: "grant-tx",
  })
  expect(db.query("SELECT COUNT(*) AS n FROM buy_ins WHERE chain_key = 'base-sepolia'").get()).toEqual({ n: 2 })
  expect(db.query("SELECT source FROM rounds WHERE chain_key = 'base-sepolia' AND id = 8").get()).toEqual({ source: "bybit" })
  expect(db.query("SELECT token FROM sessions WHERE chain_key = 'base-sepolia'").get()).toEqual({ token: "session" })
  expect(db.query("SELECT signature FROM login_sigs WHERE chain_key = 'base-sepolia'").get()).toEqual({ signature: "signature" })
  expect(db.query("SELECT tx_hash FROM deposits WHERE chain_key = 'base-sepolia'").get()).toEqual({ tx_hash: "deposit" })
  expect(db.query("SELECT id FROM withdrawals WHERE chain_key = 'base-sepolia'").get()).toEqual({ id: "withdraw" })
  expect(db.query("SELECT id FROM burns WHERE chain_key = 'base-sepolia'").get()).toEqual({ id: "burn" })
  const columns = db.query("PRAGMA table_info(users)").all() as { name: string }[]
  expect(columns.map((column) => column.name)).not.toContain("is_bot")

  useDatabase(path)
  expect(getDb().query("SELECT COUNT(*) AS n FROM buy_ins").get()).toEqual({ n: 2 })
  expect(getDb().query("SELECT SUM(balance_micros) AS n FROM users").get()).toEqual({ n: 42_000_000 })
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

test("round indexes cover open settle, open strike, and board reads", () => {
  useDatabase(":memory:")
  const names = indexNames("rounds")
  expect(names).toContain("rounds_open_ends")
  expect(names).toContain("rounds_open_strike")
  expect(names).toContain("rounds_ends")
  expect(getDb().query("SELECT value FROM meta WHERE key = 'round_indexes_v1'").get()).toEqual({ value: "1" })
})

test("opening drops swarm tables, agent meta, and is_bot without touching balances", () => {
  dir = mkdtempSync(join(tmpdir(), "qm-db-"))
  const path = join(dir, "market.sqlite")
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE users (
      chain_key TEXT NOT NULL, address TEXT NOT NULL, balance_micros INTEGER NOT NULL,
      created_at INTEGER NOT NULL, is_bot INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chain_key, address)
    );
    INSERT INTO users VALUES ('base-sepolia', '0xabc', 42000000, 1, 1);
    CREATE TABLE wallets (chain_key TEXT, address TEXT, idx INTEGER);
    INSERT INTO wallets VALUES ('base-sepolia', '0xabc', 4);
    CREATE TABLE windows (chain_key TEXT, id INTEGER);
    INSERT INTO windows VALUES ('base-sepolia', 7);
    CREATE TABLE stakes (chain_key TEXT, round_id INTEGER, address TEXT);
    INSERT INTO stakes VALUES ('base-sepolia', 7, '0xabc');
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES
      ('chain_schema_v1', '1'),
      ('custody_v1', '1'),
      ('agent_swarm_v1', '1'),
      ('base-sepolia:agent:settle_cursor', '7'),
      ('base-sepolia:deposit_block', '91');
  `)
  legacy.close()
  useDatabase(path)
  const db = getDb()
  expect(db.query("SELECT balance_micros FROM users WHERE address = '0xabc'").get()).toEqual({ balance_micros: 42_000_000 })
  const columns = db.query("PRAGMA table_info(users)").all() as { name: string }[]
  expect(columns.map((column) => column.name)).not.toContain("is_bot")
  for (const name of ["wallets", "windows", "stakes"]) {
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)).toBeNull()
  }
  expect(db.query("SELECT value FROM meta WHERE key = 'agent_swarm_v1'").get()).toBeNull()
  expect(db.query("SELECT value FROM meta WHERE key = 'base-sepolia:agent:settle_cursor'").get()).toBeNull()
  expect(db.query("SELECT value FROM meta WHERE key = 'base-sepolia:deposit_block'").get()).toEqual({ value: "91" })
  expect(db.query("SELECT value FROM meta WHERE key = 'chain_schema_v1'").get()).toEqual({ value: "1" })
  expect(db.query("SELECT value FROM meta WHERE key = 'custody_v1'").get()).toEqual({ value: "1" })
})
