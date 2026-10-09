import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,
  balance_micros INTEGER NOT NULL,
  created_at INTEGER NOT NULL
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
CREATE INDEX IF NOT EXISTS bets_address ON bets(address);
`

let database: Database | null = null

function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec(SCHEMA)
  return db
}

export function getDb(): Database {
  if (!database) {
    const path = process.env.DB_PATH ?? `${process.cwd()}/data/quick-market.sqlite`
    database = openDatabase(path)
  }
  return database
}

export function useDatabase(path: string) {
  database?.close()
  database = openDatabase(path)
}
