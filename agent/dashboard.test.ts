import { expect, test } from "bun:test"
import {
  followOffset,
  handleKey,
  keyFromEvent,
  renderSnapshot,
  rosterCapacity,
  type DashState,
} from "./dashboard"
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

function state(partial: Partial<DashState> = {}): DashState {
  return { selected: 0, filter: "all", help: false, control: parseControl(null), ...partial }
}

test("the overview is one page", () => {
  const screen = renderSnapshot(snapshot(), state(), 2_000)
  expect(screen.split("\n").length).toBeLessThan(12)
  expect(screen).toContain("Manila 03:15:00")
  expect(screen).toContain("online 30")
  expect(screen).toContain("book")
  expect(screen).toContain("money")
  expect(screen).toContain("p50")
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
  const pinned = handleKey(state(), "]", null, 0)
  expect(pinned.state.control.mode).toBe("pin")
  expect(pinned.state.control.pin).toBe(31)
  const paused = handleKey(pinned.state, "b", null, 0)
  expect(paused.state.control.bettingPaused).toBe(true)
  const one = handleKey(paused.state, "p", "0xabc", 3)
  expect(one.state.control.paused).toEqual(["0xabc"])
  const screen = renderSnapshot(snapshot(), { control: one.state.control }, 2_000)
  expect(screen.split("\n").length).toBeLessThan(12)
  expect(screen).toContain("pin 31")
  expect(screen).toContain("bets paused")
  expect(screen).toContain("paused 1")
  const cleared = handleKey(one.state, "P", "0xabc", 3)
  expect(cleared.state.control.paused).toEqual([])
})

test("the filter cycles the useful lists and the view keys do nothing", () => {
  const stuck = handleKey(state(), "f", null, 4)
  expect(stuck.state.filter).toBe("stuck")
  expect(stuck.state.selected).toBe(0)
  const richest = handleKey(stuck.state, "f", null, 4)
  expect(richest.state.filter).toBe("richest")
  const back = handleKey(richest.state, "f", null, 4)
  expect(back.state.filter).toBe("all")
  const numbered = handleKey({ ...state(), selected: 2 }, "1", null, 4)
  expect(numbered.state.selected).toBe(2)
  const helped = handleKey(state(), "?", null, 4)
  expect(helped.state.help).toBe(true)
  expect(handleKey(helped.state, "?", null, 4).state.help).toBe(false)
})

test("the roster follows the selection and the terminal size", () => {
  expect(followOffset(0, 0, 100, 10)).toBe(0)
  expect(followOffset(0, 10, 100, 10)).toBe(1)
  expect(followOffset(20, 10, 100, 10)).toBe(10)
  expect(followOffset(90, 99, 100, 10)).toBe(90)
  const wide = rosterCapacity(120, 24, { help: false, error: false, stacked: false })
  const narrow = rosterCapacity(70, 24, { help: false, error: false, stacked: true })
  const short = rosterCapacity(120, 12, { help: false, error: false, stacked: false })
  expect(wide).toBeGreaterThan(narrow)
  expect(short).toBeLessThan(wide)
  expect(rosterCapacity(120, 24, { help: true, error: false, stacked: false })).toBe(wide - 2)
})

test("terminal keys map onto the steering letters", () => {
  expect(keyFromEvent({ name: "up", sequence: "\u001b[A" })).toBe("k")
  expect(keyFromEvent({ name: "down", sequence: "\u001b[B" })).toBe("j")
  expect(keyFromEvent({ name: "/", shift: true, sequence: "?" })).toBe("?")
  expect(keyFromEvent({ name: "p", shift: true, sequence: "P" })).toBe("P")
  expect(keyFromEvent({ name: "c", ctrl: true, sequence: "\u0003" })).toBe("\u0003")
})
