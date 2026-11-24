import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { ChainKey } from "../shared/chain"
import { isNearAccountId } from "../shared/near"
import { loadEnv } from "./env"

const CHAIN_TABLES: Record<string, string> = {
  users: `CREATE TABLE IF NOT EXISTS users (
    chain_key TEXT NOT NULL,
    address TEXT NOT NULL,
    balance_micros INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    grant_at INTEGER,
    grant_pending_at INTEGER,
    grant_tx TEXT,
    grant_seen INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chain_key, address)
  )`,
  rounds: `CREATE TABLE IF NOT EXISTS rounds (
    chain_key TEXT NOT NULL,
    id INTEGER NOT NULL,
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
    source TEXT,
    PRIMARY KEY (chain_key, id)
  )`,
  buy_ins: `CREATE TABLE IF NOT EXISTS buy_ins (
    chain_key TEXT NOT NULL,
    round_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    side TEXT NOT NULL,
    stake_micros INTEGER NOT NULL,
    payout_micros INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chain_key, round_id, address)
  )`,
  buy_in_requests: `CREATE TABLE IF NOT EXISTS buy_in_requests (
    chain_key TEXT NOT NULL,
    address TEXT NOT NULL,
    id TEXT NOT NULL,
    round_id INTEGER NOT NULL,
    side TEXT NOT NULL,
    stake_micros INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chain_key, address, id)
  )`,
  sessions: `CREATE TABLE IF NOT EXISTS sessions (
    chain_key TEXT NOT NULL,
    token TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  login_sigs: `CREATE TABLE IF NOT EXISTS login_sigs (
    chain_key TEXT NOT NULL,
    signature TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
  deposits: `CREATE TABLE IF NOT EXISTS deposits (
    chain_key TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    address TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chain_key, tx_hash, log_index)
  )`,
  withdrawals: `CREATE TABLE IF NOT EXISTS withdrawals (
    chain_key TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    tx_hash TEXT,
    raw_tx TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  burns: `CREATE TABLE IF NOT EXISTS burns (
    chain_key TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    tx_hash TEXT,
    raw_tx TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
}

const SHARED_TABLES = `
CREATE TABLE IF NOT EXISTS ticks (
  second_ts INTEGER PRIMARY KEY,
  price TEXT NOT NULL,
  source TEXT NOT NULL,
  exchange_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticks_minute (
  min_ts INTEGER PRIMARY KEY,
  open TEXT NOT NULL,
  high TEXT NOT NULL,
  low TEXT NOT NULL,
  close TEXT NOT NULL,
  count INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qm_health_sample (
  ts INTEGER PRIMARY KEY,
  boot_id TEXT NOT NULL,
  boot_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  mem_total INTEGER NOT NULL,
  mem_used INTEGER NOT NULL,
  swap_used INTEGER NOT NULL,
  cpu_user INTEGER NOT NULL,
  cpu_sys INTEGER NOT NULL,
  cpu_iowait INTEGER NOT NULL,
  load1 INTEGER NOT NULL,
  disk_size INTEGER NOT NULL,
  disk_used INTEGER NOT NULL,
  db_bytes INTEGER NOT NULL,
  self_rss INTEGER NOT NULL,
  self_heap INTEGER NOT NULL,
  self_external INTEGER NOT NULL,
  self_cpu_ms REAL NOT NULL,
  lag_ms REAL,
  lag_max REAL NOT NULL DEFAULT 0,
  lag_p50 REAL NOT NULL DEFAULT 0,
  lag_p90 REAL NOT NULL DEFAULT 0,
  lag_p95 REAL NOT NULL DEFAULT 0,
  lag_p99 REAL NOT NULL DEFAULT 0,
  uptime_ms INTEGER NOT NULL,
  peers INTEGER NOT NULL,
  feed TEXT,
  req_count INTEGER NOT NULL,
  req_avg_ms REAL NOT NULL,
  req_max_ms REAL NOT NULL,
  req_p50 REAL NOT NULL DEFAULT 0,
  req_p90 REAL NOT NULL DEFAULT 0,
  req_p95 REAL NOT NULL DEFAULT 0,
  req_p99 REAL NOT NULL DEFAULT 0,
  q_count INTEGER NOT NULL,
  q_avg_ms REAL NOT NULL,
  q_max_ms REAL NOT NULL,
  q_p50 REAL NOT NULL DEFAULT 0,
  q_p90 REAL NOT NULL DEFAULT 0,
  q_p95 REAL NOT NULL DEFAULT 0,
  q_p99 REAL NOT NULL DEFAULT 0,
  tick_count INTEGER NOT NULL,
  tick_avg_ms REAL NOT NULL,
  tick_max_ms REAL NOT NULL,
  tick_p50 REAL NOT NULL DEFAULT 0,
  tick_p90 REAL NOT NULL DEFAULT 0,
  tick_p95 REAL NOT NULL DEFAULT 0,
  tick_p99 REAL NOT NULL DEFAULT 0,
  board_count INTEGER NOT NULL,
  board_avg_ms REAL NOT NULL,
  board_max_ms REAL NOT NULL,
  board_p50 REAL NOT NULL DEFAULT 0,
  board_p90 REAL NOT NULL DEFAULT 0,
  board_p95 REAL NOT NULL DEFAULT 0,
  board_p99 REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS qm_health_route (
  ts INTEGER NOT NULL,
  route TEXT NOT NULL,
  count INTEGER NOT NULL,
  total_ms REAL NOT NULL,
  max_ms REAL NOT NULL,
  p50 REAL NOT NULL DEFAULT 0,
  p90 REAL NOT NULL DEFAULT 0,
  p95 REAL NOT NULL DEFAULT 0,
  p99 REAL NOT NULL DEFAULT 0,
  hist TEXT,
  PRIMARY KEY (ts, route)
);

CREATE TABLE IF NOT EXISTS qm_health_query (
  ts INTEGER NOT NULL,
  grp TEXT NOT NULL,
  count INTEGER NOT NULL,
  total_ms REAL NOT NULL,
  max_ms REAL NOT NULL,
  p50 REAL NOT NULL DEFAULT 0,
  p90 REAL NOT NULL DEFAULT 0,
  p95 REAL NOT NULL DEFAULT 0,
  p99 REAL NOT NULL DEFAULT 0,
  hist TEXT,
  PRIMARY KEY (ts, grp)
);

CREATE TABLE IF NOT EXISTS qm_health_minute (
  ts INTEGER PRIMARY KEY,
  samples INTEGER NOT NULL,
  boot_count INTEGER NOT NULL,
  mem_avg INTEGER NOT NULL,
  mem_max INTEGER NOT NULL,
  self_rss_avg INTEGER NOT NULL,
  self_rss_max INTEGER NOT NULL,
  cpu_avg INTEGER NOT NULL,
  cpu_max INTEGER NOT NULL,
  lag_avg REAL,
  lag_max REAL,
  lag_p50 REAL NOT NULL DEFAULT 0,
  lag_p90 REAL NOT NULL DEFAULT 0,
  lag_p95 REAL NOT NULL DEFAULT 0,
  lag_p99 REAL NOT NULL DEFAULT 0,
  disk_used INTEGER NOT NULL,
  disk_size INTEGER NOT NULL,
  db_bytes INTEGER NOT NULL,
  req_count INTEGER NOT NULL,
  req_avg_ms REAL NOT NULL,
  req_max_ms REAL NOT NULL,
  req_p50 REAL NOT NULL DEFAULT 0,
  req_p90 REAL NOT NULL DEFAULT 0,
  req_p95 REAL NOT NULL DEFAULT 0,
  req_p99 REAL NOT NULL DEFAULT 0,
  q_count INTEGER NOT NULL,
  q_avg_ms REAL NOT NULL,
  q_max_ms REAL NOT NULL,
  q_p50 REAL NOT NULL DEFAULT 0,
  q_p90 REAL NOT NULL DEFAULT 0,
  q_p95 REAL NOT NULL DEFAULT 0,
  q_p99 REAL NOT NULL DEFAULT 0,
  tick_avg_ms REAL NOT NULL,
  tick_max_ms REAL NOT NULL,
  tick_p50 REAL NOT NULL DEFAULT 0,
  tick_p90 REAL NOT NULL DEFAULT 0,
  tick_p95 REAL NOT NULL DEFAULT 0,
  tick_p99 REAL NOT NULL DEFAULT 0,
  board_avg_ms REAL NOT NULL,
  board_max_ms REAL NOT NULL,
  board_p50 REAL NOT NULL DEFAULT 0,
  board_p90 REAL NOT NULL DEFAULT 0,
  board_p95 REAL NOT NULL DEFAULT 0,
  board_p99 REAL NOT NULL DEFAULT 0,
  peers_max INTEGER NOT NULL,
  feed TEXT
);

CREATE TABLE IF NOT EXISTS qm_health_route_minute (
  ts INTEGER NOT NULL,
  route TEXT NOT NULL,
  count INTEGER NOT NULL,
  avg_ms REAL NOT NULL,
  max_ms REAL NOT NULL,
  p50 REAL NOT NULL DEFAULT 0,
  p90 REAL NOT NULL DEFAULT 0,
  p95 REAL NOT NULL DEFAULT 0,
  p99 REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (ts, route)
);

CREATE TABLE IF NOT EXISTS qm_health_query_minute (
  ts INTEGER NOT NULL,
  grp TEXT NOT NULL,
  count INTEGER NOT NULL,
  avg_ms REAL NOT NULL,
  max_ms REAL NOT NULL,
  p50 REAL NOT NULL DEFAULT 0,
  p90 REAL NOT NULL DEFAULT 0,
  p95 REAL NOT NULL DEFAULT 0,
  p99 REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (ts, grp)
);

CREATE TABLE IF NOT EXISTS qm_hangs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS qm_hangs_ts ON qm_hangs(ts DESC);

CREATE TABLE IF NOT EXISTS qm_archives (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`

const SCHEMA = `${Object.values(CHAIN_TABLES).join(";\n")};\n${SHARED_TABLES}`

let database: Database | null = null

/** Connection settings only. Does not migrate or write schema. */
export function tuneDatabase(db: Database, options: { readonly?: boolean; memory?: boolean } = {}) {
  if (!options.readonly && !options.memory) db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec("PRAGMA busy_timeout = 5000;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec("PRAGMA temp_store = MEMORY;")
  db.exec("PRAGMA cache_size = -20000;")
  db.exec("PRAGMA mmap_size = 268435456;")
  if (!options.readonly && !options.memory) db.exec("PRAGMA wal_autocheckpoint = 1000;")
}

/** P3-3 observability: the honest size gauges, all O(1) PRAGMAs — safe per
 *  request, unlike COUNT(*) over millions of ledger rows. freelistPages against
 *  pageCount shows whether archive deletes are returning pages, and autoVacuum
 *  tells the operator whether a one-time maintenance VACUUM is needed to
 *  shrink the file itself. */
export function dbShapeStats(db: Database): {
  pageBytes: number
  pageCount: number
  freelistPages: number
  pageSize: number
  autoVacuum: number
} {
  const one = (sql: string): number => {
    const row = db.query(sql).get() as Record<string, number> | null
    if (!row) return 0
    return Number(Object.values(row)[0] ?? 0)
  }
  const pageCount = one("PRAGMA page_count")
  const pageSize = one("PRAGMA page_size")
  return {
    pageBytes: pageCount * pageSize,
    pageCount,
    freelistPages: one("PRAGMA freelist_count"),
    pageSize,
    autoVacuum: one("PRAGMA auto_vacuum"),
  }
}

function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  tuneDatabase(db, { memory: path === ":memory:" })
  migrateBuyIns(db)
  db.exec(SCHEMA)
  migrateChainSchema(db)
  dropSwarm(db)
  migrateBuyInsV2(db)
  ensureBuyInIndexes(db)
  analyzeBuyInsV2(db)
  migrateRoundSource(db)
  ensureRoundIndexes(db)
  ensureHealthIndexes(db)
  ensureAuthIndexes(db)
  ensureHealthPxxColumns(db)
  migrateCustody(db)
  ensureGrantSeen(db)
  return db
}

/** Existing ledgers predate the grant meter. The count starts at zero. */
function ensureGrantSeen(db: Database) {
  if (!tableNames(db).has("users")) return
  if (tableColumns(db, "users").includes("grant_seen")) return
  db.exec("ALTER TABLE users ADD COLUMN grant_seen INTEGER NOT NULL DEFAULT 0")
}

function tableNames(db: Database, schema = "main"): Set<string> {
  const rows = db.query(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  return new Set(rows.map((row) => row.name))
}

function tableColumns(db: Database, table: string, schema = "main"): string[] {
  const rows = db.query(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]
  return rows.map((row) => row.name)
}

/** The ledger table was `bets`. Rename it before the schema creates `buy_ins`. */
function migrateBuyIns(db: Database) {
  const tables = tableNames(db)
  if (tables.has("bets") && !tables.has("buy_ins")) db.exec("ALTER TABLE bets RENAME TO buy_ins")
}

/** P1-6: drop the UUID primary key. The composite (chain_key, round_id, address)
 *  key replaces the UUID PK and the redundant UNIQUE index, so an insert
 *  maintains the key plus the two covering indexes instead of four index
 *  writes, and the two dropped indexes return ~450 MB on the live ledger.
 *  Runs once behind the buy_ins_v2 marker, inside the planned restart window.
 *  The copy drops `id`; the old UNIQUE(chain_key, round_id, address) already
 *  guarantees no duplicates reach the new primary key. */
function migrateBuyInsV2(db: Database) {
  const marked = db.query("SELECT value FROM meta WHERE key = 'buy_ins_v2'").get()
  if (marked) return
  if (!tableColumns(db, "buy_ins").includes("id")) {
    db.query("INSERT INTO meta (key, value) VALUES ('buy_ins_v2', '1')").run()
    return
  }
  const rebuild = db.transaction(() => {
    db.exec(`CREATE TABLE buy_ins_rebuilt (
      chain_key TEXT NOT NULL,
      round_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      side TEXT NOT NULL,
      stake_micros INTEGER NOT NULL,
      payout_micros INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (chain_key, round_id, address)
    )`)
    db.exec(`INSERT INTO buy_ins_rebuilt (chain_key, round_id, address, side, stake_micros, payout_micros, created_at)
      SELECT chain_key, round_id, address, side, stake_micros, payout_micros, created_at FROM buy_ins`)
    db.exec("DROP TABLE buy_ins")
    db.exec("ALTER TABLE buy_ins_rebuilt RENAME TO buy_ins")
    db.query("INSERT INTO meta (key, value) VALUES ('buy_ins_v2', '1')").run()
  })
  rebuild()
}

/** The P1-6 restart is the one sanctioned full-ANALYZE window: sqlite_stat1
 *  runs 5x stale on the live ledger (RELIABILITY_PLAN 2.3). Runs after the
 *  buy-in covering indexes exist so the fresh stats cover them. */
function analyzeBuyInsV2(db: Database) {
  const marked = db.query("SELECT value FROM meta WHERE key = 'buy_ins_v2_analyzed'").get()
  if (marked) return
  db.exec("ANALYZE")
  db.query("INSERT INTO meta (key, value) VALUES ('buy_ins_v2_analyzed', '1')").run()
}

function legacyChain(db: Database): ChainKey {
  if (tableNames(db).has("users")) {
    const rows = db.query("SELECT address FROM users").all() as { address: string }[]
    if (rows.some((row) => !row.address.startsWith("0x") && isNearAccountId(row.address))) return "near-testnet"
  }
  if (tableNames(db).has("meta")) {
    const near = db.query("SELECT value FROM meta WHERE key = 'near_deposit_height'").get()
    if (near) return "near-testnet"
  }
  return "base-sepolia"
}

function dropTableIndexes(db: Database, table: string) {
  const indexes = db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).all(table) as {
    name: string
  }[]
  for (const index of indexes) db.exec(`DROP INDEX IF EXISTS ${index.name}`)
}

function migrateChainSchema(db: Database) {
  const marked = db.query("SELECT value FROM meta WHERE key = 'chain_schema_v1'").get()
  if (marked) return
  const chain = legacyChain(db)
  const migrate = db.transaction(() => {
    for (const [table, definition] of Object.entries(CHAIN_TABLES)) {
      const columns = tableColumns(db, table)
      if (columns.length === 0 || columns.includes("chain_key")) continue
      const legacy = `${table}_before_chain`
      dropTableIndexes(db, table)
      db.exec(`ALTER TABLE ${table} RENAME TO ${legacy}`)
      db.exec(definition)
      // Copy only the columns the target shape still has. The buy_ins rebuild
      // dropped the UUID id column, and legacy rows still carry it.
      const target = tableColumns(db, table)
      const copy = columns.filter((column) => column !== "is_bot" && target.includes(column))
      if (copy.length === 0) {
        db.exec(`DROP TABLE ${legacy}`)
        continue
      }
      const names = copy.join(", ")
      db.query(`INSERT INTO ${table} (chain_key, ${names}) SELECT ?, ${names} FROM ${legacy}`).run(chain)
      db.exec(`DROP TABLE ${legacy}`)
    }
    for (const key of ["deposit_block", "near_deposit_height", "qm_usdc_v1"]) {
      const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
      if (row) db.query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(`${chain}:${key}`, row.value)
    }
    db.query("INSERT INTO meta (key, value) VALUES ('chain_schema_v1', '1')").run()
  })
  migrate()
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

/** Create a missing buy-in index. Skip it when an existing index covers those columns. */
function ensureBuyInIndexes(db: Database) {
  const wanted: { name: string; columns: string[] }[] = [
    { name: "buy_ins_round", columns: ["chain_key", "round_id"] },
    { name: "buy_ins_round_time", columns: ["chain_key", "round_id", "created_at"] },
    { name: "buy_ins_address", columns: ["chain_key", "address"] },
  ]
  for (const index of wanted) {
    if (hasIndexPrefix(db, "buy_ins", index.columns)) continue
    db.exec(`CREATE INDEX IF NOT EXISTS ${index.name} ON buy_ins(${index.columns.join(", ")})`)
  }
}

/** Closed markets are read by start time. Round ids are not time order across a window change. */
function ensureRoundIndexes(db: Database) {
  db.exec("CREATE INDEX IF NOT EXISTS rounds_closed_starts ON rounds(chain_key, starts_at DESC) WHERE status != 'open'")
  // The open set is tiny, so these partial indexes answer the settle and
  // strike walks without adding a write to every closed round.
  db.exec("CREATE INDEX IF NOT EXISTS rounds_open_ends ON rounds(chain_key, ends_at) WHERE status = 'open'")
  db.exec("CREATE INDEX IF NOT EXISTS rounds_open_strike ON rounds(chain_key, starts_at) WHERE status = 'open' AND strike IS NULL")
  // board() reads a short ends_at window. Without this it scans every round.
  db.exec("CREATE INDEX IF NOT EXISTS rounds_ends ON rounds(chain_key, ends_at)")
  analyzeRoundIndexes(db)
}

/** Refresh sqlite_stat1 once so the planner knows the new round indexes exist. */
function analyzeRoundIndexes(db: Database) {
  const marker = db.query("SELECT value FROM meta WHERE key = 'round_indexes_v1'").get()
  if (marker) return
  db.exec("ANALYZE")
  db.query("INSERT INTO meta (key, value) VALUES ('round_indexes_v1', '1')").run()
}

/** Expired sign-in rows are deleted on a schedule, never per request. */
function ensureAuthIndexes(db: Database) {
  db.exec("CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at)")
  db.exec("CREATE INDEX IF NOT EXISTS login_sigs_expires ON login_sigs(expires_at)")
  analyzeAuthIndexes(db)
}

/** Refresh the expiry-index stats once. ANALYZE is table-scoped so the boot
 *  cost stays off the big ledger tables. */
function analyzeAuthIndexes(db: Database) {
  const marker = db.query("SELECT value FROM meta WHERE key = 'auth_indexes_v1'").get()
  if (marker) return
  db.exec("ANALYZE sessions")
  db.exec("ANALYZE login_sigs")
  db.query("INSERT INTO meta (key, value) VALUES ('auth_indexes_v1', '1')").run()
}

function ensureHealthIndexes(db: Database) {
  db.exec("CREATE INDEX IF NOT EXISTS qm_health_route_ts ON qm_health_route(ts DESC)")
  db.exec("CREATE INDEX IF NOT EXISTS qm_health_query_ts ON qm_health_query(ts DESC)")
  db.exec("CREATE INDEX IF NOT EXISTS qm_health_sample_boot ON qm_health_sample(boot_id, ts DESC)")
  db.exec("CREATE INDEX IF NOT EXISTS qm_hangs_ts ON qm_hangs(ts DESC)")
}

/** Existing ledger files predate percentile/histogram columns. Add them. */
function ensureHealthPxxColumns(db: Database) {
  const add = (table: string, column: string, ddl: string): void => {
    try {
      if (tableColumns(db, table).includes(column)) return
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    } catch {
      // best effort
    }
  }
  const pxx = ["p50", "p90", "p95", "p99"]
  for (const col of ["lag_max", ...pxx.map((p) => `lag_${p}`), ...pxx.map((p) => `req_${p}`), ...pxx.map((p) => `q_${p}`), ...pxx.map((p) => `tick_${p}`), ...pxx.map((p) => `board_${p}`)]) {
    add("qm_health_sample", col, "REAL NOT NULL DEFAULT 0")
  }
  for (const col of [...pxx, "hist"]) {
    add("qm_health_route", col, col === "hist" ? "TEXT" : "REAL NOT NULL DEFAULT 0")
    add("qm_health_query", col, col === "hist" ? "TEXT" : "REAL NOT NULL DEFAULT 0")
  }
  for (const table of ["qm_health_minute", "qm_health_route_minute", "qm_health_query_minute"]) {
    const cols = table === "qm_health_minute"
      ? [...pxx.map((p) => `lag_${p}`), ...pxx.map((p) => `req_${p}`), ...pxx.map((p) => `q_${p}`), ...pxx.map((p) => `tick_${p}`), ...pxx.map((p) => `board_${p}`)]
      : [...pxx]
    for (const col of cols) add(table, col, "REAL NOT NULL DEFAULT 0")
  }
}

function migrateRoundSource(db: Database) {
  const missing = db.query("SELECT chain_key, id, starts_at, ends_at FROM rounds WHERE source IS NULL").all() as {
    chain_key: ChainKey
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
  const write = db.query("UPDATE rounds SET source = ? WHERE chain_key = ? AND id = ? AND source IS NULL")
  const fill = db.transaction(() => {
    for (const row of missing) {
      const start = Math.floor(row.starts_at / 1000)
      const end = Math.floor(row.ends_at / 1000)
      const tick = pick.get(start - 60, end, start) as { source: string } | null
      if (tick) write.run(tick.source, row.chain_key, row.id)
    }
  })
  fill()
}

/** Swarm tables lived here before the runner kept its own file. Balances stay on users. */
function dropSwarm(db: Database) {
  db.exec("DROP TABLE IF EXISTS wallets")
  db.exec("DROP TABLE IF EXISTS windows")
  db.exec("DROP TABLE IF EXISTS stakes")
  if (tableNames(db).has("meta")) {
    db.exec("DELETE FROM meta WHERE key = 'agent_swarm_v1' OR key LIKE '%:agent:%'")
  }
  if (tableNames(db).has("users") && tableColumns(db, "users").includes("is_bot")) {
    db.exec("ALTER TABLE users DROP COLUMN is_bot")
  }
}

/** Demo balances were minted. Drop them once so they cannot be withdrawn as USDC. */
export function migrateCustody(db: Database) {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get("custody_v1") as { value: string } | null
  if (row) return
  const tx = db.transaction(() => {
    db.exec("UPDATE users SET balance_micros = 0")
    db.exec(`DELETE FROM buy_ins WHERE EXISTS (
      SELECT 1 FROM rounds WHERE rounds.chain_key = buy_ins.chain_key AND rounds.id = buy_ins.round_id AND rounds.status = 'open'
    )`)
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
