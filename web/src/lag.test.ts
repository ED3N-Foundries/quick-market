import { expect, test } from "bun:test"
import {
  ageProbe,
  createLag,
  createProbe,
  formatLag,
  lagButtonName,
  lagLegs,
  lagTone,
  lagView,
  noteDown,
  noteEcho,
  noteProbeInbound,
  noteProbeSent,
  probeDue,
  readEcho,
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

test("the button names the state and the round trip", () => {
  expect(formatLag(null)).toBe("—")
  expect(formatLag(80.4)).toBe("80 ms")
  expect(formatLag(-3)).toBe("0 ms")
  expect(lagButtonName("Live", 80.4)).toBe("Connection, live, 80 milliseconds")
  expect(lagButtonName("Reconnecting", null)).toBe("Connection, reconnecting")
})
