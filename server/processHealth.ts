import { dirname, join } from "node:path"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"

export type ProcessStatus = "ok" | "degraded" | "down"

export type ProcessLastError = {
  message: string
  stack: string | null
  at: number
  kind: string
}

export type PreviousRun = {
  bootId: string | null
  bootAt: number | null
  endedAt: number | null
  bootCount: number | null
  clean: boolean
  reason: string | null
  signal: string | null
}

export type ProcessSnapshot = {
  bootId: string
  bootAt: number
  bootCount: number
  now: number
  uptimeMs: number
  pid: number
  runtime: string
  status: ProcessStatus
  reason: string | null
  lastError: ProcessLastError | null
  lastSignal: string | null
  previous: PreviousRun | null
  memory: { rss: number; heapTotal: number; heapUsed: number; external: number }
  eventLoopLagMs: number | null
  counters: { uncaught: number; unhandled: number; requestErrors: number; tickErrors: number }
}

type Persisted = {
  bootId: string
  bootAt: number
  bootCount: number
  pid: number
  status: ProcessStatus
  reason: string | null
  lastError: ProcessLastError | null
  lastSignal: string | null
  cleanShutdown: boolean
  updatedAt: number
  previous: PreviousRun | null
}

type InitOptions = {
  dbPath?: string
  filePath?: string
  now?: () => number
  installHandlers?: boolean
  startLagSampler?: boolean
}

const REASON_MAX = 300
const STACK_MAX = 2000
const HEARTBEAT_MS = 30_000

let booted = false
let bootId = ""
let bootAt = 0
let bootCount = 1
let status: ProcessStatus = "ok"
let reason: string | null = null
let lastError: ProcessLastError | null = null
let lastSignal: string | null = null
let previous: PreviousRun | null = null
let filePath: string | null = null
let counters = { uncaught: 0, unhandled: 0, requestErrors: 0, tickErrors: 0 }
let lagMs: number | null = null
let lagTimer: ReturnType<typeof setInterval> | null = null
let lastHeartbeat = 0
let nowFn: () => number = Date.now

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max)
}

function shortMessage(error: unknown): string {
  if (error instanceof Error) return truncate(error.message || error.name, REASON_MAX)
  return truncate(String(error), REASON_MAX)
}

function stackOf(error: unknown): string | null {
  if (error instanceof Error && typeof error.stack === "string") return truncate(error.stack, STACK_MAX)
  return null
}

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
  }
}

export function processHealthFileForDb(dbPath: string): string {
  if (!dbPath || dbPath === ":memory:") return join(process.cwd(), "data", "process-health.json")
  return join(dirname(dbPath), "process-health.json")
}

function readPersisted(path: string): Persisted | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf8")
    const body = JSON.parse(raw) as Partial<Persisted>
    if (!body || typeof body !== "object") return null
    return {
      bootId: typeof body.bootId === "string" ? body.bootId : "",
      bootAt: typeof body.bootAt === "number" ? body.bootAt : 0,
      bootCount: typeof body.bootCount === "number" ? body.bootCount : 0,
      pid: typeof body.pid === "number" ? body.pid : 0,
      status: body.status === "down" || body.status === "degraded" ? body.status : "ok",
      reason: typeof body.reason === "string" ? body.reason : null,
      lastError: body.lastError && typeof body.lastError === "object" ? (body.lastError as Persisted["lastError"]) : null,
      lastSignal: typeof body.lastSignal === "string" ? body.lastSignal : null,
      cleanShutdown: body.cleanShutdown === true,
      updatedAt: typeof body.updatedAt === "number" ? body.updatedAt : 0,
      previous: body.previous && typeof body.previous === "object" ? (body.previous as PreviousRun) : null,
    }
  } catch {
    return null
  }
}

function toPrevious(prior: Persisted): PreviousRun {
  const clean = prior.cleanShutdown === true
  let crashReason: string | null = null
  if (clean) {
    crashReason = prior.reason ?? prior.lastSignal ?? "clean shutdown"
  } else if (prior.lastError?.message) {
    crashReason = `unclean shutdown after ${prior.lastError.kind}: ${prior.lastError.message}`
  } else if (prior.lastSignal) {
    crashReason = `unclean shutdown on ${prior.lastSignal}`
  } else if (prior.status === "down" && prior.reason) {
    crashReason = `unclean shutdown while down: ${prior.reason}`
  } else {
    crashReason = "unclean shutdown (no clean exit marker — likely SIGKILL, OOM, or container restart)"
  }
  return {
    bootId: prior.bootId || null,
    bootAt: prior.bootAt || null,
    endedAt: prior.updatedAt || null,
    bootCount: prior.bootCount || null,
    clean,
    reason: truncate(crashReason, REASON_MAX),
    signal: prior.lastSignal ?? null,
  }
}

