import { readFileSync, statSync } from "node:fs"
import { statfsSync } from "node:fs"
import type { Database } from "bun:sqlite"

// ---------------------------------------------------------------------------
// Quick Market self-health sampler.
//
// Logs host totals (mem/cpu/disk) + own usage + per-route / query timings into
// the same ledger SQLite file, in a performant way:
//   - one /proc read batch per 10s sample (no spawns, no /proc pid scans)
//   - in-memory aggregates flushed in a single transaction per sample
//   - raw 10s rows (24h hot) + 1-minute rollups (14d hot); older rows are
//     gzipped to archives/ before deletion so history is preserved on disk.
// ---------------------------------------------------------------------------

export const HEALTH_SAMPLE_MS = 10_000
export const HEALTH_RAW_RETENTION_MS = 24 * 60 * 60 * 1000
export const HEALTH_MINUTE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** Disk pressure thresholds. Crossed thresholds degrade the process status. */
export const DISK_WARN_FRACTION = 0.85
export const DISK_DOWN_FRACTION = 0.93
export const DISK_WARN_FREE_BYTES = 500 * 1024 * 1024
export const DISK_DOWN_FREE_BYTES = 200 * 1024 * 1024

export type HostTotals = {
  memTotal: number
  memUsed: number
  swapUsed: number
  cpuUser: number
  cpuSys: number
  cpuIowait: number
  load1: number
  diskSize: number
  diskUsed: number
  dbBytes: number
}

export type DiskNow = {
  at: number
  diskUsed: number
  diskSize: number
  dbBytes: number
}

let diskNow: DiskNow | null = null

/** Latest disk and ledger size. Updated by the slow sampler, not by the market loop. */
export function currentDisk(): DiskNow | null {
  return diskNow
}

type CpuCounters = { user: number; sys: number; iowait: number; total: number }

function parseMeminfo(text: string): { total: number; used: number; swapUsed: number } | null {
  const kb = (name: string): number | null => {
    for (const line of text.split("\n")) {
      if (!line.startsWith(name + ":")) continue
      const value = Number(line.split(/\s+/)[1])
      return Number.isFinite(value) ? value * 1024 : null
    }
    return null
  }
  const total = kb("MemTotal")
  const available = kb("MemAvailable") ?? kb("MemFree")
  if (total == null || available == null) return null
  const swapTotal = kb("SwapTotal") ?? 0
  const swapFree = kb("SwapFree") ?? 0
  return { total, used: Math.max(0, total - available), swapUsed: Math.max(0, (swapTotal ?? 0) - (swapFree ?? 0)) }
}

function parseCpuLine(line: string): CpuCounters | null {
  const parts = line.trim().split(/\s+/)
  if (parts[0] !== "cpu" || parts.length < 8) return null
  const n = (i: number): number => Number(parts[i] ?? 0)
  const user = n(1) + n(2)
  const sys = n(3) + n(6) + n(7) + n(8)
  const idle = n(4)
  const iowait = n(5)
  const total = user + sys + idle + iowait
  if (!Number.isFinite(total) || total <= 0) return null
  return { user, sys, iowait, total }
}

