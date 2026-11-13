import { expect, test } from "bun:test"
import { RENDER_MS } from "../../shared/market"
import type { Band, Board, BoardPatch } from "../../shared/stream"
import { applyBookPatch } from "./boardStream"
import { acceptStateBoard, missingCardWindow, patchNeedsSnapshot } from "./boardRepair"
import { focusPool } from "./focus"

function band(id: number): Band {
  return {
    id,
    buyInOpen: id * 10_000,
    strikeAt: id * 10_000 + 10_000,
    settlesAt: id * 10_000 + 20_000,
    strike: null,
    status: "open",
    poolUpMicros: 0,
    poolDownMicros: 0,
    playersUp: 0,
    playersDown: 0,
  }
}

function boardFor(id: number): Board {
  const card = { ...band(id), tray: [] }
  return {
    blockStart: card.buyInOpen,
    blockEnd: card.strikeAt,
    windowEndsAt: card.strikeAt,
    phase: "buy-in",
    join: card,
    live: null,
    bands: [band(id)],
  }
}

test("an older state board is ignored and a newer one replaces it", () => {
  expect(acceptStateBoard(null, 1_000)).toBe(true)
  expect(acceptStateBoard(2_000, 1_000)).toBe(false)
  expect(acceptStateBoard(2_000, 2_000)).toBe(true)
  expect(acceptStateBoard(2_000, 2_500)).toBe(true)
})

test("a patch that leaves no bet card needs a snapshot", () => {
  const current = boardFor(2)
  const patch: BoardPatch = {
    blockStart: 30_000,
    blockEnd: 40_000,
    windowEndsAt: 40_000,
    phase: "buy-in",
  }
  const torn = applyBookPatch(current, patch)
  expect(torn.join?.id).toBe(2)
  const open = { board: torn, openBuyIns: [], now: 35_000, feed: "live" as const, handoff: null }
  expect(patchNeedsSnapshot(open)).toBe(true)
  expect(patchNeedsSnapshot({ ...open, feed: "stale" })).toBe(false)
  expect(patchNeedsSnapshot({ ...open, handoff: { from: "binance", to: "bybit", resumeAt: 40_000 } })).toBe(false)

  const empty = boardFor(3)
  expect(empty.join?.poolUpMicros).toBe(0)
  expect(empty.join?.poolDownMicros).toBe(0)
  expect(patchNeedsSnapshot({ board: empty, openBuyIns: [], now: 35_000, feed: "live", handoff: null })).toBe(false)
  expect(focusPool(empty, [], 35_000)?.id).toBe(3)
})

test("a missing card asks once per window and stays quiet inside the render grace", () => {
  const current = boardFor(2)
  const graceNow = current.windowEndsAt + RENDER_MS
  expect(focusPool(current, [], graceNow)?.id).toBe(2)
  expect(patchNeedsSnapshot({ board: current, openBuyIns: [], now: graceNow, feed: "live", handoff: null })).toBe(false)

  const past = current.windowEndsAt + RENDER_MS + 1
  expect(focusPool(current, [], past)).toBeNull()
  const ask = { board: current, openBuyIns: [], now: past, feed: "live" as const, handoff: null, requestedWindow: null }
  expect(missingCardWindow(ask)).toBe(current.windowEndsAt)
  expect(missingCardWindow({ ...ask, requestedWindow: current.windowEndsAt })).toBeNull()
})
