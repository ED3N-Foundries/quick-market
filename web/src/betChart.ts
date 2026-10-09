import type { Board } from "./types"

/** Live frame when nobody is holding a bet.
 *  A session is the open betting window, then the stretch until the next
 *  one opens. The frame always contains `now`, so the tape rolls into the
 *  next session instead of sitting on a window that has already ended.
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