function writePersisted(cleanShutdown: boolean): void {
  if (!filePath) return
  const now = nowFn()
  const body: Persisted = {
    bootId,
    bootAt,
    bootCount,
    pid: process.pid,
    status,
    reason,
    lastError,
    lastSignal,
    cleanShutdown,
    updatedAt: now,
    previous,
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(body), "utf8")
    renameSync(tmp, filePath)
  } catch {
    // Best effort: health tracking must never crash the market.
  }
}

function persistThrottled(force = false): void {
  const now = nowFn()
  if (!force && now - lastHeartbeat < HEARTBEAT_MS) return
  lastHeartbeat = now
  writePersisted(false)
}

/** Test hook: reset module state so unit tests can re-init. */
export function __resetProcessHealthForTest(): void {
  if (lagTimer) clearInterval(lagTimer)
  lagTimer = null
  booted = false
  bootId = ""
  bootAt = 0
  bootCount = 1
  status = "ok"
  reason = null
  lastError = null
  lastSignal = null
  previous = null
  filePath = null
  counters = { uncaught: 0, unhandled: 0, requestErrors: 0, tickErrors: 0 }
  lagMs = null
  lastHeartbeat = 0
  nowFn = Date.now
}

export function initProcessHealth(options: InitOptions = {}): ProcessSnapshot {
  nowFn = options.now ?? Date.now
  if (booted) return snapshotProcessHealth()
  booted = true
  const now = nowFn()
  bootId = randomId()
  bootAt = now
  lastHeartbeat = now
  const resolved = options.filePath ?? (options.dbPath ? processHealthFileForDb(options.dbPath) : null)
  filePath = resolved
  if (filePath) {
    const prior = readPersisted(filePath)
    if (prior && prior.bootId && prior.bootId !== bootId) {
      previous = toPrevious(prior)
      bootCount = (prior.bootCount || 0) + 1
      if (!prior.cleanShutdown) {
        status = "degraded"
        reason = truncate(`previous run ended uncleanly: ${previous.reason ?? "unknown"}`, REASON_MAX)
      }
    } else if (prior && typeof prior.bootCount === "number" && prior.bootCount > 0) {
      bootCount = prior.bootCount + 1
    }
    writePersisted(false)
  }
  if (options.installHandlers !== false) installCrashHandlers()
  if (options.startLagSampler !== false) startLagSampler()
  return snapshotProcessHealth()
}

function startLagSampler(): void {
  if (lagTimer) return
  try {
    lagTimer = setInterval(() => {
      const start = performance.now()
      setImmediate(() => {
        lagMs = performance.now() - start
      })
    }, 1000)
    ;(lagTimer as unknown as { unref?: () => void }).unref?.()
  } catch {
    lagTimer = null
  }
}

