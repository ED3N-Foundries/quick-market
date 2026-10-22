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
  grant_at INTEGER,
  grant_pending_at INTEGER,
  grant_tx TEXT
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
  pool_down_micros INTEGER NOT NULL DEFAULT 0,
  source TEXT
);

CREATE TABLE IF NOT EXISTS buy_ins (
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
  migrateBuyIns(db)
  db.exec(SCHEMA)
  ensureBuyInIndexes(db)
  const columns = db.query("PRAGMA table_info(users)").all() as { name: string }[]
  if (!columns.some((column) => column.name === "is_bot")) {
    db.exec("ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0")
  }
  if (!columns.some((column) => column.name === "grant_at")) {
    db.exec("ALTER TABLE users ADD COLUMN grant_at INTEGER")
  }
  if (!columns.some((column) => column.name === "grant_pending_at")) {
    db.exec("ALTER TABLE users ADD COLUMN grant_pending_at INTEGER")
  }
  if (!columns.some((column) => column.name === "grant_tx")) {
    db.exec("ALTER TABLE users ADD COLUMN grant_tx TEXT")
  }
  migrateRoundSource(db)
  migrateCustody(db)
  return db
}

function tableNames(db: Database): Set<string> {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  return new Set(rows.map((row) => row.name))
}

/** The ledger table was `bets`. Rename it before the schema creates `buy_ins`.
 * Indexes follow the table. Dropping them rebuilds the live ledger before listen.
 */
function migrateBuyIns(db: Database) {
  const tables = tableNames(db)
  if (tables.has("bets") && !tables.has("buy_ins")) db.exec("ALTER TABLE bets RENAME TO buy_ins")
}

function indexColumns(db: Database, indexName: string): string[] {
  const rows = db.query(`PRAGMA index_info(${indexName})`).all() as { seqno: number; name: string }[]
  return [...rows].sort((a, b) => a.seqno - b.seqno).map((row) => row.name)
}

function hasIndexPrefix(db: Database, table: string, columns: string[]): boolean {
  const indexes = db.query(`PRAGMA index_list(${table})`).all() as { name: string }[]
  return indexes.some((index) => {
    const have = indexColumns(db, index.name)
    return columns.every((column, i) => have[i] === column)
  })
}

/** Create a missing buy-in index. Skip it when a renamed ledger index already covers those columns. */
function ensureBuyInIndexes(db: Database) {
  const wanted: { name: string; columns: string[] }[] = [
    { name: "buy_ins_round", columns: ["round_id"] },
    { name: "buy_ins_round_time", columns: ["round_id", "created_at"] },
    { name: "buy_ins_address", columns: ["address"] },
  ]
  for (const index of wanted) {
    if (hasIndexPrefix(db, "buy_ins", index.columns)) continue
    db.exec(`CREATE INDEX IF NOT EXISTS ${index.name} ON buy_ins(${index.columns.join(", ")})`)
  }
}

function migrateRoundSource(db: Database) {
  const columns = db.query("PRAGMA table_info(rounds)").all() as { name: string }[]
  if (!columns.some((column) => column.name === "source")) {
    db.exec("ALTER TABLE rounds ADD COLUMN source TEXT")
  }
  const missing = db.query("SELECT id, starts_at, ends_at FROM rounds WHERE source IS NULL").all() as {
    id: number
    starts_at: number
    ends_at: number
  }[]
  if (missing.length === 0) return
  const pick = db.query(
    `SELECT source FROM ticks
     WHERE second_ts BETWEEN ? AND ?
     ORDER BY ABS(second_ts - ?)
     LIMIT 1`,
  )
  const write = db.query("UPDATE rounds SET source = ? WHERE id = ? AND source IS NULL")
  const fill = db.transaction(() => {
    for (const row of missing) {
      const start = Math.floor(row.starts_at / 1000)
      const end = Math.floor(row.ends_at / 1000)
      const tick = pick.get(start - 60, end, start) as { source: string } | null
      if (tick) write.run(tick.source, row.id)
    }
  })
  fill()
}

/** Demo balances were minted. Drop them once so they cannot be withdrawn as USDC. */
export function migrateCustody(db: Database) {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get("custody_v1") as { value: string } | null
  if (row) return
  const tx = db.transaction(() => {
    db.exec("UPDATE users SET balance_micros = 0")
    db.exec("DELETE FROM buy_ins WHERE round_id IN (SELECT id FROM rounds WHERE status = 'open')")
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