function cpuShares(prev: CpuCounters, next: CpuCounters): { user: number; sys: number; iowait: number } {
  const total = next.total - prev.total
  if (total <= 0) return { user: 0, sys: 0, iowait: 0 }
  const share = (delta: number): number => Math.max(0, Math.round((delta * 1000) / total))
  return { user: share(next.user - prev.user), sys: share(next.sys - prev.sys), iowait: share(next.iowait - prev.iowait) }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

export function sampleHostTotals(dataDir: string, dbPath: string, prevCpu: CpuCounters | null): { totals: HostTotals; cpu: CpuCounters | null } {
  const fallback: HostTotals = {
    memTotal: 0,
    memUsed: 0,
    swapUsed: 0,
    cpuUser: 0,
    cpuSys: 0,
    cpuIowait: 0,
    load1: 0,
    diskSize: 0,
    diskUsed: 0,
    dbBytes: 0,
  }
  let cpu: CpuCounters | null = prevCpu
  let shares = { user: 0, sys: 0, iowait: 0 }
  try {
    const stat = readText("/proc/stat")
    const next = stat ? parseCpuLine(stat.split("\n")[0] ?? "") : null
    if (next) {
      if (prevCpu) shares = cpuShares(prevCpu, next)
      cpu = next
    }
  } catch {
    // ignore
  }
  let mem = { total: 0, used: 0, swapUsed: 0 }
  try {
    const parsed = parseMeminfo(readText("/proc/meminfo") ?? "")
    if (parsed) mem = parsed
  } catch {
    // ignore
  }
  let load1 = 0
  try {
    const raw = readText("/proc/loadavg") ?? ""
    const value = Number(raw.trim().split(/\s+/)[0])
    if (Number.isFinite(value)) load1 = value
  } catch {
    // ignore
  }
  let diskSize = 0
  let diskUsed = 0
  try {
    const fs = statfsSync(dataDir)
    const bsize = Number(fs.bsize)
    const blocks = Number(fs.blocks)
    const bavail = Number(fs.bavail)
    if (Number.isFinite(bsize) && Number.isFinite(blocks)) {
      diskSize = blocks * bsize
      diskUsed = Math.max(0, (blocks - (Number.isFinite(bavail) ? bavail : 0)) * bsize)
    }
  } catch {
    try {
      const fs = statfsSync("/")
      const bsize = Number(fs.bsize)
      const blocks = Number(fs.blocks)
      const bavail = Number(fs.bavail)
      if (Number.isFinite(bsize) && Number.isFinite(blocks)) {
        diskSize = blocks * bsize
        diskUsed = Math.max(0, (blocks - (Number.isFinite(bavail) ? bavail : 0)) * bsize)
      }
    } catch {
      // ignore
    }
  }
  let dbBytes = 0
  try {
    if (dbPath && dbPath !== ":memory:") {
      dbBytes = statSync(dbPath).size
      try {
        dbBytes += statSync(`${dbPath}-wal`).size
      } catch {
        // no wal
      }
    }
  } catch {
    // ignore
  }
  return {
    totals: {
      ...fallback,
      memTotal: mem.total,
      memUsed: mem.used,
      swapUsed: mem.swapUsed,
      cpuUser: shares.user,
      cpuSys: shares.sys,
      cpuIowait: shares.iowait,
      load1: Math.round(load1 * 100),
      diskSize,
      diskUsed,
      dbBytes,
    },
    cpu,
  }
}

export function diskHealth(diskUsed: number, diskSize: number): { level: "ok" | "warn" | "down"; fraction: number; free: number } {
  if (!(diskSize > 0)) return { level: "ok", fraction: 0, free: 0 }
  const fraction = diskUsed / diskSize
  const free = Math.max(0, diskSize - diskUsed)
  // Absolute free-space floors only apply to real disks (>=1GB). Unit tests
  // and tiny tmpfs mounts use fraction-only logic.
  const useAbsolute = diskSize >= 1024 * 1024 * 1024
  if (fraction >= DISK_DOWN_FRACTION || (useAbsolute && free > 0 && free < DISK_DOWN_FREE_BYTES)) return { level: "down", fraction, free }
  if (fraction >= DISK_WARN_FRACTION || (useAbsolute && free > 0 && free < DISK_WARN_FREE_BYTES)) return { level: "warn", fraction, free }
  return { level: "ok", fraction, free }
}

// --- in-memory aggregates (reset each sample) --------------------------------

// Latency histogram bounds (ms). 14 buckets: <= each bound, last is overflow.
// p50/p90/p95/p99 are estimated from these buckets. Averages hide hangs;
// a single 5s block barely moves the mean but owns the p99.
export const HIST_BOUNDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
export const HIST_LEN = HIST_BOUNDS.length + 1

/** A request slower than this is recorded as a hang suspect (attribution). */
export const SLOW_OP_MS = 100
/** Event-loop delay above this records a stall event. */
export const HANG_LAG_MS = 250
const MAX_HANGS_PER_FLUSH = 16
const MAX_SLOW_TRACKED = 64

function newHist(): number[] {
  return new Array<number>(HIST_LEN).fill(0)
}

function histAdd(hist: number[], ms: number): void {
  let i = 0
  while (i < HIST_BOUNDS.length && ms > HIST_BOUNDS[i]!) i++
  hist[i]! += 1
}

function mergeHistInto(dst: number[], src: number[] | null | undefined): void {
  if (!src) return
  for (let i = 0; i < HIST_LEN; i++) dst[i]! += src[i] ?? 0
}

/** Upper-bound percentile estimate from bucket counts. Returns 0 when empty. */
export function percentileOfHist(hist: ArrayLike<number>, q: number): number {
  let total = 0
  for (let i = 0; i < HIST_LEN; i++) total += hist[i] ?? 0
  if (total <= 0) return 0
  const rank = Math.ceil((q / 100) * total)
  let acc = 0
  for (let i = 0; i < HIST_LEN; i++) {
    acc += hist[i] ?? 0
    if (acc >= rank) return i < HIST_BOUNDS.length ? HIST_BOUNDS[i]! : HIST_BOUNDS[HIST_BOUNDS.length - 1]! * 2
  }
  return HIST_BOUNDS[HIST_BOUNDS.length - 1]! * 2
}

function histPercentiles(hist: number[]): { p50: number; p90: number; p95: number; p99: number } {
  return { p50: percentileOfHist(hist, 50), p90: percentileOfHist(hist, 90), p95: percentileOfHist(hist, 95), p99: percentileOfHist(hist, 99) }
}

function encodeHist(hist: number[]): string {
  return `[${hist.join(",")}]`
}

function decodeHist(text: unknown): number[] | null {
  if (typeof text !== "string" || text.length > 1024) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed) || parsed.length !== HIST_LEN) return null
    const out = newHist()
    for (let i = 0; i < HIST_LEN; i++) {
      const n = Number(parsed[i])
      if (!Number.isFinite(n) || n < 0 || n > 1e9) return null
      out[i] = Math.floor(n)
    }
    return out
  } catch {
    return null
  }
}

