import type { Band, Board, BoardPatch } from "../../shared/stream"

export { boardPatch } from "../../shared/stream"

export function applyBookPatch(current: Board, patch: BoardPatch): Board {
  const bands = new Map<number, Band>()
  for (const band of current.bands) bands.set(band.id, band)
  for (const id of patch.removeBandIds ?? []) bands.delete(id)
  for (const band of patch.bands ?? []) bands.set(band.id, band)
  return {
    blockStart: patch.blockStart,
    blockEnd: patch.blockEnd,
    windowEndsAt: patch.windowEndsAt,
    phase: patch.phase,
    join: patch.join === undefined ? current.join : patch.join,
    live: patch.live === undefined ? current.live : patch.live,
    bands: [...bands.values()].sort((left, right) => left.id - right.id),
  }
}
