import { expect, test } from "bun:test"
import {
  ageProbe,
  chartCovered,
  connectionState,
  createLag,
  createProbe,
  formatLag,
  lagButtonName,
  lagLegs,
  lagTone,
  lagView,
  noteDown,
  noteEcho,
  noteHidden,
  noteProbeInbound,
  noteProbeSent,
  noteWakeProbe,
  probeDue,
  readEcho,
  reconnectDelay,
  silenceMs,
  supervise,
  wakeAction,
} from "./lag"

function echo(
  state: ReturnType<typeof createLag>,
  t: number,
  up: number,
  down: number,
  skew = 0,
  dwell = 0,
) {
  const serverRecv = t + up + skew
  const serverNow = serverRecv + dwell
  const arrival = t + up + down + dwell
  return noteEcho(state, { t, serverRecv, serverNow }, arrival)
}

test("a symmetric path splits in half, and server dwell is not part of the round trip", () => {
  const state = noteEcho(createLag(), { t: 1_000, serverRecv: 1_040, serverNow: 1_055 }, 1_095)
  const view = lagView(state, 1_095)
  expect(view.rttMs).toBe(80)
  expect(view.upMs).toBe(40)
  expect(view.downMs).toBe(40)
})

test("clock skew cancels out of both legs", () => {
  const state = echo(createLag(), 1_000, 40, 40, 1_000)
  const view = lagView(state, 1_080)
  expect(view.upMs).toBe(40)
  expect(view.downMs).toBe(40)
  expect(view.rttMs).toBe(80)
})

test("extra uplink delay lands on up", () => {
  let state = echo(createLag(), 1_000, 40, 40)
  state = echo(state, 2_000, 140, 40)
  const legs = lagLegs(state, 2_180)
  expect(legs.up).toEqual([40, 140])
  expect(legs.down).toEqual([40, 40])
})

test("extra downlink delay lands on down", () => {
  let state = echo(createLag(), 1_000, 40, 40)
  state = echo(state, 2_000, 40, 140)
  const legs = lagLegs(state, 2_180)
  expect(legs.up).toEqual([40, 40])
  expect(legs.down).toEqual([40, 140])
})

test("ticks already on the wire join the downlink once a probe exists", () => {
  let state = noteDown(createLag(), 1_000, 1_040)
  expect(lagView(state, 1_040).downMs).toBeNull()
  state = echo(state, 1_100, 40, 40)
  expect(lagLegs(state, 1_180).down).toEqual([40, 40])
  expect(lagLegs(state, 1_180).up).toEqual([40])
})

test("one slow round trip does not move the median", () => {
  let state = createLag()
  for (let i = 0; i < 5; i += 1) state = echo(state, i * 1_000, 20, 20)
  state = echo(state, 5_000, 400, 400)
  const view = lagView(state, 5_800)
  expect(view.rttMs).toBe(40)
  expect(view.upMs).toBe(20)
  expect(view.downMs).toBe(20)
})

test("samples older than the window drop out", () => {
  let state = echo(createLag(), 0, 20, 20)
  state = echo(state, 1_000, 50, 30)
  expect(lagView(state, 1_080).rttMs).toBe(60)
  expect(lagView(state, 16_000).rttMs).toBe(80)
})

test("a negative round trip is ignored", () => {
  const state = noteEcho(createLag(), { t: 2_000, serverRecv: 2_010, serverNow: 2_010 }, 1_000)
  expect(lagView(state, 1_000).rttMs).toBeNull()
})

test("the dot stays live until the round trip is known, then marks a slow path", () => {
  expect(lagTone({ open: false, lastInboundAt: 100, openedAt: 0, now: 200, rttMs: 10 })).toBe("down")
  expect(lagTone({ open: true, lastInboundAt: null, openedAt: 1_000, now: 1_100, rttMs: null })).toBe("live")
  expect(lagTone({ open: true, lastInboundAt: null, openedAt: null, now: 1_000, rttMs: null })).toBe("down")
  expect(lagTone({ open: true, lastInboundAt: 1_000, openedAt: 0, now: 6_000, rttMs: 20 })).toBe("down")
  expect(lagTone({ open: true, lastInboundAt: 1_000, openedAt: 0, now: 1_500, rttMs: 299 })).toBe("live")
  expect(lagTone({ open: true, lastInboundAt: 1_000, openedAt: 0, now: 1_500, rttMs: 300 })).toBe("slow")
})

test("two missed probes close, and a frame in between clears the streak", () => {
  let aged = ageProbe(noteProbeSent(createProbe(), 1_000), 3_000, 0)
  expect(aged.close).toBe(false)
  expect(aged.probe.misses).toBe(1)
  aged = ageProbe(noteProbeSent(aged.probe, 3_000), 5_000, 0)
  expect(aged.close).toBe(true)

  aged = ageProbe(noteProbeSent(createProbe(), 1_000), 3_000, 1_500)
  expect(aged.close).toBe(false)
  expect(aged.probe.misses).toBe(0)

  const cleared = noteProbeInbound(noteProbeSent(createProbe(), 1_000))
  expect(cleared.misses).toBe(0)
  expect(cleared.awaiting).toBe(false)
})

test("a probe is due when none is in flight", () => {
  expect(probeDue(createProbe(), 5_000)).toBe(true)
  const sent = noteProbeSent(createProbe(), 1_000)
  expect(probeDue(sent, 3_000)).toBe(false)
  expect(probeDue(ageProbe(sent, 3_000, 1_200).probe, 3_000)).toBe(true)
})

test("an echo reads the three timestamps", () => {
  expect(readEcho({ type: "lag", t: 5, serverRecv: 6, serverNow: 7 })).toEqual({
    t: 5,
    serverRecv: 6,
    serverNow: 7,
  })
  expect(readEcho({ type: "tick", serverNow: 1 })).toBeNull()
  expect(readEcho({ type: "lag", t: "5" })).toBeNull()
})

