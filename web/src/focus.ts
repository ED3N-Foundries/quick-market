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

/** Follow span for the chart. A held market stays fixed until it settles. */
export function followWindow(board: Board, openBets: OpenBet[], now: number): { start: number; end: number } {
  const held = heldMarket(board, openBets, now)
  if (held) return { start: held.betsOpen, end: held.settlesAt }
  return { start: board.blockStart, end: board.blockEnd }
}

/** Pool shown in the trade panel. A held market wins over the phase pool. */
export function focusPool(board: Board | null, openBets: OpenBet[], now: number): PoolCard | null {
  if (!board) return null
  const held = heldMarket(board, openBets, now)
  if (!held) return board.phase === "bets" ? board.join : board.live
  if (board.live?.id === held.id) return board.live
  if (board.join?.id === held.id) return board.join
  return { ...held, tray: [] }
}

/** Vertical center. A held market uses its own strike, including no strike yet. */
export function chartBaseline(board: Board | null, openBets: OpenBet[], now: number): number | null {
  if (!board) return null
  const held = heldMarket(board, openBets, now)
  if (held) return held.strike == null ? null : Number(held.strike)
  if (board.live?.strike != null) return Number(board.live.strike)
  for (let index = board.bands.length - 1; index >= 0; index--) {
    const strike = board.bands[index]?.strike
    if (strike != null) return Number(strike)
  }
  return null
}
