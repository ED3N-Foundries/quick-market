/** How long a known balance counts to its next value. */
export const BALANCE_MS = 480

/**
 * Integer micros along an ease-out curve.
 * `t` is clamped. The end of the curve is exactly `to`.
 */
export function balanceStep(from: number, to: number, t: number): number {
  if (t <= 0) return from
  if (t >= 1) return to
  const eased = 1 - (1 - t) ** 3
  return Math.round(from + (to - from) * eased)
}
