import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { dbShapeStats, getDb, useDatabase } from "./db"
import { archiveOldRounds, archivesDir, roundRetentionMs, roundsArchiveRemains } from "./archive"

test("old settled rounds and their buy-ins archive to gzip; open and recent rounds stay live", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-archive-"))
  useDatabase(":memory:")
  const db = getDb()
  const now = 10_000_000_000_000
  const old = now - roundRetentionMs() - 1
  const insertRound = db.query("INSERT INTO rounds (chain_key, id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?)")
  insertRound.run("base-sepolia", 1, old - 10_000, old, "settled")
  insertRound.run("base-sepolia", 2, old - 10_000, old, "void")
  insertRound.run("base-sepolia", 3, old - 10_000, old, "open") // old but open: never archived
  insertRound.run("base-sepolia", 4, now - 1_000, now, "settled") // recent: stays
  insertRound.run("near-testnet", 1, old - 10_000, old, "settled") // second chain in the batch
  const insertBet = db.query(
    "INSERT INTO buy_ins (chain_key, round_id, address, side, stake_micros, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
  insertBet.run("base-sepolia", 1, "0xold", "up", 100, old)
  insertBet.run("base-sepolia", 2, "0xold", "down", 50, old)
  insertBet.run("base-sepolia", 3, "0xopen", "up", 10, old)
  insertBet.run("base-sepolia", 4, "0xnew", "up", 20, now - 500)
  insertBet.run("near-testnet", 1, "near.testnet", "up", 30, old)

  const report = archiveOldRounds(db, dir, now)
  expect(report.rows).toBe(6) // 3 rounds + 3 buy-ins
  expect(report.files).toHaveLength(2)
  const roundsFile = report.files.find((name) => name.startsWith("rounds-"))!
  const buysFile = report.files.find((name) => name.startsWith("buy-ins-"))!
  expect(existsSync(join(archivesDir(dir), roundsFile))).toBe(true)
  expect(existsSync(join(archivesDir(dir), buysFile))).toBe(true)

  const roundRows = gunzipSync(readFileSync(join(archivesDir(dir), roundsFile)))
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { chain_key: string; id: number })
  expect(roundRows.map((row) => `${row.chain_key}/${row.id}`).sort()).toEqual([
    "base-sepolia/1",
    "base-sepolia/2",
    "near-testnet/1",
  ])
  const buyRows = gunzipSync(readFileSync(join(archivesDir(dir), buysFile)))
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { address: string })
  expect(buyRows.map((row) => row.address).sort()).toEqual(["0xold", "0xold", "near.testnet"])

  const liveIds = (db.query("SELECT id FROM rounds WHERE chain_key = 'base-sepolia' ORDER BY id").all() as { id: number }[])
    .map((row) => row.id)
  expect(liveIds).toEqual([3, 4])
  expect(db.query("SELECT COUNT(*) AS n FROM buy_ins WHERE chain_key = 'base-sepolia' AND round_id = 1").get()).toEqual({ n: 0 })
  expect(db.query("SELECT COUNT(*) AS n FROM buy_ins WHERE chain_key = 'base-sepolia' AND round_id = 3").get()).toEqual({ n: 1 })
  expect(db.query("SELECT COUNT(*) AS n FROM rounds WHERE chain_key = 'near-testnet'").get()).toEqual({ n: 0 })

  const kinds = (db.query("SELECT kind FROM qm_archives ORDER BY kind").all() as { kind: string }[]).map((row) => row.kind)
  expect(kinds).toEqual(["round-buys", "rounds"])
  expect(roundsArchiveRemains(db, now)).toBe(false)
  rmSync(dir, { recursive: true, force: true })
})

test("retention honors ROUND_RETENTION_MS and falls back on nonsense", () => {
  expect(roundRetentionMs({ ROUND_RETENTION_MS: "60000" })).toBe(60_000)
  expect(roundRetentionMs({ ROUND_RETENTION_MS: "nope" })).toBe(3 * 24 * 60 * 60 * 1000)
  expect(roundRetentionMs({ ROUND_RETENTION_MS: "1" })).toBe(3 * 24 * 60 * 60 * 1000)
  expect(roundRetentionMs({})).toBe(3 * 24 * 60 * 60 * 1000)
})

test("a batch larger than the cap drains over repeated calls and never touches recent rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-archive-"))
  useDatabase(":memory:")
  const db = getDb()
  const now = 10_000_000_000_000
  const old = now - roundRetentionMs() - 1
  const insertRound = db.query("INSERT INTO rounds (chain_key, id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, 'settled')")
  for (let index = 1; index <= 1_200; index++) insertRound.run("base-sepolia", index, old - 10_000, old - index)
  insertRound.run("base-sepolia", 9_999, now - 500, now - 100)

  let calls = 0
  while (roundsArchiveRemains(db, now) && calls < 10) {
    archiveOldRounds(db, dir, now)
    calls += 1
  }
  expect(calls).toBe(3) // 1200 rows / 500 per batch
  expect(db.query("SELECT COUNT(*) AS n FROM rounds").get()).toEqual({ n: 1 })
  expect((db.query("SELECT id FROM rounds").get() as { id: number }).id).toBe(9_999)
  const tracked = (db.query("SELECT COUNT(*) AS n FROM qm_archives").get() as { n: number }).n
  expect(tracked).toBe(6) // two files per batch
  rmSync(dir, { recursive: true, force: true })
})

test("dbShapeStats exposes the page gauges the archive relies on", () => {
  useDatabase(":memory:")
  const db = getDb()
  const shape = dbShapeStats(db)
  expect(shape.pageCount).toBeGreaterThan(0)
  expect(shape.pageSize).toBeGreaterThan(0)
  expect(shape.pageBytes).toBe(shape.pageCount * shape.pageSize)
  expect(shape.freelistPages).toBe(0)
  expect([0, 1, 2]).toContain(shape.autoVacuum)
})
