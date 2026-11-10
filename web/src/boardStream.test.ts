import { expect, test } from "bun:test"
import type { Band, Board } from "../../shared/stream"
import { applyBookPatch, boardPatch } from "./boardStream"

function band(id: number, pool = 0): Band {
  return {
    id,
    buyInOpen: id * 10_000,
    strikeAt: id * 10_000 + 10_000,
    settlesAt: id * 10_000 + 20_000,
    strike: null,
    status: "open",
    poolUpMicros: pool,
    poolDownMicros: 0,
    playersUp: pool > 0 ? 1 : 0,
    playersDown: 0,
  }
}

function board(): Board {
  const join = { ...band(2), tray: [] }
  return {
    blockStart: 20_000,
    blockEnd: 30_000,
    windowEndsAt: 30_000,
    phase: "buy-in",
    join,
    live: null,
    bands: [band(0), band(1), band(2)],
  }
}

test("a patch changes only the updated card and band", () => {
  const before = board()
  const after = board()
  after.join!.poolUpMicros = 5_000_000
  after.join!.playersUp = 1
  after.bands[2]!.poolUpMicros = 5_000_000
  after.bands[2]!.playersUp = 1
  const patch = boardPatch(before, after)
  expect(patch.join?.poolUpMicros).toBe(5_000_000)
  expect(patch.bands).toEqual([after.bands[2]])
  expect(applyBookPatch(before, patch)).toEqual(after)
  expect(before.join?.poolUpMicros).toBe(0)
})

test("unchanged fields and bands are omitted", () => {
  const current = board()
  const patch = boardPatch(current, current)
  expect(patch.join).toBeUndefined()
  expect(patch.live).toBeUndefined()
  expect(patch.bands).toBeUndefined()
  expect(patch.removeBandIds).toBeUndefined()
  expect(applyBookPatch(current, patch)).toEqual(current)
})

test("a patch removes expired bands and supports a null initial board", () => {
  const before = board()
  const after = board()
  after.bands = after.bands.slice(1)
  const patch = boardPatch(before, after)
  expect(patch.removeBandIds).toEqual([0])
  expect(applyBookPatch(before, patch)).toEqual(after)
  expect(boardPatch(null, after).bands).toEqual(after.bands)
})
