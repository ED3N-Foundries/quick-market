export const HALF_FLOOR = 0.04
const TRAIL_MS = 3_000

export type PricePoint = { t: number; price: number }

/**
 * Half the price range in dollars. The caller pins `baseline` to the vertical center.
 * The swing is the last three seconds only, so an older spike cannot flatten the needle.
 */
export function halfSpan(points: PricePoint[], baseline: number, now: number): number {
  if (!points.length || !Number.isFinite(baseline)) return HALF_FLOOR
  const last = points[points.length - 1]
  if (!last) return HALF_FLOOR
  const trailFrom = Math.min(last.t, now) - TRAIL_MS
  let high = -Infinity
  let low = Infinity
  let step = 0
  let previous: number | null = null
  let previousInTrail = false
  for (const point of points) {
    const inTrail = point.t >= trailFrom
    if (inTrail) {
      high = Math.max(high, point.price)
      low = Math.min(low, point.price)
      if (previous !== null && previousInTrail) step = Math.max(step, Math.abs(point.price - previous))
    }
    previous = point.price
    previousInTrail = inTrail
  }
  const trailRange = Number.isFinite(high) && Number.isFinite(low) ? Math.max(0, high - low) : 0
  const swing = Math.max(trailRange, step)
  const current = Math.abs(last.price - baseline)
  return Math.max(swing / 1.1, current / 0.72, HALF_FLOOR)
}
