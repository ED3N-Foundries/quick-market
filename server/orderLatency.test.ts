import { describe, expect, test } from "bun:test"
import { ORDER_LATENCY_WINDOW_MS, OrderLatency } from "./orderLatency"

const NOW = 1_800_000_000_000

describe("OrderLatency", () => {
  test("keeps sources and stages separate", () => {
    const metrics = new OrderLatency()
    metrics.note("user", "serverAcceptMs", 4, NOW)
    metrics.note("user", "clientAckMs", 40, NOW)
    metrics.note("agent", "serverAcceptMs", 12, NOW)
    metrics.note("agent", "serverBookMs", 8, NOW)
    metrics.reject("agent", NOW)
    metrics.missBook(NOW)

    const snapshot = metrics.snapshot(NOW)
    expect(snapshot.user.serverAcceptMs?.count).toBe(1)
    expect(snapshot.user.serverAcceptMs?.maxMs).toBe(4)
    expect(snapshot.user.clientAckMs?.p99).toBe(50)
    expect(snapshot.user.clientBookMs).toBeNull()
    expect(snapshot.agent.serverAcceptMs?.avgMs).toBe(12)
    expect(snapshot.agent.serverBookMs?.count).toBe(1)
    expect(snapshot.agent.rejected).toBe(1)
    expect(snapshot.user.missingBook).toBe(1)
  })

  test("expires old buckets and ignores invalid samples", () => {
    const metrics = new OrderLatency()
    metrics.note("user", "clientBookMs", 20, NOW - ORDER_LATENCY_WINDOW_MS - 10_000)
    metrics.note("user", "clientBookMs", Number.NaN, NOW)
    metrics.note("user", "clientBookMs", -1, NOW)
    metrics.note("user", "clientBookMs", 30, NOW)
    metrics.reject("user", NOW - ORDER_LATENCY_WINDOW_MS - 10_000)

    const snapshot = metrics.snapshot(NOW)
    expect(snapshot.user.clientBookMs?.count).toBe(1)
    expect(snapshot.user.clientBookMs?.avgMs).toBe(30)
    expect(snapshot.user.rejected).toBe(0)
  })

  test("returns explicit empty sources", () => {
    const snapshot = new OrderLatency().snapshot(NOW)
    expect(snapshot.at).toBe(NOW)
    expect(snapshot.windowMs).toBe(ORDER_LATENCY_WINDOW_MS)
    expect(snapshot.user).toEqual({ rejected: 0, missingBook: 0, serverAcceptMs: null, serverBookMs: null, clientAckMs: null, clientBookMs: null })
    expect(snapshot.agent.clientAckMs).toBeNull()
  })
})
