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

/** Follow span for the chart. A held market stays fixed until it settles.
 *  With no bet, the chart stays on the betting window that has started.
 *  After that window closes, the same open is held and the tape follows until the next one begins.
 */
export function followWindow(board: Board, openBets: OpenBet[], now: number): { start: number; end: number } {
  const held = heldMarket(board, openBets, now)
  if (held) return { start: held.betsOpen, end: held.settlesAt }
  const start = board.blockStart
  const windowEnd = board.windowEndsAt
  if (now <= windowEnd) return { start, end: windowEnd }
  return { start, end: Math.max(windowEnd, Math.min(now, board.blockEnd)) }
}

/** Pool shown in the trade panel. A held market wins. Otherwise only the bet window. */
export function focusPool(board: Board | null, openBets: OpenBet[], now: number): PoolCard | null {
  if (!board) return null
  const held = heldMarket(board, openBets, now)
  if (!held) return board.phase === "bets" ? board.join : null
  if (board.live?.id === held.id) return board.live
  if (board.join?.id === held.id) return board.join
  return { ...held, tray: [] }
}
