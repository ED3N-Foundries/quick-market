import type { Lang } from "../../shared/lang"
import { copy } from "./copy"

export const LAG_WINDOW_MS = 15_000
export const LAG_PROBE_MS = 2_000
export const LAG_STALE_MS = 5_000
export const LAG_SLOW_MS = 300
export const LAG_MISS_LIMIT = 2

export type LagSample = {
  at: number
  rawUp?: number
  rawDown?: number
  rtt?: number
}

export type LagState = {
  samples: LagSample[]
}

export type LagTone = "live" | "slow" | "down"

export type LinkStatus = {
  tone: LagTone
  label: "Live" | "Slow" | "Reconnecting"
  upMs: number | null
  downMs: number | null
  rttMs: number | null
}

export type Probe = {
  sentAt: number
  awaiting: boolean
  misses: number
  /** A probe armed because the page just woke. One miss replaces the socket. */
  wake: boolean
}

export const WAKE_CONNECT_MS = 5_000
export const WAKE_PROBE_MS = 1_000

export type SocketPhase = "absent" | "connecting" | "open" | "closing" | "closed"

export type WakeAction = "keep" | "probe" | "replace"

export type LagEcho = {
  t: number
  serverRecv: number
  serverNow: number
}

export function createLag(): LagState {
  return { samples: [] }
}

export function createProbe(): Probe {
  return { sentAt: 0, awaiting: false, misses: 0, wake: false }
}

export function socketPhase(readyState: number | null): SocketPhase {
  if (readyState == null) return "absent"
  if (readyState === 0) return "connecting"
  if (readyState === 1) return "open"
  if (readyState === 2) return "closing"
  return "closed"
}

/** What to do when the page becomes visible again, is restored, or the network returns. */
export function wakeAction(input: {
  phase: SocketPhase
  lastInboundAt: number | null
  openedAt: number | null
  now: number
  connectingSince: number | null
}): WakeAction {
  if (input.phase === "absent" || input.phase === "closed" || input.phase === "closing") return "replace"
  if (input.phase === "connecting") {
    const since = input.connectingSince
    if (since == null || input.now - since >= WAKE_CONNECT_MS) return "replace"
    return "keep"
  }
  const heard = input.lastInboundAt ?? input.openedAt
  if (heard != null && input.now - heard < LAG_STALE_MS) return "keep"
  return "probe"
}

/** How long since the last frame. Null until the page has opened a socket or heard from one. */
export function silenceMs(lastInboundAt: number | null, openedAt: number | null, now: number): number | null {
  const heard = lastInboundAt ?? openedAt
  if (heard == null) return null
  return now - heard
}

export function lagProbe(t: number): string {
  return JSON.stringify({ type: "lag", t })
}

function fresh(samples: LagSample[], now: number): LagSample[] {
  const kept: LagSample[] = []
  for (const sample of samples) {
    if (now - sample.at <= LAG_WINDOW_MS) kept.push(sample)
  }
  return kept
}

export function noteDown(state: LagState, serverNow: number, arrival: number): LagState {
  const rawDown = arrival - serverNow
  if (!Number.isFinite(rawDown)) return state
  const samples = fresh(state.samples, arrival)
  samples.push({ at: arrival, rawDown })
  return { samples }
}

export function noteEcho(state: LagState, echo: LagEcho, arrival: number): LagState {
  const rawUp = echo.serverRecv - echo.t
  const rawDown = arrival - echo.serverNow
  const rtt = arrival - echo.t - (echo.serverNow - echo.serverRecv)
  if (!Number.isFinite(rawUp) || !Number.isFinite(rawDown) || !Number.isFinite(rtt) || rtt < 0) return state
  const samples = fresh(state.samples, arrival)
  samples.push({ at: arrival, rawUp, rawDown, rtt })
  return { samples }
}

export type LagLegs = {
  up: number[]
  down: number[]
  rtt: number[]
}

/** θ estimates server clock minus client clock. A constant path stays shared. Extra delay stays on its own leg. */
export function lagLegs(state: LagState, now: number): LagLegs {
  const samples = fresh(state.samples, now)
  let minUp = Number.POSITIVE_INFINITY
  let minDown = Number.POSITIVE_INFINITY
  for (const sample of samples) {
    if (sample.rawUp != null && sample.rawUp < minUp) minUp = sample.rawUp
    if (sample.rawDown != null && sample.rawDown < minDown) minDown = sample.rawDown
  }
  const split = minUp !== Number.POSITIVE_INFINITY && minDown !== Number.POSITIVE_INFINITY
  const theta = split ? (minUp - minDown) / 2 : null
  const up: number[] = []
  const down: number[] = []
  const rtt: number[] = []
  for (const sample of samples) {
    if (sample.rtt != null) rtt.push(sample.rtt)
    if (theta == null) continue
    if (sample.rawUp != null) up.push(sample.rawUp - theta)
    if (sample.rawDown != null) down.push(sample.rawDown + theta)
  }
  return { up, down, rtt }
}

