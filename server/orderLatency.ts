import { HIST_BOUNDS, HIST_LEN, percentileOfHist } from "./selfHealth"

export const ORDER_LATENCY_WINDOW_MS = 5 * 60 * 1000
const BUCKET_MS = 10_000

export type OrderSource = "user" | "agent"
export type OrderStage = "serverAcceptMs" | "serverBookMs" | "clientAckMs" | "clientBookMs"

export type OrderTail = {
  count: number
  avgMs: number
  maxMs: number
  p50: number
  p90: number
  p95: number
  p99: number
}

export type OrderSourceSnapshot = {
  rejected: number
  missingBook: number
  serverAcceptMs: OrderTail | null
  serverBookMs: OrderTail | null
  clientAckMs: OrderTail | null
  clientBookMs: OrderTail | null
}

export type OrderLatencySnapshot = {
  at: number
  windowMs: number
  user: OrderSourceSnapshot
  agent: OrderSourceSnapshot
}

type Agg = { count: number; totalMs: number; maxMs: number; hist: number[] }
type Bucket = {
  at: number
  metrics: Map<string, Agg>
  rejected: Record<OrderSource, number>
  missingBook: number
}

function newAgg(): Agg {
  return { count: 0, totalMs: 0, maxMs: 0, hist: new Array<number>(HIST_LEN).fill(0) }
}

function add(agg: Agg, ms: number): void {
  let index = 0
  while (index < HIST_BOUNDS.length && ms > HIST_BOUNDS[index]!) index += 1
  agg.count += 1
  agg.totalMs += ms
  agg.maxMs = Math.max(agg.maxMs, ms)
  agg.hist[index]! += 1
}

function emptySource(): OrderSourceSnapshot {
  return { rejected: 0, missingBook: 0, serverAcceptMs: null, serverBookMs: null, clientAckMs: null, clientBookMs: null }
}

export class OrderLatency {
  private buckets = new Map<number, Bucket>()

  note(source: OrderSource, stage: OrderStage, ms: number, now = Date.now()): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const bucket = this.bucket(now)
    const key = `${source}:${stage}`
    const agg = bucket.metrics.get(key) ?? newAgg()
    add(agg, ms)
    bucket.metrics.set(key, agg)
  }

  reject(source: OrderSource, now = Date.now()): void {
    this.bucket(now).rejected[source] += 1
  }

  missBook(now = Date.now()): void {
    this.bucket(now).missingBook += 1
  }

  snapshot(now = Date.now()): OrderLatencySnapshot {
    this.prune(now)
    const sources: Record<OrderSource, OrderSourceSnapshot> = { user: emptySource(), agent: emptySource() }
    const aggs = new Map<string, Agg>()
    for (const bucket of this.buckets.values()) {
      if (bucket.at > now || bucket.at + BUCKET_MS <= now - ORDER_LATENCY_WINDOW_MS) continue
      for (const source of ["user", "agent"] as const) sources[source].rejected += bucket.rejected[source]
      sources.user.missingBook += bucket.missingBook
      for (const [key, value] of bucket.metrics) {
        const agg = aggs.get(key) ?? newAgg()
        agg.count += value.count
        agg.totalMs += value.totalMs
        agg.maxMs = Math.max(agg.maxMs, value.maxMs)
        for (let index = 0; index < HIST_LEN; index += 1) agg.hist[index]! += value.hist[index]!
        aggs.set(key, agg)
      }
    }
    for (const [key, agg] of aggs) {
      const split = key.indexOf(":")
      const source = key.slice(0, split) as OrderSource
      const stage = key.slice(split + 1) as OrderStage
      sources[source][stage] = {
        count: agg.count,
        avgMs: agg.totalMs / agg.count,
        maxMs: agg.maxMs,
        p50: percentileOfHist(agg.hist, 50),
        p90: percentileOfHist(agg.hist, 90),
        p95: percentileOfHist(agg.hist, 95),
        p99: percentileOfHist(agg.hist, 99),
      }
    }
    return { at: now, windowMs: ORDER_LATENCY_WINDOW_MS, ...sources }
  }

  private bucket(now: number): Bucket {
    this.prune(now)
    const at = Math.floor(now / BUCKET_MS) * BUCKET_MS
    let bucket = this.buckets.get(at)
    if (!bucket) {
      bucket = { at, metrics: new Map(), rejected: { user: 0, agent: 0 }, missingBook: 0 }
      this.buckets.set(at, bucket)
    }
    return bucket
  }

  private prune(now: number): void {
    const oldest = Math.floor((now - ORDER_LATENCY_WINDOW_MS) / BUCKET_MS) * BUCKET_MS
    for (const at of this.buckets.keys()) if (at < oldest) this.buckets.delete(at)
  }
}

export const orderLatency = new OrderLatency()
