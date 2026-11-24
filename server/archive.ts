import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import type { Database } from "bun:sqlite"
import { HEALTH_MINUTE_RETENTION_MS, HEALTH_RAW_RETENTION_MS } from "./selfHealth"

// ---------------------------------------------------------------------------
// Archive old history to compressed files. Nothing is deleted without first
// being written to a gzip archive, so history is preserved to infinity (until
// the disk itself fills, which surfaces as degraded/down health).
//
// Layout (next to the ledger file, in <dataDir>/archives/):
//   health-sample-<from>-<to>.jsonl.gz
//   health-route-<from>-<to>.jsonl.gz
//   health-minute-<from>-<to>.jsonl.gz
//   ticks-<from>-<to>.jsonl.gz
// plus a qm_archives ledger table tracking what was archived.
// ---------------------------------------------------------------------------

export const TICKS_RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const BATCH = 2000

export function archivesDir(dataDir: string): string {
  return join(dataDir, "archives")
}

export function ensureArchivesDir(dataDir: string): string {
  const dir = archivesDir(dataDir)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }
  return dir
}

function archivePath(dataDir: string, name: string): string {
  return join(ensureArchivesDir(dataDir), name)
}

function trackArchive(
  db: Database,
  name: string,
  kind: string,
  fromTs: number,
  toTs: number,
  rows: number,
  bytes: number,
  createdAt: number,
): void {
  try {
    db.query(
      `INSERT OR REPLACE INTO qm_archives (name, kind, from_ts, to_ts, rows, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, kind, fromTs, toTs, rows, bytes, createdAt)
  } catch {
    // tracking is best effort
  }
}

function writeGzipJsonlSync(path: string, rows: Record<string, unknown>[]): number {
  // Synchronous gzip write. Batches are capped (BATCH rows) so per-call work
  // stays small so a batch does not stall the market loop for long.
  if (rows.length === 0) return 0
  const lines = rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
  const bytes = gzipSync(Buffer.from(lines, "utf8"), { level: 6 })
  writeFileSync(path, bytes)
  return bytes.length
}

function exportAndDelete(
  db: Database,
  dataDir: string,
  kind: string,
  filePrefix: string,
  selectSql: string,
  deleteSql: string,
  selectArgs: unknown[],
  deleteArgs: unknown[],
  now: number,
): { files: string[]; rows: number; bytes: number } {
  const out = { files: [] as string[], rows: 0, bytes: 0 }
  try {
    const rows = db.query(selectSql).all(...(selectArgs as [])) as Record<string, unknown>[]
    if (rows.length === 0) return out
    const tsValues = rows
      .map((row) => Number((row as { ts?: number }).ts ?? (row as { second_ts?: number }).second_ts ?? 0))
      .filter((n) => n > 0)
    const from = tsValues.length > 0 ? Math.min(...tsValues) : now
    const to = tsValues.length > 0 ? Math.max(...tsValues) : now
    const name = `${filePrefix}-${from}-${to}.jsonl.gz`
    const path = archivePath(dataDir, name)
    if (existsSync(path)) {
      // Already archived (previous run wrote the file but crashed before
      // delete). Delete the live rows without duplicating the file.
      db.query(deleteSql).run(...(deleteArgs as []))
      trackArchive(db, name, kind, from, to, rows.length, 0, now)
      out.files.push(name)
      out.rows += rows.length
      return out
    }
    const bytes = writeGzipJsonlSync(path, rows)
    db.query(deleteSql).run(...(deleteArgs as []))
    trackArchive(db, name, kind, from, to, rows.length, bytes, now)
    out.files.push(name)
    out.rows += rows.length
    out.bytes += bytes
    return out
  } catch {
    return out
  }
}

/** Minutes written per call. The next call continues after the market loop has run. */
const DOWNSAMPLE_MINUTES = 60

/** Downsample a bounded run of raw minutes so one call cannot scan the whole tape. */
export function downsampleTicks(db: Database, olderThanMs: number, now = Date.now()): number {
  try {
    const cutoffSec = Math.floor((now - olderThanMs) / 1000)
    const oldest = db.query("SELECT MIN(second_ts) AS sec FROM ticks WHERE second_ts < ?").get(cutoffSec) as
      | { sec: number | null }
      | null
    if (oldest?.sec == null) return 0
    const hasMinute = db.query("SELECT 1 AS hit FROM ticks_minute WHERE min_ts = ?")
    const hasTick = db.query("SELECT 1 AS hit FROM ticks WHERE second_ts >= ? AND second_ts < ? LIMIT 1")
    const insert = db.query(
      `INSERT OR IGNORE INTO ticks_minute (min_ts, open, high, low, close, count, source)
       SELECT ?,
              (SELECT price FROM ticks WHERE second_ts >= ? AND second_ts < ? ORDER BY second_ts ASC LIMIT 1),
              MAX(price), MIN(price),
              (SELECT price FROM ticks WHERE second_ts >= ? AND second_ts < ? ORDER BY second_ts DESC LIMIT 1),
              COUNT(*),
              (SELECT source FROM ticks WHERE second_ts >= ? AND second_ts < ? ORDER BY second_ts DESC LIMIT 1)
       FROM ticks
       WHERE second_ts >= ? AND second_ts < ?`,
    )
    let minute = Math.floor(oldest.sec / 60) * 60
    let wrote = 0
    const write = db.transaction(() => {
      for (let step = 0; step < DOWNSAMPLE_MINUTES && minute < cutoffSec; step++) {
        const end = minute + 60
        if (!hasMinute.get(minute) && hasTick.get(minute, end)) {
          const result = insert.run(minute, minute, end, minute, end, minute, end, minute, end)
          wrote += Number((result as { changes?: number }).changes ?? 0)
        }
        minute = end
      }
    })
    write()
    return wrote
  } catch {
    return 0
  }
}

/** True when raw ticks older than the retention window are still in the ledger. */
export function ticksArchiveRemains(db: Database, now = Date.now()): boolean {
  try {
    const cutoffSec = Math.floor((now - TICKS_RAW_RETENTION_MS) / 1000)
    return db.query("SELECT 1 AS hit FROM ticks WHERE second_ts < ? LIMIT 1").get(cutoffSec) != null
  } catch {
    return false
  }
}

export type ArchiveReport = { files: string[]; rows: number; bytes: number }

export function archiveOldHealth(db: Database, dataDir: string, now = Date.now()): ArchiveReport {
  const report: ArchiveReport = { files: [], rows: 0, bytes: 0 }
  try {
    const rawCutoff = Math.floor((now - HEALTH_RAW_RETENTION_MS) / 1000) * 1000
    const minCutoff = Math.floor((now - HEALTH_MINUTE_RETENTION_MS) / 60000) * 60000
    const merge = (part: ArchiveReport): void => {
      report.files.push(...part.files)
      report.rows += part.rows
      report.bytes += part.bytes
    }
    // One batch per table per call keeps each archive run bounded (~8k rows
    // max). The hourly caller repeats until empty.
    merge(
      exportAndDelete(
        db,
        dataDir,
        "health-sample",
        "health-sample",
        `SELECT * FROM qm_health_sample WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH}`,
        `DELETE FROM qm_health_sample WHERE ts < ? AND ts IN (SELECT ts FROM qm_health_sample WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH})`,
        [rawCutoff],
        [rawCutoff, rawCutoff],
        now,
      ),
    )
    merge(
      exportAndDelete(
        db,
        dataDir,
        "health-route",
        "health-route",
        `SELECT * FROM qm_health_route WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH}`,
        `DELETE FROM qm_health_route WHERE ts < ? AND (ts, route) IN (SELECT ts, route FROM qm_health_route WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH})`,
        [rawCutoff],
        [rawCutoff, rawCutoff],
        now,
      ),
    )
    merge(
      exportAndDelete(
        db,
        dataDir,
        "health-query",
        "health-query",
        `SELECT * FROM qm_health_query WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH}`,
        `DELETE FROM qm_health_query WHERE ts < ? AND (ts, grp) IN (SELECT ts, grp FROM qm_health_query WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH})`,
        [rawCutoff],
        [rawCutoff, rawCutoff],
        now,
      ),
    )
    merge(
      exportAndDelete(
        db,
        dataDir,
        "health-minute",
        "health-minute",
        `SELECT * FROM qm_health_minute WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH}`,
        `DELETE FROM qm_health_minute WHERE ts < ? AND ts IN (SELECT ts FROM qm_health_minute WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH})`,
        [minCutoff],
        [minCutoff, minCutoff],
        now,
      ),
    )
    merge(
      exportAndDelete(
        db,
        dataDir,
        "health-route-minute",
        "health-route-minute",
        `SELECT * FROM qm_health_route_minute WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH}`,
        `DELETE FROM qm_health_route_minute WHERE ts < ? AND (ts, route) IN (SELECT ts, route FROM qm_health_route_minute WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH})`,
        [minCutoff],
        [minCutoff, minCutoff],
        now,
      ),
    )
    merge(
      exportAndDelete(
        db,
        dataDir,
        "health-query-minute",
        "health-query-minute",
        `SELECT * FROM qm_health_query_minute WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH}`,
        `DELETE FROM qm_health_query_minute WHERE ts < ? AND (ts, grp) IN (SELECT ts, grp FROM qm_health_query_minute WHERE ts < ? ORDER BY ts ASC LIMIT ${BATCH})`,
        [minCutoff],
        [minCutoff, minCutoff],
        now,
      ),
    )
    // Hang suspects are small but unbounded over months. Keep the newest 2000
    // live for instant forensics; everything older is gzipped, never dropped.
    try {
      const count = db.query("SELECT COUNT(*) AS n FROM qm_hangs").get() as { n: number }
      if (count.n > 2000) {
        merge(
          exportAndDelete(
            db,
            dataDir,
            "hangs",
            "hangs",
            `SELECT * FROM qm_hangs ORDER BY id ASC LIMIT ${BATCH}`,
            `DELETE FROM qm_hangs WHERE id IN (SELECT id FROM qm_hangs ORDER BY id ASC LIMIT ${BATCH})`,
            [],
            [],
            now,
          ),
        )
      }
    } catch {
      // ignore
    }
    return report
  } catch {
    return report
  }
}

/**
 * Compress raw ticks older than 30d: downsample first (ticks_minute lives in
 * the DB forever, ~1.4k rows/day), then gzip the raw rows and delete them.
 * Rounds/buy_ins retention is separate: archiveOldRounds below.
 */
export function archiveOldTicks(db: Database, dataDir: string, now = Date.now()): ArchiveReport {
  const report: ArchiveReport = { files: [], rows: 0, bytes: 0 }
  try {
    downsampleTicks(db, TICKS_RAW_RETENTION_MS, now)
    const cutoffSec = Math.floor((now - TICKS_RAW_RETENTION_MS) / 1000)
    const rows = db.query(`SELECT * FROM ticks WHERE second_ts < ? ORDER BY second_ts ASC LIMIT ${BATCH}`).all(cutoffSec) as Record<
      string,
      unknown
    >[]
    if (rows.length === 0) return report
    const secs = rows.map((row) => Number((row as { second_ts: number }).second_ts)).filter((n) => Number.isFinite(n))
    const from = Math.min(...secs)
    const to = Math.max(...secs)
    const name = `ticks-${from}-${to}.jsonl.gz`
    const path = archivePath(dataDir, name)
    if (!existsSync(path)) {
      const bytes = writeGzipJsonlSync(path, rows)
      report.bytes += bytes
      trackArchive(db, name, "ticks", from * 1000, to * 1000, rows.length, bytes, now)
    } else {
      trackArchive(db, name, "ticks", from * 1000, to * 1000, rows.length, 0, now)
    }
    db.query(`DELETE FROM ticks WHERE second_ts IN (SELECT second_ts FROM ticks WHERE second_ts < ? ORDER BY second_ts ASC LIMIT ${BATCH})`).run(
      cutoffSec,
    )
    report.files.push(name)
    report.rows += rows.length
    return report
  } catch {
    return report
  }
}

export function listArchives(db: Database, limit = 50): Record<string, unknown>[] {
  try {
    return db.query("SELECT * FROM qm_archives ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]
  } catch {
    return []
  }
}

export function archivesSizeBytes(dataDir: string): number {
  try {
    const dir = archivesDir(dataDir)
    let total = 0
    for (const name of readdirSync(dir)) {
      try {
        total += statSync(join(dir, name)).size
      } catch {
        // ignore
      }
    }
    return total
  } catch {
    return 0
  }
}

/** P3-3: live retention for settled/void rounds and their buy-ins. At ~440k
 *  buy-ins/day the live window must be days-scale or the DB outgrows any
 *  memory cap (RELIABILITY_PLAN 4.4.3), so the default keeps 3 days live and
 *  everything older is gzipped first — never dropped silently. Open rounds are
 *  never archived. */
export const ROUND_RETENTION_DEFAULT_MS = 3 * 24 * 60 * 60 * 1000
const ROUNDS_BATCH = 500

export function roundRetentionMs(env: { ROUND_RETENTION_MS?: string } = process.env): number {
  const raw = Number(env.ROUND_RETENTION_MS ?? "")
  if (Number.isFinite(raw) && raw >= 60_000) return Math.min(365 * 24 * 60 * 60 * 1000, Math.floor(raw))
  return ROUND_RETENTION_DEFAULT_MS
}

/** True when rounds older than the retention window are still live. */
export function roundsArchiveRemains(db: Database, now = Date.now()): boolean {
  try {
    const cutoff = now - roundRetentionMs()
    return db.query("SELECT 1 AS hit FROM rounds WHERE status != 'open' AND ends_at < ? LIMIT 1").get(cutoff) != null
  } catch {
    return false
  }
}

/**
 * Archive one batch of old settled/void rounds plus their buy-ins. The batch
 * takes any ROUNDS_BATCH matching rows — no ORDER BY, because no index orders
 * ends_at across chains and a sort would walk the whole closed set per call.
 * The partial rounds_closed_starts index filters the scan. The hourly caller
 * repeats until roundsArchiveRemains is false; each call makes monotonic
 * progress by deleting exactly the rows it archived.
 */
export function archiveOldRounds(db: Database, dataDir: string, now = Date.now()): ArchiveReport {
  const report: ArchiveReport = { files: [], rows: 0, bytes: 0 }
  try {
    const cutoff = now - roundRetentionMs()
    const rounds = db
      .query(`SELECT * FROM rounds WHERE status != 'open' AND ends_at < ? LIMIT ${ROUNDS_BATCH}`)
      .all(cutoff) as Record<string, unknown>[]
    if (rounds.length === 0) return report

    const idsByChain = new Map<string, number[]>()
    for (const round of rounds) {
      const chain = String(round.chain_key)
      const id = Number(round.id)
      const list = idsByChain.get(chain) ?? []
      list.push(id)
      idsByChain.set(chain, list)
    }
    const buys: Record<string, unknown>[] = []
    for (const [chain, ids] of idsByChain) {
      const marks = ids.map(() => "?").join(",")
      buys.push(
        ...(db.query(`SELECT * FROM buy_ins WHERE chain_key = ? AND round_id IN (${marks})`).all(chain, ...ids) as Record<
          string,
          unknown
        >[]),
      )
    }

    const ends = rounds.map((row) => Number(row.ends_at)).filter((n) => Number.isFinite(n))
    const from = ends.length > 0 ? Math.min(...ends) : now
    const to = ends.length > 0 ? Math.max(...ends) : now
    const roundsName = `rounds-${from}-${to}.jsonl.gz`
    const buysName = `buy-ins-${from}-${to}.jsonl.gz`
    const roundsPath = archivePath(dataDir, roundsName)
    const buysPath = archivePath(dataDir, buysName)
    // Crash between write and delete: the file exists on retry, so skip the
    // rewrite and still delete the live rows (same guard as exportAndDelete).
    const roundsBytes = existsSync(roundsPath) ? 0 : writeGzipJsonlSync(roundsPath, rounds)
    const buysBytes = existsSync(buysPath) ? 0 : writeGzipJsonlSync(buysPath, buys)
    trackArchive(db, roundsName, "rounds", from, to, rounds.length, roundsBytes, now)
    trackArchive(db, buysName, "round-buys", from, to, buys.length, buysBytes, now)

    const purge = db.transaction(() => {
      for (const [chain, ids] of idsByChain) {
        const marks = ids.map(() => "?").join(",")
        db.query(`DELETE FROM buy_ins WHERE chain_key = ? AND round_id IN (${marks})`).run(chain, ...ids)
        db.query(`DELETE FROM rounds WHERE chain_key = ? AND id IN (${marks}) AND status != 'open'`).run(chain, ...ids)
      }
    })
    purge()
    report.files.push(roundsName, buysName)
    report.rows += rounds.length + buys.length
    report.bytes += roundsBytes + buysBytes
    return report
  } catch {
    return report
  }
}
