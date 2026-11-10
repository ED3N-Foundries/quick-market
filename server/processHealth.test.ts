import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import {
  __resetProcessHealthForTest,
  heartbeatProcessHealth,
  initProcessHealth,
  noteBootFailure,
  noteFeedAdopt,
  noteFeedBreak,
  noteFeedLive,
  noteRequestError,
  noteTickError,
  noteTickOk,
  processHealthFileForDb,
  setProcessStatus,
  snapshotProcessHealth,
} from "./processHealth"

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "qm-proc-"))
}

describe("processHealth", () => {
  test("first boot has no previous run and ok status", () => {
    __resetProcessHealthForTest()
    const dir = freshDir()
    const snap = initProcessHealth({ dbPath: join(dir, "quick-market.sqlite"), installHandlers: false, startLagSampler: false })
    expect(snap.bootId.length).toBeGreaterThan(0)
    expect(snap.bootCount).toBe(1)
    expect(snap.previous).toBeNull()
    expect(snap.status).toBe("ok")
    heartbeatProcessHealth()
  })

  test("unclean shutdown is reported on next boot", () => {
    __resetProcessHealthForTest()
    const dir = freshDir()
    const file = join(dir, "process-health.json")
    initProcessHealth({ dbPath: join(dir, "quick-market.sqlite"), installHandlers: false, startLagSampler: false })
    noteTickError(new Error("boom-tick"))
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { cleanShutdown: boolean; status: string }
    expect(persisted.cleanShutdown).toBe(false)
    expect(persisted.status).toBe("down")

    __resetProcessHealthForTest()
    const second = initProcessHealth({ dbPath: join(dir, "quick-market.sqlite"), installHandlers: false, startLagSampler: false })
    expect(second.bootCount).toBe(2)
    expect(second.previous?.clean).toBe(false)
    expect(second.previous?.reason).toContain("boom-tick")
    expect(second.status).toBe("degraded")
  })

  test("boot failure records down status with reason", () => {
    __resetProcessHealthForTest()
    const dir = freshDir()
    initProcessHealth({ dbPath: join(dir, "quick-market.sqlite"), installHandlers: false, startLagSampler: false })
    noteBootFailure(new Error("no chain"))
    const snap = snapshotProcessHealth()
    expect(snap.status).toBe("down")
    expect(snap.reason).toContain("boot failed")
    expect(snap.lastError?.kind).toBe("boot")
  })

  test("feed break and adopt move status with reasons", () => {
    __resetProcessHealthForTest()
    const dir = freshDir()
    initProcessHealth({ dbPath: join(dir, "quick-market.sqlite"), installHandlers: false, startLagSampler: false })
    noteFeedBreak("binance", null, "no price change for 5.0s")
    expect(snapshotProcessHealth().status).toBe("down")
    noteFeedAdopt("bybit")
    // A down feed break needs an explicit live signal before clearing.
    expect(snapshotProcessHealth().status).toBe("down")
    setProcessStatus("degraded", "feed binance dropped → bybit")
    noteFeedAdopt("bybit")
    expect(snapshotProcessHealth().status).toBe("ok")
  })

  test("request errors degrade without hiding a down marker", () => {
    __resetProcessHealthForTest()
    const dir = freshDir()
    initProcessHealth({ dbPath: join(dir, "quick-market.sqlite"), installHandlers: false, startLagSampler: false })
    noteRequestError(new Error("db locked"), "/api/rounds")
    expect(snapshotProcessHealth().status).toBe("degraded")
    setProcessStatus("down", "tick failed: x")
    noteRequestError(new Error("later"), "/api/state")
    expect(snapshotProcessHealth().status).toBe("down")
    expect(snapshotProcessHealth().counters.requestErrors).toBe(2)
  })

  test("tick recovery clears a tick failure, feed live clears request errors", () => {
    __resetProcessHealthForTest()
    const dir = freshDir()
    initProcessHealth({ dbPath: join(dir, "quick-market.sqlite"), installHandlers: false, startLagSampler: false })
    noteRequestError(new Error("db locked"), "/api/rounds")
    noteFeedLive()
    expect(snapshotProcessHealth().status).toBe("ok")
    expect(snapshotProcessHealth().reason).toBe("feed live")
    noteTickError(new Error("bad tick"))
    expect(snapshotProcessHealth().status).toBe("down")
    noteFeedLive()
    expect(snapshotProcessHealth().status).toBe("down")
    noteTickOk("live")
    expect(snapshotProcessHealth().status).toBe("ok")
    expect(snapshotProcessHealth().reason).toContain("tick recovered")
  })

  test("file path derives from DB_PATH", () => {
    expect(processHealthFileForDb("/data/quick-market.sqlite")).toBe("/data/process-health.json")
    expect(processHealthFileForDb(":memory:")).toContain("process-health.json")
  })
})
