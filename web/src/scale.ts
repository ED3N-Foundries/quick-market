export const HALF_FLOOR = 0.04
/** Furthest print sits this far from the center toward the edge, so the line keeps a margin. */
const FIT = 0.9

export type PricePoint = { t: number; price: number }

/**
 * Price in force when the chart window opened. Prints after `viewStart` do not move it.
 * The caller pins this to the vertical center and only zooms in or out around it.
 */
export function openPrice(points: PricePoint[], viewStart: number): number | null {
  let carried: number | null = null
  for (const point of points) {
    if (!Number.isFinite(point.t) || !Number.isFinite(point.price)) continue
    if (point.t > viewStart) return carried ?? point.price
    carried = point.price
  }
  return carried
}

/**
 * Half the price range in dollars. The caller pins `baseline` to the vertical center.
 * Every point in the window counts, so the scale zooms out around that center
 * instead of sliding the frame up or down to follow the last print.
 */
export function halfSpan(points: PricePoint[], baseline: number): number {
  const extent = contentHalf(points, baseline)
  if (!(extent > 0)) return HALF_FLOOR
  return Math.max(extent / FIT, HALF_FLOOR)
}

/** How far the window's prints sit from `baseline`, with no padding. */
export function contentHalf(points: PricePoint[], baseline: number): number {
  if (!Number.isFinite(baseline)) return 0
  let extent = 0
  for (const point of points) {
    if (!Number.isFinite(point.price)) continue
    extent = Math.max(extent, Math.abs(point.price - baseline))
  }
  return extent
}

/**
 * Half-range actually drawn.
 * A print that no longer fits snaps wider in one jump. A larger target that
 * still fits holds, so the scale does not jitter outward. A smaller target
 * snaps to a range that still fits every print. `reset` snaps too.
 */
export function shownHalf(current: number, target: number, content: number, reset: boolean): number {
  const fit = Math.max(target, Number.isFinite(content) ? content : 0)
  if (reset || !Number.isFinite(current)) return fit
  if (content > current) return fit
  if (target >= current) return current
  return fit
}
