import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { loadEnv } from "./env"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,
  balance_micros INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  grant_at INTEGER
);

CREATE TABLE IF NOT EXISTS rounds (
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

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  round_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  side TEXT NOT NULL,
  stake_micros INTEGER NOT NULL,
  payout_micros INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(round_id, address)
);

CREATE TABLE IF NOT EXISTS ticks (
  second_ts INTEGER PRIMARY KEY,
  price TEXT NOT NULL,
  source TEXT NOT NULL,
  exchange_ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS bets_round ON bets(round_id);
CREATE INDEX IF NOT EXISTS bets_round_time ON bets(round_id, created_at);
CREATE INDEX IF NOT EXISTS bets_address ON bets(address);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_sigs (
  signature TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  address TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  tx_hash TEXT,
  raw_tx TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS burns (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  tx_hash TEXT,
  raw_tx TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

let database: Database | null = null

/** Connection settings only. Does not migrate or write schema. */
export function tuneDatabase(db: Database, options: { readonly?: boolean; memory?: boolean } = {}) {
  if (!options.readonly && !options.memory) db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec("PRAGMA temp_store = MEMORY;")
  db.exec("PRAGMA cache_size = -20000;")
  db.exec("PRAGMA mmap_size = 268435456;")
  if (!options.readonly && !options.memory) db.exec("PRAGMA wal_autocheckpoint = 1000;")
}

function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  tuneDatabase(db, { memory: path === ":memory:" })
  db.exec(SCHEMA)
  const columns = db.query("PRAGMA table_info(users)").all() as { name: string }[]
  if (!columns.some((column) => column.name === "is_bot")) {
    db.exec("ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0")
  }
  if (!columns.some((column) => column.name === "grant_at")) {
    db.exec("ALTER TABLE users ADD COLUMN grant_at INTEGER")
  }
  migrateCustody(db)
  return db
}

/** Demo balances were minted. Drop them once so they cannot be withdrawn as USDC. */
export function migrateCustody(db: Database) {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get("custody_v1") as { value: string } | null
  if (row) return
  const tx = db.transaction(() => {
    db.exec("UPDATE users SET balance_micros = 0")
    db.exec("DELETE FROM bets WHERE round_id IN (SELECT id FROM rounds WHERE status = 'open')")
    db.query("INSERT INTO meta (key, value) VALUES ('custody_v1', '1')").run()
  })
  tx()
}

export function getDb(): Database {
  if (!database) {
    const path = loadEnv().dbPath
    database = openDatabase(path)
  }
  return database
}

export function useDatabase(path: string) {
  database?.close()
  database = openDatabase(path)
}
