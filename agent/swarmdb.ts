import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  idx INTEGER NOT NULL,
  online INTEGER NOT NULL,
  phase TEXT,
  bankroll INTEGER NOT NULL,
  last_side TEXT,
  last_stake INTEGER,
  last_skip TEXT,
  wins INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  mind TEXT,
  tempo INTEGER,
  visit_end INTEGER,
  enrolled INTEGER NOT NULL,
  rng_a INTEGER,
  gate_json TEXT,
  cursor INTEGER,
  visit_start INTEGER,
  gap_end INTEGER,
  handled INTEGER NOT NULL DEFAULT 0,
  woke_at INTEGER,
  slept_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS windows (
  id INTEGER PRIMARY KEY,
  bets INTEGER,
  skips INTEGER,
  up_micros INTEGER,
  down_micros INTEGER,
  at INTEGER
);
CREATE TABLE IF NOT EXISTS stakes (
  round_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  side TEXT NOT NULL,
  stake_micros INTEGER NOT NULL,
  PRIMARY KEY (round_id, address)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export type WalletRow = {
  address: string
  idx: number
  online: number
  phase: string
  bankroll: number
  lastSide: string | null
  lastStake: number | null
  lastSkip: string | null
  wins: number
  losses: number
  mind: string
  tempo: number
  visitEnd: number
  enrolled: number
  rngA: number
  gateJson: string
  cursor: number
  visitStart: number
  gapEnd: number
  handled: number
  wokeAt: number | null
  sleptAt: number | null
  updatedAt: number
}

export type RosterFilter = "all" | "stuck" | "richest" | "woke" | "slept"

export function openSwarm(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;")
  db.exec(SCHEMA)
  return db
}

export function metaGet(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
  return row?.value ?? null
}

export function metaSet(db: Database, key: string, value: string) {
  db.query(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

export function loadWalletMap(db: Database): Map<string, WalletRow> {
  const rows = db.query("SELECT * FROM wallets").all() as Record<string, unknown>[]
  const map = new Map<string, WalletRow>()
  for (const row of rows) {
    const mapped = mapRow(row)
    map.set(mapped.address, mapped)
  }
  return map
}

export function saveWallets(db: Database, rows: WalletRow[]) {
  if (rows.length === 0) return
  const tx = db.transaction(() => {
    const statement = db.query(
      `INSERT INTO wallets (
         address, idx, online, phase, bankroll, last_side, last_stake, last_skip, wins, losses,
         mind, tempo, visit_end, enrolled, rng_a, gate_json, cursor, visit_start, gap_end,
         handled, woke_at, slept_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         idx = excluded.idx, online = excluded.online, phase = excluded.phase, bankroll = excluded.bankroll,
         last_side = excluded.last_side, last_stake = excluded.last_stake, last_skip = excluded.last_skip,
         wins = excluded.wins, losses = excluded.losses, mind = excluded.mind, tempo = excluded.tempo,
         visit_end = excluded.visit_end, enrolled = excluded.enrolled, rng_a = excluded.rng_a,
         gate_json = excluded.gate_json, cursor = excluded.cursor, visit_start = excluded.visit_start,
         gap_end = excluded.gap_end, handled = excluded.handled, woke_at = excluded.woke_at,
         slept_at = excluded.slept_at, updated_at = excluded.updated_at`,
    )
    for (const row of rows) {
      statement.run(
        row.address,
        row.idx,
        row.online,
        row.phase,
        row.bankroll,
        row.lastSide,
        row.lastStake,
        row.lastSkip,
        row.wins,
        row.losses,
        row.mind,
        row.tempo,
        row.visitEnd,
        row.enrolled,
        row.rngA,
        row.gateJson,
        row.cursor,
        row.visitStart,
        row.gapEnd,
        row.handled,
        row.wokeAt,
        row.sleptAt,
        row.updatedAt,
      )
    }
  })
  tx()
}

export function noteWindow(db: Database, row: { id: number; bets: number; skips: number; upMicros: number; downMicros: number; at: number }) {
  db.query(
    `INSERT INTO windows (id, bets, skips, up_micros, down_micros, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET bets = excluded.bets, skips = excluded.skips, up_micros = excluded.up_micros,
       down_micros = excluded.down_micros, at = excluded.at`,
  ).run(row.id, row.bets, row.skips, row.upMicros, row.downMicros, row.at)
  db.query(
    `DELETE FROM windows WHERE id NOT IN (SELECT id FROM windows ORDER BY id DESC LIMIT 200)`,
  ).run()
}

export function saveStakes(db: Database, roundId: number, stakes: { address: string; side: string; stakeMicros: number }[]) {
  const tx = db.transaction(() => {
    const statement = db.query(
      `INSERT INTO stakes (round_id, address, side, stake_micros) VALUES (?, ?, ?, ?)
       ON CONFLICT(round_id, address) DO NOTHING`,
    )
    for (const stake of stakes) statement.run(roundId, stake.address, stake.side, stake.stakeMicros)
  })
  tx()
}

export function stakesFor(db: Database, roundId: number): { address: string; side: "up" | "down"; stakeMicros: number }[] {
  const rows = db.query("SELECT address, side, stake_micros FROM stakes WHERE round_id = ?").all(roundId) as {
    address: string
    side: string
    stake_micros: number
  }[]
  return rows.flatMap((row) =>
    row.side === "up" || row.side === "down" ? [{ address: row.address, side: row.side, stakeMicros: row.stake_micros }] : [],
  )
}

export function roster(db: Database, filter: RosterFilter, offset: number, limit: number): WalletRow[] {
  const sql = {
    richest: "SELECT * FROM wallets ORDER BY bankroll DESC LIMIT ? OFFSET ?",
    woke: "SELECT * FROM wallets WHERE online = 1 ORDER BY woke_at DESC LIMIT ? OFFSET ?",
    slept: "SELECT * FROM wallets WHERE online = 0 ORDER BY slept_at DESC LIMIT ? OFFSET ?",
    stuck: "SELECT * FROM wallets WHERE online = 1 AND last_skip IN ('refractory', 'flat') ORDER BY idx ASC LIMIT ? OFFSET ?",
    all: "SELECT * FROM wallets ORDER BY online DESC, idx ASC LIMIT ? OFFSET ?",
  }[filter]
  return (db.query(sql).all(limit, offset) as Record<string, unknown>[]).map(mapRow)
}

export function rosterCount(db: Database, filter: RosterFilter): number {
  const where = {
    richest: "",
    woke: "WHERE online = 1",
    slept: "WHERE online = 0",
    stuck: "WHERE online = 1 AND last_skip IN ('refractory', 'flat')",
    all: "",
  }[filter]
  const row = db.query(`SELECT COUNT(*) AS n FROM wallets ${where}`).get() as { n: number }
  return row.n
}

function mapRow(row: Record<string, unknown>): WalletRow {
  return {
    address: String(row.address),
    idx: Number(row.idx),
    online: Number(row.online),
    phase: String(row.phase ?? ""),
    bankroll: Number(row.bankroll),
    lastSide: row.last_side == null ? null : String(row.last_side),
    lastStake: row.last_stake == null ? null : Number(row.last_stake),
    lastSkip: row.last_skip == null ? null : String(row.last_skip),
    wins: Number(row.wins),
    losses: Number(row.losses),
    mind: String(row.mind ?? ""),
    tempo: Number(row.tempo ?? 0),
    visitEnd: Number(row.visit_end ?? 0),
    enrolled: Number(row.enrolled),
    rngA: Number(row.rng_a ?? 0),
    gateJson: String(row.gate_json ?? ""),
    cursor: Number(row.cursor ?? 0),
    visitStart: Number(row.visit_start ?? 0),
    gapEnd: Number(row.gap_end ?? 0),
    handled: Number(row.handled ?? 0),
    wokeAt: row.woke_at == null ? null : Number(row.woke_at),
    sleptAt: row.slept_at == null ? null : Number(row.slept_at),
    updatedAt: Number(row.updated_at ?? 0),
  }
}
