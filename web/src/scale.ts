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

/** A new fit inside this fraction of the current half does not change the zoom. */
export const HOLD_RATIO = 0.7

/**
 * Half-range actually drawn.
 * A print that does not fit snaps wider in one jump. A new fit that is still
 * at least `HOLD_RATIO` of the current half holds, so noise around the baseline
 * does not zoom. A fit below that band snaps tighter once. `reset` snaps too.
 */
export function shownHalf(current: number, target: number, content: number, reset: boolean): number {
  const extent = Number.isFinite(content) ? content : 0
  const fit = Math.max(target, extent, HALF_FLOOR)
  if (reset || !Number.isFinite(current) || current <= 0) return fit
  if (extent > current) return fit
  if (fit >= current * HOLD_RATIO) return current
  return fit
}
