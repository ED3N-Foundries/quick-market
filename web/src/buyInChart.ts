import type { Board } from "./types"

/** Fixed betting window that contains `now`. The next window starts when this one ends.
 *  The market chart uses `marketScroll` instead.
 */
export function buyInSession(board: Board, now: number): { start: number; end: number } {
  const windowMs = Math.max(1, board.windowEndsAt - board.blockStart)
  let origin = board.blockStart
  if (now >= origin + windowMs) origin += Math.floor((now - origin) / windowMs) * windowMs
  else if (now < origin) origin -= (Math.floor((origin - now - 1) / windowMs) + 1) * windowMs
  return { start: origin, end: origin + windowMs }
}

/** Rolling market camera. `now` sits on the right edge and the tape moves left. */
export function marketScroll(now: number, viewMs: number): { start: number; end: number } {
  const width = Number.isFinite(viewMs) && viewMs > 0 ? viewMs : 5_000
  return { start: now - width, end: now }
}