export type Agg = { count: number; totalMs: number; maxMs: number; hist: number[] }

function newAgg(): Agg {
  return { count: 0, totalMs: 0, maxMs: 0, hist: newHist() }
}

export type HangEvent = { ts: number; durationMs: number; kind: string; name: string; detail: string | null }

function addAgg(agg: Agg, ms: number): void {
  if (!(ms >= 0) || !Number.isFinite(ms)) return
  agg.count += 1
  agg.totalMs += ms
  if (ms > agg.maxMs) agg.maxMs = ms
  histAdd(agg.hist, ms)
}

export type SelfHealthState = {
  routes: Map<string, Agg>
  queries: Map<string, Agg>
  tick: Agg
  board: Agg
  lag: Agg
  slowTracked: number
  slowest: { kind: string; name: string; ms: number } | null
  hangs: HangEvent[]
  prevCpu: CpuCounters | null
  prevSelfCpu: { user: number; system: number } | null
  prevBoardCount: number
  prevBoardTotalMs: number
  lastSampleAt: number
  lastMinuteAt: number
  lastArchiveAt: number
  timer: ReturnType<typeof setInterval> | null
  lagTimer: ReturnType<typeof setInterval> | null
  lagExpectedAt: number
}

export function createSelfHealthState(): SelfHealthState {
  return {
    routes: new Map(),
    queries: new Map(),
    tick: newAgg(),
    board: newAgg(),
    lag: newAgg(),
    slowTracked: 0,
    slowest: null,
    hangs: [],
    prevCpu: null,
    prevSelfCpu: null,
    prevBoardCount: 0,
    prevBoardTotalMs: 0,
    lastSampleAt: 0,
    lastMinuteAt: 0,
    lastArchiveAt: 0,
    timer: null,
    lagTimer: null,
    lagExpectedAt: 0,
  }
}

// Module-level default state used by request/query instrumentation.
let defaultState: SelfHealthState = createSelfHealthState()

/** Test hook: reset module state. */
export function __resetSelfHealthForTest(): void {
  if (defaultState.timer) clearInterval(defaultState.timer)
  if (defaultState.lagTimer) clearInterval(defaultState.lagTimer)
  defaultState = createSelfHealthState()
  spanDepth = 0
  diskNow = null
}

// Active instrumented span (innermost timedQuery group). Single-threaded, so a
// plain counter + current name is enough; async gaps never hold a span because
// timedQuery only wraps sync sections.
let spanDepth = 0
let currentSpan = ""