function installCrashHandlers(): void {
  const proc = process as unknown as {
    __qmHealthHandlers?: boolean
    on?: (event: string, handler: (...args: unknown[]) => void) => void
  }
  if (proc.__qmHealthHandlers) return
  proc.__qmHealthHandlers = true
  try {
    process.on("uncaughtException", (error) => {
      counters.uncaught += 1
      lastError = { message: shortMessage(error), stack: stackOf(error), at: nowFn(), kind: "uncaughtException" }
      status = "down"
      reason = truncate(`uncaughtException: ${lastError.message}`, REASON_MAX)
      writePersisted(false)
      console.error(reason)
      if (lastError.stack) console.error(lastError.stack)
      process.exit(1)
    })
    process.on("unhandledRejection", (thrown) => {
      counters.unhandled += 1
      lastError = {
        message: shortMessage(thrown),
        stack: stackOf(thrown),
        at: nowFn(),
        kind: "unhandledRejection",
      }
      status = "down"
      reason = truncate(`unhandledRejection: ${lastError.message}`, REASON_MAX)
      writePersisted(false)
      console.error(reason)
      if (lastError.stack) console.error(lastError.stack)
      process.exit(1)
    })
    const shutdown = (signal: string) => {
      lastSignal = signal
      if (status === "ok") {
        status = "degraded"
        reason = `shutting down on ${signal}`
      }
      writePersisted(true)
      process.exit(0)
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"))
    process.on("SIGINT", () => shutdown("SIGINT"))
  } catch {
    // Handlers are best effort.
  }
}

export function setProcessStatus(next: ProcessStatus, nextReason: string | null): void {
  status = next
  reason = nextReason ? truncate(nextReason, REASON_MAX) : null
  persistThrottled(next !== "ok")
}

export function noteBootFailure(error: unknown): void {
  lastError = { message: shortMessage(error), stack: stackOf(error), at: nowFn(), kind: "boot" }
  status = "down"
  reason = truncate(`boot failed: ${lastError.message}`, REASON_MAX)
  writePersisted(false)
}

export function noteRequestError(error: unknown, route = ""): void {
  counters.requestErrors += 1
  const message = shortMessage(error)
  lastError = { message, stack: stackOf(error), at: nowFn(), kind: `request:${route || "/"}` }
  if (status === "ok") {
    status = "degraded"
    reason = truncate(`request error${route ? ` on ${route}` : ""}: ${message}`, REASON_MAX)
  }
  persistThrottled()
}

export function noteTickError(error: unknown): void {
  counters.tickErrors += 1
  const message = shortMessage(error)
  lastError = { message, stack: stackOf(error), at: nowFn(), kind: "tick" }
  status = "down"
  reason = truncate(`tick failed: ${message}`, REASON_MAX)
  writePersisted(false)
}

export function noteFeedBreak(from: string, to: string | null, detail: string): void {
  if (to == null) {
    status = "down"
    reason = truncate(`feed ${from} dropped, waiting (${detail})`, REASON_MAX)
  } else if (status !== "down") {
    status = "degraded"
    reason = truncate(`feed ${from} dropped → ${to} (${detail})`, REASON_MAX)
  }
  persistThrottled(true)
}

export function noteFeedAdopt(to: string): void {
  if (status !== "ok" || reason?.includes("previous run ended uncleanly")) {
    // Keep a prior down/degraded crash marker until the feed is verifiably live;
    // noteFeedLive() clears it. An adopt alone is not proof of recovery.
    if (status === "down") return
  }
  status = "ok"
  reason = truncate(`feed adopted ${to}`, REASON_MAX)
  persistThrottled(true)
}

export function noteFeedLive(): void {
  // A live feed clears feed-related and previous-run degradation, and stale
  // request-error markers. It never clears a crash marker (tick, boot,
  // uncaught) blindly — those clear via noteTickOk() after real recovery.
  if (status === "down" && !reason?.startsWith("feed ")) return
  if (reason == null || /^(feed |previous run ended uncleanly|request error|feed adopted|feed live|tick recovered)/.test(reason)) {
    if (status !== "ok" || reason !== "feed live") {
      status = "ok"
      reason = "feed live"
      persistThrottled(true)
    }
  }
}

/** A successful loop iteration after a tick failure proves recovery. */
export function noteTickOk(feed: "live" | "stale"): void {
  if (reason && reason.startsWith("tick failed")) {
    if (feed === "live") {
      status = "ok"
      reason = "tick recovered, feed live"
    } else {
      status = "degraded"
      reason = "tick recovered, feed stale"
    }
    persistThrottled(true)
  }
}

export function heartbeatProcessHealth(): void {
  persistThrottled()
}

export function snapshotProcessHealth(): ProcessSnapshot {
  const now = nowFn()
  let memory = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }
  try {
    const mem = process.memoryUsage()
    memory = { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external }
  } catch {
    // ignore
  }
  let runtime = "unknown"
  try {
    runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`
  } catch {
    // ignore
  }
  return {
    bootId,
    bootAt,
    bootCount,
    now,
    uptimeMs: bootAt ? Math.max(0, now - bootAt) : 0,
    pid: process.pid,
    runtime,
    status,
    reason,
    lastError,
    lastSignal,
    previous,
    memory,
    eventLoopLagMs: lagMs,
    counters: { ...counters },
  }
}
