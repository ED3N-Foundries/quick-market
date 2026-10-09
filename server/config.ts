export const MIN_STAKE_MICROS = 1_000_000
export const STARTING_BALANCE_MICROS = 10_000_000_000
export const LIVE_MS = 5_000
export const TAPE_MS = 15 * 60 * 1000

export type PriceSource = "binance" | "coinbase"

export function priceSource(): PriceSource {
  return process.env.PRICE_SOURCE === "coinbase" ? "coinbase" : "binance"
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

export function blockMs(): number {
  return windowMs() + marketMs()
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
  const block = blockMs()
  const open = windowMs()
  const betsOpen = id * block
  const strikeAt = betsOpen + open
  const settlesAt = strikeAt + block
  return { betsOpen, strikeAt, settlesAt }
}

export function clockAt(now: number) {
  const block = blockMs()
  const open = windowMs()
  const cycle = Math.floor(now / block)
  const blockStart = cycle * block
  const phase = now - blockStart
  const windowOpen = phase < open
  return {
    block,
    cycle,
    blockStart,
    phase,
    windowOpen,
    joinId: windowOpen ? cycle : (null as number | null),
    liveId: windowOpen ? cycle - 1 : cycle,
    windowEndsAt: blockStart + open,
    blockEnd: blockStart + block,
  }
}
