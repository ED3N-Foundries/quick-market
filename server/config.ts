import { marketPreferences, type PriceSource } from "../shared/market"

export type { PriceSource }

export const MIN_STAKE_MICROS = marketPreferences.minStakeMicros
export const LIVE_MS = marketPreferences.liveMs
export const TAPE_MS = marketPreferences.tapeMs

export function priceSource(): PriceSource {
  return marketPreferences.priceSource
}

export function windowMs(): number {
  return marketPreferences.windowSeconds * 1000
}

export function marketMs(): number {
  return marketPreferences.marketSeconds * 1000
}

/** Width of the scrolling chart while a bet is riding. */
export function viewMs(): number {
  return marketPreferences.viewSeconds * 1000
}

export function feeBps(): number {
  return marketPreferences.feeBps
}

export function marketBounds(id: number): { betsOpen: number; strikeAt: number; settlesAt: number } {
  const open = windowMs()
  const ride = marketMs()
  const betsOpen = id * open
  const strikeAt = betsOpen + open
  const settlesAt = strikeAt + ride
  return { betsOpen, strikeAt, settlesAt }
}

/** True when `now` is inside that window. The window is `[betsOpen, strikeAt)`. */
export function windowAccepts(roundId: number, now: number): boolean {
  if (!Number.isSafeInteger(roundId) || roundId < 0) return false
  if (!Number.isFinite(now)) return false
  const { betsOpen, strikeAt } = marketBounds(roundId)
  return now >= betsOpen && now < strikeAt
}

/** Betting windows tile the clock. The next one opens as the previous closes. */
export function clockAt(now: number) {
  const open = windowMs()
  const joinId = Math.floor(now / open)
  const blockStart = joinId * open
  const windowEndsAt = blockStart + open
  const prev = joinId - 1
  const liveId = prev >= 0 && now < marketBounds(prev).settlesAt ? prev : -1
  return {
    block: open,
    cycle: joinId,
    blockStart,
    phase: now - blockStart,
    windowOpen: true,
    joinId,
    liveId,
    windowEndsAt,
    blockEnd: windowEndsAt,
  }
}
