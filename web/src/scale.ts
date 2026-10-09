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

/**
 * How far the trailing prints sit from `baseline`. This is the half-range that
 * still keeps them on screen, with no padding.
 */
export function contentHalf(points: PricePoint[], baseline: number, now: number): number {
  if (!points.length || !Number.isFinite(baseline)) return 0
  const last = points[points.length - 1]
  if (!last) return 0
  const trailFrom = Math.min(last.t, now) - TRAIL_MS
  let extent = Math.abs(last.price - baseline)
  for (const point of points) {
    if (point.t >= trailFrom) extent = Math.max(extent, Math.abs(point.price - baseline))
  }
  return extent
}

/**
 * Half-range actually drawn.
 * A print that no longer fits snaps to the padded target so a wider swing
 * lands in one jump. A larger target that still fits holds, so the live
 * scale does not glide outward. A smaller target eases by `k` in `[0, 1]`.
 * `reset` snaps to a range that fits.
 */
export function shownHalf(current: number, target: number, content: number, k: number, reset: boolean): number {
  const fit = Math.max(target, Number.isFinite(content) ? content : 0)
  if (reset || !Number.isFinite(current)) return fit
  if (content > current) return fit
  if (target >= current) return current
  const gain = Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : 0
  return current + (target - current) * gain
}