function median(values: number[]): number | null {
  const count = values.length
  if (count === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(count / 2)
  const upper = sorted[mid]
  if (upper == null) return null
  if (count % 2 === 1) return upper
  const lower = sorted[mid - 1]
  if (lower == null) return null
  return (lower + upper) / 2
}

export function lagView(state: LagState, now: number): Pick<LinkStatus, "upMs" | "downMs" | "rttMs"> {
  const legs = lagLegs(state, now)
  return { upMs: median(legs.up), downMs: median(legs.down), rttMs: median(legs.rtt) }
}

export function lagTone(input: {
  open: boolean
  lastInboundAt: number | null
  openedAt: number | null
  now: number
  rttMs: number | null
}): LagTone {
  if (!input.open) return "down"
  const since = input.lastInboundAt ?? input.openedAt
  if (since == null || input.now - since >= LAG_STALE_MS) return "down"
  if (input.rttMs != null && input.rttMs >= LAG_SLOW_MS) return "slow"
  return "live"
}

export function lagLabel(tone: LagTone): LinkStatus["label"] {
  if (tone === "live") return "Live"
  if (tone === "slow") return "Slow"
  return "Reconnecting"
}

export function linkStatus(
  state: LagState,
  now: number,
  open: boolean,
  lastInboundAt: number | null,
  openedAt: number | null,
): LinkStatus {
  const view = lagView(state, now)
  const tone = lagTone({ open, lastInboundAt, openedAt, now, rttMs: view.rttMs })
  return { tone, label: lagLabel(tone), ...view }
}

export function formatLag(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  return `${Math.max(0, Math.round(ms))} ms`
}

export function lagButtonName(label: string, rttMs: number | null, lang: Lang = "en"): string {
  const ms = rttMs == null || !Number.isFinite(rttMs) ? null : Math.max(0, Math.round(rttMs))
  if (lang === "zh-TW") {
    const word = label === "Live" ? "正常" : label === "Slow" ? "偏慢" : "重新連線"
    return copy(lang).connectionName(word, ms)
  }
  const state = label.toLowerCase()
  if (ms == null) return `Connection, ${state}`
  return `Connection, ${state}, ${ms} milliseconds`
}

export function readEcho(message: unknown): LagEcho | null {
  if (!message || typeof message !== "object") return null
  const record = message as Record<string, unknown>
  if (record.type !== "lag") return null
  const { t, serverRecv, serverNow } = record
  if (typeof t !== "number" || typeof serverRecv !== "number" || typeof serverNow !== "number") return null
  if (!Number.isFinite(t) || !Number.isFinite(serverRecv) || !Number.isFinite(serverNow)) return null
  return { t, serverRecv, serverNow }
}

export function noteProbeSent(probe: Probe, at: number): Probe {
  return { sentAt: at, awaiting: true, misses: probe.misses, wake: false }
}

export function noteWakeProbe(probe: Probe, at: number): Probe {
  return { sentAt: at, awaiting: true, misses: 0, wake: true }
}

export function noteProbeInbound(probe: Probe): Probe {
  return { sentAt: probe.sentAt, awaiting: false, misses: 0, wake: false }
}

/** A hidden or frozen page does not answer on time. That gap is not a miss. */
export function noteHidden(probe: Probe): Probe {
  return createProbe()
}

/** A probe that outlives its interval with no later inbound frame is a miss. Two misses close the socket. */
export function ageProbe(probe: Probe, now: number, lastInboundAt: number): { probe: Probe; close: boolean } {
  if (!probe.awaiting || now - probe.sentAt < LAG_PROBE_MS) return { probe, close: false }
  const misses = lastInboundAt < probe.sentAt ? probe.misses + 1 : 0
  return {
    probe: { sentAt: probe.sentAt, awaiting: false, misses, wake: false },
    close: misses >= LAG_MISS_LIMIT,
  }
}

/** A wake probe that gets no frame within a second means the open socket is dead. */
export function wakeDeadline(probe: Probe, now: number, lastInboundAt: number): { probe: Probe; replace: boolean } {
  if (!probe.wake || !probe.awaiting) return { probe, replace: false }
  if (lastInboundAt >= probe.sentAt) return { probe: noteProbeInbound(probe), replace: false }
  if (now - probe.sentAt < WAKE_PROBE_MS) return { probe, replace: false }
  return { probe: { sentAt: probe.sentAt, awaiting: false, misses: probe.misses, wake: false }, replace: true }
}

/** Foreground watchdog. Hidden time is cleared by noteHidden before this runs. */
export function supervise(input: {
  phase: SocketPhase
  now: number
  lastInboundAt: number | null
  openedAt: number | null
  connectingSince: number | null
  retryPending: boolean
  probe: Probe
}): { probe: Probe; action: WakeAction } {
  const due = wakeDeadline(input.probe, input.now, input.lastInboundAt ?? 0)
  if (due.replace) return { probe: due.probe, action: "replace" }
  const aged = ageProbe(due.probe, input.now, input.lastInboundAt ?? 0)
  if (aged.close) return { probe: aged.probe, action: "replace" }
  const probe = aged.probe
  if (input.phase === "open") {
    if (probeDue(probe, input.now)) return { probe, action: "probe" }
    return { probe, action: "keep" }
  }
  if (input.phase === "connecting") {
    const since = input.connectingSince
    if (since == null || input.now - since >= WAKE_CONNECT_MS) return { probe, action: "replace" }
    return { probe, action: "keep" }
  }
  if (input.phase === "absent" && input.retryPending) return { probe, action: "keep" }
  return { probe, action: "replace" }
}

export function probeDue(probe: Probe, now: number): boolean {
  if (probe.awaiting) return false
  if (probe.sentAt === 0) return true
  return now - probe.sentAt >= LAG_PROBE_MS
}