export function activeSpan(): string {
  return currentSpan
}

function trackSlow(kind: string, name: string, ms: number, state: SelfHealthState): void {
  if (!(ms >= SLOW_OP_MS) || !Number.isFinite(ms)) {
    if (ms > (state.slowest?.ms ?? -1) && Number.isFinite(ms)) state.slowest = { kind, name, ms }
    return
  }
  if (ms > (state.slowest?.ms ?? -1)) state.slowest = { kind, name, ms }
  if (state.slowTracked >= MAX_SLOW_TRACKED) return
  state.slowTracked += 1
  state.hangs.push({ ts: Date.now(), durationMs: Math.round(ms * 10) / 10, kind, name, detail: null })
}

export function selfHealthState(): SelfHealthState {
  return defaultState
}

const ROUTE_CAP = 64

export function noteRequest(route: string, ms: number, state: SelfHealthState = defaultState): void {
  try {
    const key = route.slice(0, 96) || "unknown"
    let agg = state.routes.get(key)
    if (!agg) {
      if (state.routes.size >= ROUTE_CAP) return
      agg = newAgg()
      state.routes.set(key, agg)
    }
    addAgg(agg, ms)
    trackSlow("slow-req", key, ms, state)
  } catch {
    // never break requests
  }
}

export function noteQuery(group: string, ms: number, state: SelfHealthState = defaultState): void {
  try {
    const key = group.slice(0, 64) || "unknown"
    let agg = state.queries.get(key)
    if (!agg) {
      if (state.queries.size >= ROUTE_CAP) return
      agg = newAgg()
      state.queries.set(key, agg)
    }
    addAgg(agg, ms)
    trackSlow("slow-query", key, ms, state)
  } catch {
    // ignore
  }
}

export function noteTickSample(ms: number, state: SelfHealthState = defaultState): void {
  try {
    addAgg(state.tick, ms)
    trackSlow("slow-tick", "tick", ms, state)
  } catch {
    // ignore
  }
}

export function noteBoardSample(ms: number, state: SelfHealthState = defaultState): void {
  try {
    addAgg(state.board, ms)
    trackSlow("slow-board", "board", ms, state)
  } catch {
    // ignore
  }
}

/** Event-loop stall sample. Delays >= HANG_LAG_MS become hang events. */
export function noteLagSample(ms: number, state: SelfHealthState = defaultState): void {
  try {
    if (!(ms >= 0) || !Number.isFinite(ms)) return
    addAgg(state.lag, ms)
    if (ms >= HANG_LAG_MS) {
      if (state.slowTracked >= MAX_SLOW_TRACKED) return
      state.slowTracked += 1
      const slow = state.slowest
      state.hangs.push({
        ts: Date.now(),
        durationMs: Math.round(ms * 10) / 10,
        kind: "lag",
        name: "event-loop",
        detail: slow ? `${slow.kind}:${slow.name} ${Math.round(slow.ms * 10) / 10}ms` : null,
      })
    }
  } catch {
    // ignore
  }
}

/** 1s stall probe. Measures timer drift; drift is the stall duration. */
export function startLagWatchdog(state: SelfHealthState = defaultState, intervalMs = 1000): void {
  if (state.lagTimer) return
  state.lagExpectedAt = Date.now() + intervalMs
  try {
    state.lagTimer = setInterval(() => {
      const now = Date.now()
      const drift = now - state.lagExpectedAt
      state.lagExpectedAt = now + intervalMs
      // Timer slop under ~5ms is normal; still record so p50 is honest.
      noteLagSample(Math.max(0, drift), state)
    }, intervalMs)
    ;(state.lagTimer as unknown as { unref?: () => void }).unref?.()
  } catch {
    state.lagTimer = null
  }
}

export function stopLagWatchdog(state: SelfHealthState = defaultState): void {
  if (state.lagTimer) clearInterval(state.lagTimer)
  state.lagTimer = null
}

/** Wrap a sync function and record its duration under a query group. */
export function timedQuery<T>(group: string, fn: () => T, state: SelfHealthState = defaultState): T {
  const start = performance.now()
  const outer = currentSpan
  currentSpan = group
  spanDepth += 1
  try {
    return fn()
  } finally {
    spanDepth = Math.max(0, spanDepth - 1)
    if (spanDepth === 0) currentSpan = ""
    else currentSpan = outer
    noteQuery(group, performance.now() - start, state)
  }
}

