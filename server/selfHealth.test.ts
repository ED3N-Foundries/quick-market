import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useDatabase, getDb } from "./db"
import {
  __resetSelfHealthForTest,
  activeSpan,
  diskHealth,
  currentDisk,
  flushHealthSample,
  hangStats,
  HANG_LAG_MS,
  HIST_BOUNDS,
  noteLagSample,
  noteQuery,
  noteRequest,
  percentileOfHist,
  queryPercentiles,
  readRecentHangs,
  rollupHealthMinute,
  routePercentiles,
  SLOW_OP_MS,
  startLagWatchdog,
  stopLagWatchdog,
  timedQuery,
  __parsersForTest,
} from "./selfHealth"
import { __resetProcessHealthForTest, initProcessHealth } from "./processHealth"
import { archiveOldHealth, archiveOldTicks, downsampleTicks } from "./archive"

function freshDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-health-"))
  const path = join(dir, "market.sqlite")
  return { dir, path }
}

describe("selfHealth", () => {
  test("parsers handle /proc shapes", () => {
    const { parseMeminfo, parseCpuLine, cpuShares, diskHealth: dh } = __parsersForTest()
    const mem = parseMeminfo("MemTotal:        4000000 kB\nMemAvailable:    3000000 kB\nSwapTotal:       1000 kB\nSwapFree:         500 kB\n")
    expect(mem?.total).toBe(4000000 * 1024)
    expect(mem?.used).toBe(1000000 * 1024)
    const cpu = parseCpuLine("cpu  100 0 50 800 50 0 0 0 0 0")
    expect(cpu).not.toBeNull()
    const next = parseCpuLine("cpu  200 0 100 1600 100 0 0 0 0 0")
    expect(cpuShares(cpu!, next!)).toEqual({ user: 100, sys: 50, iowait: 50 })
    expect(dh(860, 1000).level).toBe("warn")
    expect(dh(940, 1000).level).toBe("down")
    expect(dh(100, 1000).level).toBe("ok")
    expect(diskHealth(0, 0).level).toBe("ok")
  })

  test("flush records disk and does not write histogram rows", () => {
    const { dir, path } = freshDb()
    try {
      __resetProcessHealthForTest()
      __resetSelfHealthForTest()
      initProcessHealth({ dbPath: path, installHandlers: false, startLagSampler: false })
      useDatabase(path)
      const db = getDb()
      noteRequest("GET /api/state", 12)
      noteQuery("board", 3)
      const ok = flushHealthSample({ db, dataDir: dir, dbPath: path, now: Date.now(), peers: 2, feed: "live", streamBoard: null })
      expect(ok).toBe(true)
      expect(db.query("SELECT COUNT(*) AS n FROM qm_health_sample").get()).toEqual({ n: 0 })
      expect(db.query("SELECT COUNT(*) AS n FROM qm_health_route").get()).toEqual({ n: 0 })
      expect(db.query("SELECT COUNT(*) AS n FROM qm_health_query").get()).toEqual({ n: 0 })
      expect(currentDisk()).not.toBeNull()
    } finally {
      useDatabase(":memory:")
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("timedQuery records durations without changing results", () => {
    __resetSelfHealthForTest()
    const out = timedQuery("board", () => 42)
    expect(out).toBe(42)
  })

  test("minute rollup aggregates samples and routes", () => {
    const { dir, path } = freshDb()
    try {
      __resetProcessHealthForTest()
      __resetSelfHealthForTest()
      initProcessHealth({ dbPath: path, installHandlers: false, startLagSampler: false })
      useDatabase(path)
      const db = getDb()
      const now = Date.now()
      const minuteStart = Math.floor(now / 60000) * 60000 - 60000
      const insert = db.query(
        `INSERT INTO qm_health_sample (ts, boot_id, boot_count, status, mem_total, mem_used, swap_used, cpu_user, cpu_sys, cpu_iowait, load1, disk_size, disk_used, db_bytes, self_rss, self_heap, self_external, self_cpu_ms, uptime_ms, peers, req_count, req_avg_ms, req_max_ms, q_count, q_avg_ms, q_max_ms, tick_count, tick_avg_ms, tick_max_ms, board_count, board_avg_ms, board_max_ms)
         VALUES (?, 'b1', 1, 'ok', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
      )
      for (let i = 0; i < 3; i++) insert.run(minuteStart + i * 10_000)
      const ok = rollupHealthMinute(db, minuteStart + 61_000)
      expect(ok).toBe(true)
      const minute = db.query("SELECT samples, req_count FROM qm_health_minute WHERE ts = ?").get(minuteStart) as {
        samples: number
        req_count: number
      } | null
      expect(minute?.samples).toBe(3)
      expect(minute?.req_count).toBe(3)
    } finally {
      useDatabase(":memory:")
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("old health rows archive to gzip before deletion", () => {
    const { dir, path } = freshDb()
    try {
      __resetProcessHealthForTest()
      __resetSelfHealthForTest()
      initProcessHealth({ dbPath: path, installHandlers: false, startLagSampler: false })
      useDatabase(path)
      const db = getDb()
      const now = Date.now()
      const old = now - 25 * 60 * 60 * 1000
      db.query(
        `INSERT INTO qm_health_sample (ts, boot_id, boot_count, status, mem_total, mem_used, swap_used, cpu_user, cpu_sys, cpu_iowait, load1, disk_size, disk_used, db_bytes, self_rss, self_heap, self_external, self_cpu_ms, uptime_ms, peers, req_count, req_avg_ms, req_max_ms, q_count, q_avg_ms, q_max_ms, tick_count, tick_avg_ms, tick_max_ms, board_count, board_avg_ms, board_max_ms)
         VALUES (?, 'b1', 1, 'ok', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
      ).run(Math.floor(old / 1000) * 1000)
      const report = archiveOldHealth(db, dir, now)
      expect(report.rows).toBeGreaterThanOrEqual(1)
      expect(report.files.length).toBeGreaterThanOrEqual(1)
      expect(db.query("SELECT COUNT(*) AS n FROM qm_health_sample WHERE ts < ?").get(Math.floor((now - 24 * 60 * 60 * 1000) / 1000) * 1000)).toEqual({
        n: 0,
      })
      expect(db.query("SELECT COUNT(*) AS n FROM qm_archives").get()).not.toEqual({ n: 0 })
    } finally {
      useDatabase(":memory:")
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("old ticks downsample then archive", () => {
    const { dir, path } = freshDb()
    try {
      __resetProcessHealthForTest()
      __resetSelfHealthForTest()
      initProcessHealth({ dbPath: path, installHandlers: false, startLagSampler: false })
      useDatabase(path)
      const db = getDb()
      const now = Date.now()
      const oldSec = Math.floor((now - 31 * 24 * 60 * 60 * 1000) / 1000)
      db.query("INSERT INTO ticks (second_ts, price, source, exchange_ts) VALUES (?, '100', 'binance', ?)").run(oldSec, oldSec * 1000)
      db.query("INSERT INTO ticks (second_ts, price, source, exchange_ts) VALUES (?, '101', 'binance', ?)").run(oldSec + 1, (oldSec + 1) * 1000)
      const down = downsampleTicks(db, 30 * 24 * 60 * 60 * 1000, now)
      expect(down).toBeGreaterThanOrEqual(1)
      const report = archiveOldTicks(db, dir, now)
      expect(report.rows).toBe(2)
      expect(db.query("SELECT COUNT(*) AS n FROM ticks").get()).toEqual({ n: 0 })
      expect(db.query("SELECT COUNT(*) AS n FROM ticks_minute").get()).not.toEqual({ n: 0 })
    } finally {
      useDatabase(":memory:")
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("percentile estimates follow the tail, not the mean", () => {
    // 90 fast + 10 slow: mean ~14ms hides the stall, p90+ must not.
    const hist = new Array(HIST_BOUNDS.length + 1).fill(0)
    const add = (ms: number): void => {
      let i = 0
      while (i < HIST_BOUNDS.length && ms > HIST_BOUNDS[i]!) i++
      hist[i]! += 1
    }
    for (let i = 0; i < 90; i++) add(5)
    for (let i = 0; i < 10; i++) add(1000)
    expect(percentileOfHist(hist, 50)).toBeLessThanOrEqual(10)
    expect(percentileOfHist(hist, 90)).toBeLessThanOrEqual(10)
    expect(percentileOfHist(hist, 95)).toBeGreaterThanOrEqual(1000)
    expect(percentileOfHist(hist, 99)).toBeGreaterThanOrEqual(1000)
    expect(percentileOfHist(new Array(HIST_BOUNDS.length + 1).fill(0), 99)).toBe(0)
  })

  test("windowed readers still merge histograms that already exist", () => {
    const { dir, path } = freshDb()
    try {
      __resetProcessHealthForTest()
      __resetSelfHealthForTest()
      initProcessHealth({ dbPath: path, installHandlers: false, startLagSampler: false })
      useDatabase(path)
      const db = getDb()
      const hist = new Array(HIST_BOUNDS.length + 1).fill(0)
      const add = (ms: number): void => {
        let i = 0
        while (i < HIST_BOUNDS.length && ms > HIST_BOUNDS[i]!) i++
        hist[i]! += 1
      }
      for (let i = 0; i < 9; i++) add(5)
      add(1200)
      const ts = Date.now()
      db.query(
        `INSERT INTO qm_health_route (ts, route, count, total_ms, max_ms, p50, p90, p95, p99, hist) VALUES (?, 'GET /api/state', 10, 100, 1200, 5, 5, 2500, 2500, ?)`,
      ).run(ts, JSON.stringify(hist))
      db.query(
        `INSERT INTO qm_health_query (ts, grp, count, total_ms, max_ms, hist) VALUES (?, 'board', 1, 3, 3, ?)`,
      ).run(ts, JSON.stringify(hist))
      noteRequest("GET /api/state", 1200)
      const ok = flushHealthSample({ db, dataDir: dir, dbPath: path, now: ts, peers: 0, feed: "live", streamBoard: null })
      expect(ok).toBe(true)
      expect(db.query("SELECT COUNT(*) AS n FROM qm_health_route").get()).toEqual({ n: 1 })
      const byRoute = routePercentiles(db, ts - 60 * 60 * 1000)
      expect(byRoute["GET /api/state"]?.p99).toBeGreaterThanOrEqual(1000)
      expect(byRoute["GET /api/state"]?.count).toBe(10)
      const byQuery = queryPercentiles(db, ts - 60 * 60 * 1000)
      expect(byQuery["board"]?.count).toBe(1)
    } finally {
      useDatabase(":memory:")
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("slow ops and lag stalls create attributed hang rows", () => {
    const { dir, path } = freshDb()
    try {
      __resetProcessHealthForTest()
      __resetSelfHealthForTest()
      initProcessHealth({ dbPath: path, installHandlers: false, startLagSampler: false })
      useDatabase(path)
      const db = getDb()
      expect(SLOW_OP_MS).toBe(100)
      noteQuery("advance", SLOW_OP_MS + 50)
      noteLagSample(HANG_LAG_MS + 100)
      const ok = flushHealthSample({ db, dataDir: dir, dbPath: path, now: Date.now(), peers: 0, feed: "live", streamBoard: null })
      expect(ok).toBe(true)
      const hangs = readRecentHangs(db, 10)
      expect(hangs.length).toBeGreaterThanOrEqual(2)
      const kinds = new Set(hangs.map((h) => h.kind))
      expect(kinds.has("slow-query")).toBe(true)
      expect(kinds.has("lag")).toBe(true)
      const lag = hangs.find((h) => h.kind === "lag")!
      expect(lag.name).toBe("event-loop")
      // The stall is attributed to the slowest op in the same interval.
      expect(lag.detail).toContain("advance")
      const stats = hangStats(db, Date.now() - 60 * 60 * 1000)
      expect(stats.count).toBeGreaterThanOrEqual(2)
      expect(stats.maxMs).toBeGreaterThanOrEqual(HANG_LAG_MS)
    } finally {
      useDatabase(":memory:")
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("timedQuery sets the active span while running", () => {
    __resetSelfHealthForTest()
    expect(activeSpan()).toBe("")
    timedQuery("advance", () => {
      expect(activeSpan()).toBe("advance")
    })
    expect(activeSpan()).toBe("")
  })

  test("lag watchdog starts and stops without breaking", () => {
    __resetSelfHealthForTest()
    startLagWatchdog()
    stopLagWatchdog()
    startLagWatchdog()
    stopLagWatchdog()
  })

  test("minute rollup merges histograms into route p99", () => {
    const { dir, path } = freshDb()
    try {
      __resetProcessHealthForTest()
      __resetSelfHealthForTest()
      initProcessHealth({ dbPath: path, installHandlers: false, startLagSampler: false })
      useDatabase(path)
      const db = getDb()
      const now = Date.now()
      const minuteStart = Math.floor(now / 60000) * 60000 - 60000
      const bucket = (ms: number): string => {
        const hist = new Array(HIST_BOUNDS.length + 1).fill(0)
        let i = 0
        while (i < HIST_BOUNDS.length && ms > HIST_BOUNDS[i]!) i++
        hist[i] = 1
        return JSON.stringify(hist)
      }
      const insert = db.query(
        `INSERT INTO qm_health_route (ts, route, count, total_ms, max_ms, hist) VALUES (?, 'GET /api/tape', 1, ?, ?, ?)`,
      )
      for (let i = 0; i < 5; i++) insert.run(minuteStart + i * 10_000, 4, 4, bucket(4))
      insert.run(minuteStart + 50_000, 1500, 1500, bucket(1500))
      expect(rollupHealthMinute(db, minuteStart + 61_000)).toBe(true)
      const row = db.query("SELECT count, p99 FROM qm_health_route_minute WHERE ts = ? AND route = 'GET /api/tape'").get(minuteStart) as {
        count: number
        p99: number
      } | null
      expect(row?.count).toBe(6)
      // One 1.5s stall in six samples: minute p99 must surface it.
      expect(row?.p99).toBeGreaterThanOrEqual(1000)
    } finally {
      useDatabase(":memory:")
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
