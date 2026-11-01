import type { Board } from "./types"

/** Fixed betting window that contains `now`. The next window starts when this one ends.
 *  A struck bet uses `rideWindow` instead.
 */
export function buyInSession(board: Board, now: number): { start: number; end: number } {
  const windowMs = Math.max(1, board.windowEndsAt - board.blockStart)
  let origin = board.blockStart
  if (now >= origin + windowMs) origin += Math.floor((now - origin) / windowMs) * windowMs
  else if (now < origin) origin -= (Math.floor((origin - now - 1) / windowMs) + 1) * windowMs
  return { start: origin, end: origin + windowMs }
}

/** Struck-bet camera. One view opens on the strike and the cursor walks to the
 *  right edge. Once it arrives, `now` stays on that edge and the tape rides
 *  until settlement. The window never starts before the strike.
 */
export function rideWindow(
  market: { strikeAt: number; settlesAt: number },
  now: number,
  viewMs: number,
): { start: number; end: number } {
  const width = Number.isFinite(viewMs) && viewMs > 0 ? viewMs : 5_000
  const strike = market.strikeAt
  const settle = market.settlesAt
  const shown = Math.min(width, Math.max(1, settle - strike))
  const filledAt = strike + shown
  if (now < filledAt) return { start: strike, end: filledAt }
  const end = Math.min(now, settle)
  return { start: Math.max(strike, end - shown), end }
}
