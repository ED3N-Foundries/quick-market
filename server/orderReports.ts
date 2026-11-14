import { orderLatency, type OrderLatency } from "./orderLatency"

export const ORDER_REPORT_TTL_MS = 120_000
const ORDER_REPORT_CAP = 64

export type OrderReportMap = Map<string, { at: number; ack: boolean }>

export function rememberOrderReport(reports: OrderReportMap, requestId: string, now: number): void {
  if (!requestId) return
  for (const [id, report] of reports) if (now - report.at > ORDER_REPORT_TTL_MS) reports.delete(id)
  while (reports.size >= ORDER_REPORT_CAP) reports.delete(reports.keys().next().value!)
  reports.set(requestId, { at: now, ack: false })
}

export function noteClientOrderReport(
  reports: OrderReportMap | undefined,
  body: Record<string, unknown>,
  now: number,
  metrics: OrderLatency = orderLatency,
): void {
  const requestId = typeof body.requestId === "string" ? body.requestId : ""
  const kind = body.kind
  const ms = body.ms
  const report = reports?.get(requestId)
  if (!reports || !report || now - report.at > ORDER_REPORT_TTL_MS) return
  if (kind === "ack") {
    if (report.ack || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > ORDER_REPORT_TTL_MS) return
    report.ack = true
    metrics.note("user", "clientAckMs", ms, now)
    return
  }
  if (!report.ack || (kind !== "book" && kind !== "missing")) return
  if (kind === "book") {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > ORDER_REPORT_TTL_MS) return
    metrics.note("user", "clientBookMs", ms, now)
  } else {
    metrics.missBook(now)
  }
  reports.delete(requestId)
}
