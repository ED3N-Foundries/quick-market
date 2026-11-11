import { RENDER_MS } from "../../shared/market"
import { buyInSession, rideWindow } from "./buyInChart"
import type { Band, Board, OpenBuyIn, PoolCard } from "./types"

function findMarket(board: Board, id: number): Band | null {
  if (board.live?.id === id) return board.live
  if (board.join?.id === id) return board.join
  return board.bands.find((band) => band.id === id) ?? null
}

/** The open bet that settles first and is still running. */
export function heldMarket(board: Board, openBuyIns: OpenBuyIn[], now: number): Band | null {
  let best: Band | null = null
  for (const bet of openBuyIns) {
    const market = findMarket(board, bet.roundId)
    if (!market || market.settlesAt <= now) continue
    if (!best || market.settlesAt < best.settlesAt || (market.settlesAt === best.settlesAt && market.id < best.id)) {
      best = market
    }
  }
  return best
}

function isResolving(market: Band | null, now: number): market is Band {
  return !!market?.strike && now >= market.strikeAt && now < market.settlesAt
}

/** The market on the chart from its strike through settlement.
 *  Only a bet you are riding, after its strike and before it settles.
 *  An unbetted user stays on the betting window, and an unstruck bet does not switch it.
 */
export function chartMarket(board: Board, openBuyIns: OpenBuyIn[], now: number): Band | null {
  const held = heldMarket(board, openBuyIns, now)
  if (isResolving(held, now)) return held
  return null
}

/** Follow span for the chart. A struck bet walks across one view from the strike,
 *  then rides with now on the right until settlement. Otherwise the betting
 *  window that contains now.
 */
export function followWindow(
  board: Board,
  openBuyIns: OpenBuyIn[],
  now: number,
  viewMs = 5_000,
): { start: number; end: number } {
  const market = chartMarket(board, openBuyIns, now)
  if (market) return rideWindow(market, now, viewMs)
  return buyInWindow(board, now)
}

/** The betting window on screen. A clock within the render delay of the server's
 *  join id stays on that id. It does not roll into the neighbor, and the price
 *  delay is not applied to `now`.
 */
export function buyInWindow(board: Board, now: number): { start: number; end: number } {
  const session = buyInSession(board, now)
  const join = board.join
  if (!join) return session
  const start = board.blockStart
  const end = board.windowEndsAt
  const windowMs = end - start
  if (!(windowMs > 0) || Math.floor(start / windowMs) !== join.id) return session
  if (Math.floor(session.start / windowMs) === join.id) return session
  const skew = Math.min(Math.abs(now - start), Math.abs(now - end))
  if (skew <= RENDER_MS) return { start, end }
  return session
}

/** Locked strike for the chart horizon. A market that has not struck yet has none. */
export function heldStrike(market: { strike: string | null } | null): { price: number; text: string } | null {
  if (!market?.strike) return null
  const price = Number(market.strike)
  if (!Number.isFinite(price)) return null
  return { price, text: market.strike }
}

export type ClockFace = {
  kind: "buy-in" | "settles" | "opens"
  endsAt: number
  /** Finite span caps the painted tenths one step under the span. Infinity floors only. */
  spanMs: number
}

/** What the upper-right clock counts toward.
 *  A handoff that has already resumed does not hold Opens at 0.
 *  A running position counts to settlement. Otherwise the buy-in window that
 *  contains now, including a local roll once the published end is behind.
 */
export function clockFace(board: Board, now: number, held: Band | null, handoffResumeAt: number | null): ClockFace {
  if (handoffResumeAt != null && handoffResumeAt > now) {
    return { kind: "opens", endsAt: handoffResumeAt, spanMs: Number.POSITIVE_INFINITY }
  }
  if (held && held.settlesAt > now) {
    return { kind: "settles", endsAt: held.settlesAt, spanMs: Number.POSITIVE_INFINITY }
  }
  const window = buyInWindow(board, now)
  return { kind: "buy-in", endsAt: window.end, spanMs: Math.max(1, window.end - window.start) }
}

/** Rounds the server still has open at `now`. An expired join is not one of them. */
export function listedRoundIds(board: Board, now: number): number[] {
  const ids: number[] = []
  if (board.live && board.live.settlesAt > now) ids.push(board.live.id)
  if (board.join && board.join.strikeAt > now) ids.push(board.join.id)
  return ids
}

function windowId(window: { start: number; end: number }): number | null {
  const span = window.end - window.start
  if (!(span > 0)) return null
  return Math.floor(window.start / span)
}

/** Pool shown in the trade panel. A held market wins.
 *  Otherwise the betting window that contains now. An expired join is not that
 *  window: use a matching open band, or nothing until a snapshot fills it.
 */
export function focusPool(board: Board | null, openBuyIns: OpenBuyIn[], now: number): PoolCard | null {
  if (!board) return null
  const held = heldMarket(board, openBuyIns, now)
  if (held) {
    if (board.live?.id === held.id) return board.live
    if (board.join?.id === held.id) return board.join
    return { ...held, tray: [] }
  }
  const window = buyInWindow(board, now)
  const id = windowId(window)
  if (board.join && board.join.id === id) return board.join
  const band = id == null ? undefined : board.bands.find((row) => row.id === id && row.status === "open")
  if (band) return { ...band, tray: [] }
  return null
}
