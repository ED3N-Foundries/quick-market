export const MIN_STAKE_MICROS = 1_000_000
export const STARTING_BALANCE_MICROS = 10_000_000_000
export const LIVE_MS = 5_000
export const TAPE_MS = 15 * 60 * 1000

export type PriceSource = "binance" | "coinbase" | "average"

export function priceSource(): PriceSource {
  if (process.env.PRICE_SOURCE === "coinbase") return "coinbase"
  if (process.env.PRICE_SOURCE === "average") return "average"
  return "binance"
}

export function windowMs(): number {
  const seconds = Number(process.env.WINDOW_SECONDS ?? 5)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) return 5_000
  return seconds * 1000
}

export function marketMs(): number {
  const seconds = Number(process.env.MARKET_SECONDS ?? 5)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) return 5_000
  return seconds * 1000
}

/** Width of the scrolling chart while a bet is riding. */
export function viewMs(): number {
  const seconds = Number(process.env.VIEW_SECONDS ?? 5)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) return 5_000
  return seconds * 1000
}

export function botCount(): number {
  const n = Number(process.env.BOT_COUNT ?? 8)
  if (!Number.isInteger(n) || n < 0 || n > 40) return 8
  return n
}

export function feeBps(): number {
  const n = Number(process.env.FEE_BPS ?? 25)
  if (!Number.isInteger(n) || n < 0 || n > 10_000) return 25
  return n
}

export function marketBounds(id: number): { betsOpen: number; strikeAt: number; settlesAt: number } {
  const open = windowMs()
  const ride = marketMs()
  const betsOpen = id * open
  const strikeAt = betsOpen + open
  const settlesAt = strikeAt + ride
  return { betsOpen, strikeAt, settlesAt }
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
