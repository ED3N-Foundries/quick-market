/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { DashboardView } from "./screen"
import { histogram, parseControl, type SwarmSnapshot } from "./status"
import type { WalletRow } from "./swarmdb"

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
    trace: [300, 400, 500, 450, 420],
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
      histogram: histogram([4_000_000, 20_000_000]),
    },
    lastError: null,
    bookLagMs: 40,
    bettingPaused: false,
    bleed: true,
    mode: "clock",
    pin: null,
  }
}

function wallet(): WalletRow {
  return {
    address: "0xabc1234567890def",
    idx: 12,
    online: 1,
    phase: "off-peak",
    bankroll: 80_000_000,
    lastSide: "up",
    lastStake: 1_230_000,
    lastSkip: "waiting",
    wins: 3,
    losses: 1,
    mind: "tape",
    tempo: 4.2,
    visitEnd: 9_000,
    enrolled: 1,
    rngA: 1,
    gateJson: "{}",
    cursor: 0,
    visitStart: 0,
    gapEnd: 0,
    handled: 0,
    wokeAt: 1,
    sleptAt: null,
    updatedAt: 1,
  }
}

function view(width: number, height: number) {
  return (
    <DashboardView
      snapshot={snapshot()}
      page={{ rows: [wallet()], count: 1, offset: 0, selected: 0 }}
      state={{ selected: 0, filter: "all", help: false, control: parseControl(null) }}
      now={2_000}
      width={width}
      height={height}
      onSelect={() => {}}
      onScroll={() => {}}
    />
  )
}

test("a wide terminal shows the book, the money, and the roster on one screen", async () => {
  const setup = await testRender(view(120, 24), { width: 120, height: 24 })
  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    expect(frame).toContain("Manila 03:15:00")
    expect(frame).toContain("0xabc1")
    expect(frame).toContain("p50")
    expect(lines.some((line) => line.includes("mind") && line.includes("address"))).toBe(true)
    expect(lines.some((line) => line.includes("book") && line.includes("money"))).toBe(true)
    expect(frame).toContain("▁")
  } finally {
    await setup.dispose()
  }
})

test("a narrow short terminal stacks the book and drops the sparkline", async () => {
  const setup = await testRender(view(70, 12), { width: 70, height: 12 })
  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    const book = lines.find((line) => line.includes("book"))
    expect(book).toBeDefined()
    expect(book ?? "").not.toContain("money")
    expect(frame).toContain("money")
    expect(frame).not.toContain("▁")
    expect(lines.some((line) => line.includes("mind") && line.includes("address"))).toBe(false)
    const roster = lines.find((line) => line.includes("0xabc1"))
    expect(roster ?? "").not.toContain("tape")
  } finally {
    await setup.dispose()
  }
})

test("the wide layout is not the narrow layout", async () => {
  const narrowSetup = await testRender(view(70, 12), { width: 70, height: 12 })
  const wideSetup = await testRender(view(120, 24), { width: 120, height: 24 })
  try {
    await narrowSetup.renderOnce()
    await wideSetup.renderOnce()
    const narrow = narrowSetup.captureCharFrame().split("\n")
    const wide = wideSetup.captureCharFrame().split("\n")
    expect(narrow.some((line) => line.includes("book") && line.includes("money"))).toBe(false)
    expect(wide.some((line) => line.includes("book") && line.includes("money"))).toBe(true)
    expect(wide.some((line) => line.includes("mind") && line.includes("address"))).toBe(true)
  } finally {
    await narrowSetup.dispose()
    await wideSetup.dispose()
  }
})
