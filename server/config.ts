export const MIN_STAKE_MICROS = 1_000_000
export const STARTING_BALANCE_MICROS = 10_000_000_000
export const FUND_MICROS = 1_000_000_000
export const STALE_MS = 2_000
export const TAPE_MS = 60_000

export function roundMs(): number {
  const seconds = Number(process.env.ROUND_SECONDS ?? 10)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) return 10_000
  return seconds * 1000
}

export function feeBps(): number {
  const n = Number(process.env.FEE_BPS ?? 25)
  if (!Number.isInteger(n) || n < 0 || n > 10_000) return 25
  return n
}

export function betCutoffMs(): number {
  const n = Number(process.env.BET_CUTOFF_MS ?? 1000)
  if (!Number.isInteger(n) || n < 0) return 1000
  return n
}

export function roundIdAt(now: number): number {
  return Math.floor(now / roundMs())
}

export function roundBounds(id: number): { startsAt: number; endsAt: number } {
  const size = roundMs()
  return { startsAt: id * size, endsAt: (id + 1) * size }
}
