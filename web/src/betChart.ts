import type { Board } from "./types"

/** Fixed slice of the block that contains `now`. This is the bet chart.
 *  The market chart uses `marketScroll` instead.
 */
export function betSession(board: Board, now: number): { start: number; end: number } {
  const windowMs = Math.max(1, board.windowEndsAt - board.blockStart)
  const blockMs = Math.max(windowMs + 1, board.blockEnd - board.blockStart)
  let origin = board.blockStart
  if (now >= origin + blockMs) origin += Math.floor((now - origin) / blockMs) * blockMs
  else if (now < origin) origin -= (Math.floor((origin - now - 1) / blockMs) + 1) * blockMs
  const openEnd = origin + windowMs
  if (now < openEnd) return { start: origin, end: openEnd }
  return { start: openEnd, end: origin + blockMs }
}

/** Rolling market camera. `now` sits on the right edge and the tape moves left. */
export function marketScroll(now: number, viewMs: number): { start: number; end: number } {
  const width = Number.isFinite(viewMs) && viewMs > 0 ? viewMs : 5_000
  return { start: now - width, end: now }
}
