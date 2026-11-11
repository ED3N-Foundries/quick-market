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

/** Downsample raw ticks into per-minute OHLC so charts keep working after raw archival. */
export function downsampleTicks(db: Database, olderThanMs: number, now = Date.now()): number {
  try {
    const cutoffSec = Math.floor((now - olderThanMs) / 1000)
    const result = db.query(
      `INSERT OR IGNORE INTO ticks_minute (min_ts, open, high, low, close, count, source)
       SELECT m,
              (SELECT price FROM ticks WHERE CAST(second_ts / 60 AS INTEGER) = CAST(m / 60 AS INTEGER) ORDER BY second_ts ASC LIMIT 1),
              MAX(price), MIN(price),
              (SELECT price FROM ticks WHERE CAST(second_ts / 60 AS INTEGER) = CAST(m / 60 AS INTEGER) ORDER BY second_ts DESC LIMIT 1),
              COUNT(*),
              (SELECT source FROM ticks WHERE CAST(second_ts / 60 AS INTEGER) = CAST(m / 60 AS INTEGER) ORDER BY second_ts DESC LIMIT 1)
       FROM (SELECT CAST(second_ts / 60 AS INTEGER) * 60 AS m, price, source FROM ticks WHERE second_ts < ?)
       GROUP BY m`,
    ).run(cutoffSec)
    return Number((result as { changes?: number }).changes ?? 0)
  } catch {
    return 0
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
 * Rounds/buy_ins are never auto-deleted — the ledger stays complete.
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
