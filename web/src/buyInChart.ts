import type { Board } from "./types"

/** Fixed betting window that contains `now`. The next window starts when this one ends.
 *  A struck bet uses the market from its strike to settlement instead.
 */
export function buyInSession(board: Board, now: number): { start: number; end: number } {
  const windowMs = Math.max(1, board.windowEndsAt - board.blockStart)
  let origin = board.blockStart
  if (now >= origin + windowMs) origin += Math.floor((now - origin) / windowMs) * windowMs
  else if (now < origin) origin -= (Math.floor((origin - now - 1) / windowMs) + 1) * windowMs
  return { start: origin, end: origin + windowMs }
}
