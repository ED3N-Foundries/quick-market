/**
 * Horizontal nudge centers the ink box, so the side margins match.
 * Vertical nudge centers the pixel mass. The tail of the q is lighter than
 * the letters, and centering the whole box lifts the letters too high.
 * A half pixel rounds away from zero.
 */
export function inkNudge(width: number, height: number, minX: number, maxX: number, massY: number) {
  return {
    dx: pixelShift((width - 1) / 2 - (minX + maxX) / 2),
    dy: pixelShift((height - 1) / 2 - massY),
  }
}

function pixelShift(delta: number) {
  const base = Math.floor(delta)
  if (delta - base === 0.5) return delta < 0 ? base : base + 1
  return Math.round(delta)
}