export type SampleInput = {
  db: Database
  dataDir: string
  dbPath: string
  now: number
  peers?: number
  feed?: string
  streamBoard?: { count: number; totalMs: number; maxMs: number; lastMs: number } | null
  onDiskPressure?: (level: "warn" | "down", fraction: number, free: number) => void
  state?: SelfHealthState
}

export function flushHealthSample(input: SampleInput): boolean {
  const state = input.state ?? defaultState
  try {
    const { totals, cpu } = sampleHostTotals(input.dataDir, input.dbPath, state.prevCpu)
    state.prevCpu = cpu
    const ts = Math.floor(input.now / 1000) * 1000
    diskNow = { at: input.now, diskUsed: totals.diskUsed, diskSize: totals.diskSize, dbBytes: totals.dbBytes }
    // Stall rows only. Route and query histograms stay out of the ledger.
    const hangs = [...state.hangs].sort((a, b) => b.durationMs - a.durationMs).slice(0, MAX_HANGS_PER_FLUSH)
    if (hangs.length > 0) {
      const write = input.db.transaction(() => {
        const hangWrite = input.db.query(
          `INSERT INTO qm_hangs (ts, duration_ms, kind, name, detail) VALUES (?, ?, ?, ?, ?)`,
        )
        for (const hang of hangs) {
          hangWrite.run(ts, hang.durationMs, hang.kind.slice(0, 32), hang.name.slice(0, 96), hang.detail ? hang.detail.slice(0, 300) : null)
        }
      })
      write()
    }
    // Disk pressure surfaces through the callback so the caller can degrade
    // process status (crash forensics: a full disk looks like a hang).
    try {
      const health = diskHealth(totals.diskUsed, totals.diskSize)
      if (health.level !== "ok") input.onDiskPressure?.(health.level, health.fraction, health.free)
    } catch {
      // ignore
    }
    state.routes.clear()
    state.queries.clear()
    state.tick = newAgg()
    state.board = newAgg()
    state.lag = newAgg()
    state.hangs.length = 0
    state.slowTracked = 0
    state.slowest = null
    state.lastSampleAt = input.now
    return true
  } catch {
    // Health logging must never break the market. Clear aggregates so a
    // poisoned interval does not grow memory without bound.
    try {
      state.routes.clear()
      state.queries.clear()
      state.tick = newAgg()
      state.board = newAgg()
      state.lag = newAgg()
      state.hangs.length = 0
      state.slowTracked = 0
      state.slowest = null
    } catch {
      // ignore
    }
    return false
  }
}