test("waking replaces a socket that is not open and probes one that went quiet", () => {
  const fresh = { lastInboundAt: 9_000, openedAt: 0, now: 10_000, connectingSince: 9_000 }
  expect(wakeAction({ ...fresh, phase: "absent" })).toBe("replace")
  expect(wakeAction({ ...fresh, phase: "closing" })).toBe("replace")
  expect(wakeAction({ ...fresh, phase: "closed" })).toBe("replace")
  expect(wakeAction({ ...fresh, phase: "connecting", connectingSince: null })).toBe("replace")
  expect(wakeAction({ ...fresh, phase: "connecting" })).toBe("keep")
  expect(wakeAction({ ...fresh, phase: "connecting", now: 15_000 })).toBe("replace")
  expect(wakeAction({ ...fresh, phase: "open" })).toBe("keep")
  expect(wakeAction({ ...fresh, phase: "open", lastInboundAt: 1_000, openedAt: 0, now: 8_000 })).toBe("probe")
  expect(wakeAction({ phase: "open", lastInboundAt: null, openedAt: 9_500, now: 10_000, connectingSince: null })).toBe("keep")
  expect(wakeAction({ phase: "open", lastInboundAt: null, openedAt: null, now: 10_000, connectingSince: null })).toBe("probe")
})

test("time hidden does not count as a missed probe", () => {
  const hidden = noteHidden(noteProbeSent(createProbe(), 1_000))
  expect(hidden).toEqual({ sentAt: 0, awaiting: false, misses: 0, wake: false })
  expect(ageProbe(hidden, 30_000, 0).close).toBe(false)
  expect(silenceMs(null, null, 5_000)).toBeNull()
  expect(silenceMs(1_000, 4_000, 5_000)).toBe(4_000)
})

test("a wake probe replaces a silent socket, and a frame cancels it", () => {
  const probe = noteWakeProbe(createProbe(), 1_000)
  const base = {
    phase: "open" as const,
    openedAt: 0,
    connectingSince: null,
    retryPending: false,
    probe,
  }
  expect(supervise({ ...base, now: 1_500, lastInboundAt: 0 }).action).toBe("keep")
  expect(supervise({ ...base, now: 2_000, lastInboundAt: 0 }).action).toBe("replace")
  const heard = supervise({ ...base, now: 2_000, lastInboundAt: 1_200 })
  expect(heard.action).toBe("keep")
  expect(heard.probe.awaiting).toBe(false)
  expect(heard.probe.misses).toBe(0)
})

test("two missed probes replace the socket, and a scheduled retry is left to fire", () => {
  let probe = noteProbeSent(createProbe(), 1_000)
  const step = supervise({
    phase: "open",
    now: 3_000,
    lastInboundAt: 0,
    openedAt: 0,
    connectingSince: null,
    retryPending: false,
    probe,
  })
  expect(step.action).toBe("probe")
  probe = noteProbeSent(step.probe, 3_000)
  const missed = supervise({
    phase: "open",
    now: 5_000,
    lastInboundAt: 0,
    openedAt: 0,
    connectingSince: null,
    retryPending: false,
    probe,
  })
  expect(missed.action).toBe("replace")

  const parked = {
    phase: "absent" as const,
    now: 1_000,
    lastInboundAt: null,
    openedAt: null,
    connectingSince: null,
    retryPending: true,
    probe: createProbe(),
  }
  expect(supervise(parked).action).toBe("keep")
  expect(supervise({ ...parked, phase: "closing", retryPending: false }).action).toBe("replace")
})

test("the button names the state and the round trip", () => {
  expect(formatLag(null)).toBe("—")
  expect(formatLag(80.4)).toBe("80 ms")
  expect(formatLag(-3)).toBe("0 ms")
  expect(lagButtonName("Live", 80.4)).toBe("Connection, live, 80 milliseconds")
  expect(lagButtonName("Reconnecting", null)).toBe("Connection, reconnecting")
})

test("reconnect backs off with jitter and a ten-second ceiling", () => {
  expect(reconnectDelay(0, 0)).toBe(0)
  expect(reconnectDelay(0, 0.999)).toBe(249)
  expect(reconnectDelay(3, 1)).toBe(2_000)
  expect(reconnectDelay(20, 1)).toBe(10_000)
})

test("connectionState blocks on down link or stale feed, warns on slow", () => {
  expect(connectionState({ tone: "down" }, "live")).toEqual({ blocked: true, slow: false, reason: "reconnecting" })
  expect(connectionState({ tone: "live" }, "stale")).toEqual({ blocked: true, slow: false, reason: "delayed" })
  expect(connectionState({ tone: "down" }, "stale")).toEqual({ blocked: true, slow: false, reason: "reconnecting" })
  expect(connectionState({ tone: "slow" }, "live")).toEqual({ blocked: false, slow: true, reason: null })
  expect(connectionState({ tone: "slow" }, "stale").blocked).toBe(true)
  expect(connectionState({ tone: "live" }, "live")).toEqual({ blocked: false, slow: false, reason: null })
})

test("the chart shimmer waits for a price, then stays off", () => {
  expect(chartCovered({ hasPrice: false, handoff: false, blocked: true })).toBe(true)
  expect(chartCovered({ hasPrice: false, handoff: true, blocked: false })).toBe(true)
  expect(chartCovered({ hasPrice: false, handoff: false, blocked: false })).toBe(false)
  expect(chartCovered({ hasPrice: true, handoff: true, blocked: true })).toBe(false)
  expect(chartCovered({ hasPrice: true, handoff: false, blocked: true })).toBe(false)
})
