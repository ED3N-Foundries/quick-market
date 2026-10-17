import { expect, test } from "bun:test"
import { handleKey, renderSnapshot, type DashState } from "./dashboard"
import { histogram, parseControl, type SwarmSnapshot } from "./status"

function snapshot(): SwarmSnapshot {
  return {
    at: 1_000,
    manila: "03:15:00",
    phase: "off-peak",
    hour: 3.25,
    window: [300, 600],
    online: 30,
    spring: 30,
    target: 30,
    arrivedMinute: 2,
    leftMinute: 1,
    trace: Array.from({ length: 180 }, (_, index) => 300 + (index % 40)),
    book: {
      roundId: 10,
      upMicros: 12_340_000,
      downMicros: 8_760_000,
      botUpMicros: 3_000_000,
      botDownMicros: 2_000_000,
      bets: 4,
      skips: 26,
      p50: 1_230_000,
      p90: 4_560_000,
    },
    money: {
      seedMicros: 80_000_000,
      mintMicros: 0,
      burnMicros: 0,
      stakeMicros: 5_000_000,
      histogram: histogram([4_000_000, 20_000_000, 80_000_000, 400_000_000, 2_000_000]),
    },
    lastError: null,
    bookLagMs: 40,
    bettingPaused: false,
    bleed: true,
    mode: "pin",
    pin: 30,
  }
}

test("the overview is one page", () => {
  const state: Pick<DashState, "view" | "selected" | "filter"> = { view: 1, selected: 0, filter: "all" }
  const screen = renderSnapshot(snapshot(), state, [], 2_000)
  expect(screen.split("\n").length).toBeLessThan(12)
  expect(screen).toContain("Manila 03:15:00")
  expect(screen).toContain("online 30")
  expect(screen).not.toContain("0x")
})

test("an old control file still means follow the clock", () => {
  const control = parseControl({ paused: ["0xABC"], queue: [{ id: "1", action: "faucet" }] })
  expect(control.mode).toBe("clock")
  expect(control.paused).toEqual(["0xabc"])
  expect(control.bleed).toBe(true)
  expect(control.bettingPaused).toBe(false)
})

test("dashboard keys steer the swarm without listing every wallet", () => {
  const start: DashState = { view: 1, selected: 0, filter: "all", control: parseControl(null) }
  const pinned = handleKey(start, "]", null, 0)
  expect(pinned.state.control.mode).toBe("pin")
  expect(pinned.state.control.pin).toBe(31)
  const paused = handleKey(pinned.state, "b", null, 0)
  expect(paused.state.control.bettingPaused).toBe(true)
  const one = handleKey(paused.state, "p", "0xabc", 3)
  expect(one.state.control.paused).toEqual(["0xabc"])
  const screen = renderSnapshot(snapshot(), { view: 4, selected: 0, filter: "all", control: one.state.control }, [], 2_000)
  expect(screen.split("\n").length).toBeLessThan(12)
  expect(screen).toContain("mode [pin 31]")
  expect(screen).toContain("bets [PAUSED]")
  expect(screen).toContain("paused 1")
  const cleared = handleKey(one.state, "P", "0xabc", 3)
  expect(cleared.state.control.paused).toEqual([])
})
