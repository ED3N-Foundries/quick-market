import { betSession, marketScroll } from "./betChart"
import type { Band, Board, OpenBet, PoolCard } from "./types"

function findMarket(board: Board, id: number): Band | null {
  if (board.live?.id === id) return board.live
  if (board.join?.id === id) return board.join
  return board.bands.find((band) => band.id === id) ?? null
}

/** The open bet that settles first and is still running. */
export function heldMarket(board: Board, openBets: OpenBet[], now: number): Band | null {
  let best: Band | null = null
  for (const bet of openBets) {
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

/** The market the rolling chart is centered on.
 *  Only a bet you are riding, after its strike and before it settles.
 *  An unbetted user stays on the betting window, and an unstruck bet does not roll it.
 */
export function chartMarket(board: Board, openBets: OpenBet[], now: number): Band | null {
  const held = heldMarket(board, openBets, now)
  if (isResolving(held, now)) return held
  return null
}

/** Follow span for the chart. The market chart scrolls one view wide with now
 *  on the right edge. The bet chart stays the fixed slice that contains now.
 *  A held bet does not change the width.
 */
export function followWindow(board: Board, openBets: OpenBet[], now: number, viewMs = 5_000): { start: number; end: number } {
  if (chartMarket(board, openBets, now)) return marketScroll(now, viewMs)
  return betSession(board, now)
}

/** Locked strike for the chart horizon. A market that has not struck yet has none. */
export function heldStrike(market: { strike: string | null } | null): { price: number; text: string } | null {
  if (!market?.strike) return null
  const price = Number(market.strike)
  if (!Number.isFinite(price)) return null
  return { price, text: market.strike }
}

/** The join card is the window the synced clock is still inside. */
export function joinIsLive(board: Board, now: number): boolean {
  if (!board.join) return false
  const windowMs = board.windowEndsAt - board.blockStart
  if (windowMs <= 0) return false
  if (now < board.blockStart || now >= board.windowEndsAt) return false
  return board.join.id === Math.floor(now / windowMs)
}

/** Pool shown in the trade panel. A held market wins. Otherwise the open betting window. */
export function focusPool(board: Board | null, openBets: OpenBet[], now: number): PoolCard | null {
  if (!board) return null
  const held = heldMarket(board, openBets, now)
  if (!held) return board.join
  if (board.live?.id === held.id) return board.live
  if (board.join?.id === held.id) return board.join
  return { ...held, tray: [] }
}