export function rollupHealthMinute(db: Database, now: number): boolean {
  try {
    const minuteTs = Math.floor(now / 60000) * 60000 - 60000
    if (minuteTs <= 0) return false
    const exists = db.query("SELECT 1 FROM qm_health_minute WHERE ts = ?").get(minuteTs)
    if (exists) return true
    const start = minuteTs
    const end = minuteTs + 60000
    db.transaction(() => {
      // Percentile columns are backfilled below by merging raw histograms;
      // the SQL keeps count/avg/max which merge exactly.
      db.run(
        `INSERT OR IGNORE INTO qm_health_minute
         (ts, samples, boot_count, mem_avg, mem_max, self_rss_avg, self_rss_max,
          cpu_avg, cpu_max, lag_avg, lag_max, disk_used, disk_size, db_bytes,
          req_count, req_avg_ms, req_max_ms, q_count, q_avg_ms, q_max_ms,
          tick_avg_ms, tick_max_ms, board_avg_ms, board_max_ms, peers_max, feed)
         SELECT ?, COUNT(*), MAX(boot_count),
                CAST(ROUND(AVG(mem_used)) AS INTEGER), MAX(mem_used),
                CAST(ROUND(AVG(self_rss)) AS INTEGER), MAX(self_rss),
                CAST(ROUND(AVG(cpu_user + cpu_sys)) AS INTEGER), MAX(cpu_user + cpu_sys),
                AVG(lag_ms), MAX(lag_max), MAX(disk_used), MAX(disk_size), MAX(db_bytes),
                COALESCE(SUM(req_count), 0),
                CASE WHEN SUM(req_count) > 0 THEN SUM(req_count * req_avg_ms) / SUM(req_count) ELSE 0 END,
                MAX(req_max_ms),
                COALESCE(SUM(q_count), 0),
                CASE WHEN SUM(q_count) > 0 THEN SUM(q_count * q_avg_ms) / SUM(q_count) ELSE 0 END,
                MAX(q_max_ms),
                CASE WHEN SUM(tick_count) > 0 THEN SUM(tick_count * tick_avg_ms) / SUM(tick_count) ELSE 0 END,
                MAX(tick_max_ms),
                CASE WHEN SUM(board_count) > 0 THEN SUM(board_count * board_avg_ms) / SUM(board_count) ELSE 0 END,
                MAX(board_max_ms),
                MAX(peers), MAX(feed)
         FROM qm_health_sample WHERE ts >= ? AND ts < ?`,
        minuteTs,
        start,
        end,
      )
      // Merge raw histograms for honest minute-level p50/p90/p95/p99.
      // Averaging per-sample p99s would understate the true tail.
      const reqHist = newHist()
      const qHist = newHist()
      try {
        const rh = db.query(`SELECT hist FROM qm_health_route WHERE ts >= ? AND ts < ? LIMIT 5000`).all(start, end) as { hist: unknown }[]
        for (const row of rh) mergeHistInto(reqHist, decodeHist(row.hist))
        const qh = db.query(`SELECT hist FROM qm_health_query WHERE ts >= ? AND ts < ? LIMIT 5000`).all(start, end) as { hist: unknown }[]
        for (const row of qh) mergeHistInto(qHist, decodeHist(row.hist))
      } catch {
        // ignore
      }
      const reqP = histPercentiles(reqHist)
      const qP = histPercentiles(qHist)
      try {
        // Tick/board/lag tails: MAX of the per-sample p99 is an honest upper
        // bound for the minute (a single 5s block owns the minute tail).
        const tails = db.query(
          `SELECT MAX(tick_p99) AS tp, MAX(board_p99) AS bp, MAX(lag_p99) AS lp,
                  MAX(tick_p50) AS t5, MAX(board_p50) AS b5, MAX(lag_p50) AS l5,
                  MAX(tick_p90) AS t9, MAX(board_p90) AS b9, MAX(lag_p90) AS l9,
                  MAX(tick_p95) AS t95, MAX(board_p95) AS b95, MAX(lag_p95) AS l95
           FROM qm_health_sample WHERE ts >= ? AND ts < ?`,
        ).get(start, end) as {
          tp: number | null; bp: number | null; lp: number | null
          t5: number | null; b5: number | null; l5: number | null
          t9: number | null; b9: number | null; l9: number | null
          t95: number | null; b95: number | null; l95: number | null
        } | null
        db.run(
          `UPDATE qm_health_minute SET req_p50 = ?, req_p90 = ?, req_p95 = ?, req_p99 = ?,
            q_p50 = ?, q_p90 = ?, q_p95 = ?, q_p99 = ?,
            tick_p50 = ?, tick_p90 = ?, tick_p95 = ?, tick_p99 = ?,
            board_p50 = ?, board_p90 = ?, board_p95 = ?, board_p99 = ?,
            lag_p50 = ?, lag_p90 = ?, lag_p95 = ?, lag_p99 = ? WHERE ts = ?`,
          reqP.p50, reqP.p90, reqP.p95, reqP.p99, qP.p50, qP.p90, qP.p95, qP.p99,
          tails?.t5 ?? 0, tails?.t9 ?? 0, tails?.t95 ?? 0, tails?.tp ?? 0,
          tails?.b5 ?? 0, tails?.b9 ?? 0, tails?.b95 ?? 0, tails?.bp ?? 0,
          tails?.l5 ?? 0, tails?.l9 ?? 0, tails?.l95 ?? 0, tails?.lp ?? 0, minuteTs,
        )
      } catch {
        // columns may not exist on very old DBs; ensureHealthPxxColumns covers new opens
      }
      const routes = db.query(
        `SELECT route, SUM(count) AS n, SUM(total_ms) AS t, MAX(max_ms) AS m
         FROM qm_health_route WHERE ts >= ? AND ts < ? GROUP BY route`,
      ).all(start, end) as { route: string; n: number; t: number; m: number }[]
      const write = db.query(
        `INSERT OR IGNORE INTO qm_health_route_minute (ts, route, count, avg_ms, max_ms) VALUES (?, ?, ?, ?, ?)`,
      )
      for (const row of routes) {
        if (!row.route || !(row.n > 0)) continue
        write.run(minuteTs, row.route, row.n, row.t / row.n, row.m)
      }
      try {
        const rhists = db.query(`SELECT route, hist FROM qm_health_route WHERE ts >= ? AND ts < ? LIMIT 5000`).all(start, end) as {
          route: string
          hist: unknown
        }[]
        const byRoute = new Map<string, number[]>()
        for (const row of rhists) {
          let h = byRoute.get(row.route)
          if (!h) {
            h = newHist()
            byRoute.set(row.route, h)
          }
          mergeHistInto(h, decodeHist(row.hist))
        }
        const pwrite = db.query(`UPDATE qm_health_route_minute SET p50 = ?, p90 = ?, p95 = ?, p99 = ? WHERE ts = ? AND route = ?`)
        for (const [route, h] of byRoute) {
          const p = histPercentiles(h)
          try {
            pwrite.run(p.p50, p.p90, p.p95, p.p99, minuteTs, route)
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      const queries = db.query(
        `SELECT grp, SUM(count) AS n, SUM(total_ms) AS t, MAX(max_ms) AS m
         FROM qm_health_query WHERE ts >= ? AND ts < ? GROUP BY grp`,
      ).all(start, end) as { grp: string; n: number; t: number; m: number }[]
      const qwrite = db.query(
        `INSERT OR IGNORE INTO qm_health_query_minute (ts, grp, count, avg_ms, max_ms) VALUES (?, ?, ?, ?, ?)`,
      )
      for (const row of queries) {
        if (!row.grp || !(row.n > 0)) continue
        qwrite.run(minuteTs, row.grp, row.n, row.t / row.n, row.m)
      }
      try {
        const qhists = db.query(`SELECT grp, hist FROM qm_health_query WHERE ts >= ? AND ts < ? LIMIT 5000`).all(start, end) as {
          grp: string
          hist: unknown
        }[]
        const byGrp = new Map<string, number[]>()
        for (const row of qhists) {
          let h = byGrp.get(row.grp)
          if (!h) {
            h = newHist()
            byGrp.set(row.grp, h)
          }
          mergeHistInto(h, decodeHist(row.hist))
        }
        const pqwrite = db.query(`UPDATE qm_health_query_minute SET p50 = ?, p90 = ?, p95 = ?, p99 = ? WHERE ts = ? AND grp = ?`)
        for (const [grp, h] of byGrp) {
          const p = histPercentiles(h)
          try {
            pqwrite.run(p.p50, p.p90, p.p95, p.p99, minuteTs, grp)
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    })()
    return true
  } catch {
    return false
  }
}

export function readRecentHealth(
  db: Database,
  options: { limit?: number; bootId?: string } = {},
): { samples: Record<string, unknown>[]; routes: Record<string, unknown>[] } {
  const limit = Math.min(Math.max(options.limit ?? 36, 1), 216)
  try {
    const samples = (
      options.bootId
        ? db.query("SELECT * FROM qm_health_sample WHERE boot_id = ? ORDER BY ts DESC LIMIT ?").all(options.bootId, limit)
        : db.query("SELECT * FROM qm_health_sample ORDER BY ts DESC LIMIT ?").all(limit)
    ) as Record<string, unknown>[]
    const from = samples.length > 0 ? (samples[samples.length - 1] as { ts: number }).ts : 0
    const routes = (
      from > 0
        ? db.query("SELECT * FROM qm_health_route WHERE ts >= ? ORDER BY ts DESC LIMIT 500").all(from)
        : []
    ) as Record<string, unknown>[]
    return { samples, routes }
  } catch {
    return { samples: [], routes: [] }
  }
}

export function averageQueryStats(db: Database, sinceMs: number): Record<string, { count: number; avgMs: number; maxMs: number }> {
  try {
    const rows = db.query(
      `SELECT grp, SUM(count) AS n, SUM(total_ms) AS t, MAX(max_ms) AS m
       FROM qm_health_query WHERE ts >= ? GROUP BY grp ORDER BY t DESC`,
    ).all(sinceMs) as { grp: string; n: number; t: number; m: number }[]
    const out: Record<string, { count: number; avgMs: number; maxMs: number }> = {}
    for (const row of rows) {
      if (!row.grp || !(row.n > 0)) continue
      out[row.grp] = { count: row.n, avgMs: row.t / row.n, maxMs: row.m }
    }
    return out
  } catch {
    return {}
  }
}

export type PercentileStats = { count: number; avgMs: number; maxMs: number; p50: number; p90: number; p95: number; p99: number }

/** Merge raw route/query histograms over a window for honest pXX. Bounded scan. */
function windowPercentiles(db: Database, table: "qm_health_route" | "qm_health_query", keyCol: "route" | "grp", sinceMs: number): Record<string, PercentileStats> {
  const out: Record<string, PercentileStats> = {}
  try {
    const rows = db.query(
      `SELECT ${keyCol} AS k, SUM(count) AS n, SUM(total_ms) AS t, MAX(max_ms) AS m
       FROM ${table} WHERE ts >= ? GROUP BY ${keyCol} LIMIT 128`,
    ).all(sinceMs) as { k: string; n: number; t: number; m: number }[]
    const hists = db.query(
      `SELECT ${keyCol} AS k, hist FROM ${table} WHERE ts >= ? LIMIT 5000`,
    ).all(sinceMs) as { k: string; hist: unknown }[]
    const byKey = new Map<string, number[]>()
    for (const row of hists) {
      const h = decodeHist(row.hist)
      if (!h || !row.k) continue
      let acc = byKey.get(row.k)
      if (!acc) {
        acc = newHist()
        byKey.set(row.k, acc)
      }
      mergeHistInto(acc, h)
    }
    for (const row of rows) {
      if (!row.k || !(row.n > 0)) continue
      const p = histPercentiles(byKey.get(row.k) ?? newHist())
      out[row.k] = { count: row.n, avgMs: row.t / row.n, maxMs: row.m, ...p }
    }
  } catch {
    // ignore
  }
  return out
}

export function routePercentiles(db: Database, sinceMs: number): Record<string, PercentileStats> {
  return windowPercentiles(db, "qm_health_route", "route", sinceMs)
}

export function queryPercentiles(db: Database, sinceMs: number): Record<string, PercentileStats> {
  return windowPercentiles(db, "qm_health_query", "grp", sinceMs)
}

export type HangRow = { id: number; ts: number; duration_ms: number; kind: string; name: string; detail: string | null }

export function readRecentHangs(db: Database, limit = 20): HangRow[] {
  try {
    return db.query("SELECT id, ts, duration_ms, kind, name, detail FROM qm_hangs ORDER BY duration_ms DESC, ts DESC LIMIT ?").all(
      Math.min(Math.max(limit, 1), 100),
    ) as HangRow[]
  } catch {
    return []
  }
}

export function hangStats(db: Database, sinceMs: number): { count: number; maxMs: number; lastTs: number | null } {
  try {
    const row = db.query(
      `SELECT COUNT(*) AS n, MAX(duration_ms) AS m, MAX(ts) AS t FROM qm_hangs WHERE ts >= ?`,
    ).get(sinceMs) as { n: number; m: number | null; t: number | null }
    return { count: row.n ?? 0, maxMs: row.m ?? 0, lastTs: row.t ?? null }
  } catch {
    return { count: 0, maxMs: 0, lastTs: null }
  }
}

export function __testOnly(): {
  encodeHist: typeof encodeHist
  decodeHist: typeof decodeHist
  mergeHistInto: typeof mergeHistInto
} {
  return { encodeHist, decodeHist, mergeHistInto }
}

export function __parsersForTest(): {
  parseMeminfo: typeof parseMeminfo
  parseCpuLine: typeof parseCpuLine
  cpuShares: typeof cpuShares
  diskHealth: typeof diskHealth
} {
  return { parseMeminfo, parseCpuLine, cpuShares, diskHealth }
}
