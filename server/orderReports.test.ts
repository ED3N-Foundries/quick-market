import { describe, expect, test } from "bun:test"
import { OrderLatency } from "./orderLatency"
import { noteClientOrderReport, rememberOrderReport, type OrderReportMap } from "./orderReports"

const NOW = 1_800_000_000_000

describe("order reports", () => {
  test("accepts one ack and one book for a remembered request", () => {
    const reports: OrderReportMap = new Map()
    const metrics = new OrderLatency()
    rememberOrderReport(reports, "request-1", NOW)
    noteClientOrderReport(reports, { requestId: "request-1", kind: "book", ms: 20 }, NOW, metrics)
    noteClientOrderReport(reports, { requestId: "request-1", kind: "ack", ms: 35 }, NOW, metrics)
    noteClientOrderReport(reports, { requestId: "request-1", kind: "ack", ms: 90 }, NOW, metrics)
    noteClientOrderReport(reports, { requestId: "request-1", kind: "book", ms: 20 }, NOW, metrics)
    noteClientOrderReport(reports, { requestId: "request-1", kind: "book", ms: 20 }, NOW, metrics)

    const snapshot = metrics.snapshot(NOW)
    expect(snapshot.user.clientAckMs?.count).toBe(1)
    expect(snapshot.user.clientAckMs?.avgMs).toBe(35)
    expect(snapshot.user.clientBookMs?.count).toBe(1)
    expect(snapshot.user.clientBookMs?.avgMs).toBe(20)
    expect(reports.size).toBe(0)
  })

  test("ignores unknown, malformed, and expired reports", () => {
    const reports: OrderReportMap = new Map()
    const metrics = new OrderLatency()
    rememberOrderReport(reports, "request-1", NOW - 120_001)
    noteClientOrderReport(reports, { requestId: "request-1", kind: "ack", ms: 35 }, NOW, metrics)
    noteClientOrderReport(reports, { requestId: "unknown", kind: "ack", ms: 35 }, NOW, metrics)
    noteClientOrderReport(undefined, { requestId: "request-1", kind: "ack", ms: 35 }, NOW, metrics)
    expect(metrics.snapshot(NOW).user.clientAckMs).toBeNull()
  })

  test("records a missing book once", () => {
    const reports: OrderReportMap = new Map()
    const metrics = new OrderLatency()
    rememberOrderReport(reports, "request-1", NOW)
    noteClientOrderReport(reports, { requestId: "request-1", kind: "ack", ms: 10 }, NOW, metrics)
    noteClientOrderReport(reports, { requestId: "request-1", kind: "missing" }, NOW + 5_000, metrics)
    noteClientOrderReport(reports, { requestId: "request-1", kind: "missing" }, NOW + 5_000, metrics)
    expect(metrics.snapshot(NOW + 5_000).user.missingBook).toBe(1)
  })
})
