import { formatMoney } from "./format"
import type { ResultTone } from "./resultNotice"

/** Gap between the balance and the popover. */
export const POP_GAP = 8
/** Keep the popover inside the visible viewport. */
export const POP_MARGIN = 8
/** Gap between stacked popovers. */
export const POP_STACK = 6

export type PopBox = { width: number; height: number }

export type PopRect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type PopViewport = { width: number; height: number }

export type PopSide = "above" | "below" | "right" | "left"

export type PlacedPop = { left: number; top: number; side: PopSide }

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function maxLeft(width: number, viewportWidth: number): number {
  return Math.max(POP_MARGIN, viewportWidth - POP_MARGIN - width)
}

/**
 * Put each pill on the balance digits, inside the viewport.
 * To the right of the number first, then above, below, and to the left.
 * A stack stays on that side. The first pill is the one nearest the balance.
 */
export function placePricePops(balance: PopRect, pops: readonly PopBox[], viewport: PopViewport): PlacedPop[] {
  if (pops.length === 0 || viewport.width <= 0 || viewport.height <= 0) return []
  const sides: PopSide[] = ["right", "above", "below", "left"]
  for (const side of sides) {
    const placed = trySide(side, balance, pops, viewport)
    if (placed) return placed
  }
  return clampBelow(balance, pops, viewport)
}

/** Line the pill's right edge up with the end of the balance. */
function alignEnd(balance: PopRect, popWidth: number, viewportWidth: number): number {
  return clamp(balance.right - popWidth, POP_MARGIN, maxLeft(popWidth, viewportWidth))
}

function trySide(side: PopSide, balance: PopRect, pops: readonly PopBox[], viewport: PopViewport): PlacedPop[] | null {
  const placed: PlacedPop[] = []
  if (side === "above") {
    let bottom = balance.top - POP_GAP
    for (const pop of pops) {
      const top = bottom - pop.height
      const left = alignEnd(balance, pop.width, viewport.width)
      if (top < POP_MARGIN || left + pop.width > viewport.width - POP_MARGIN) return null
      placed.push({ left, top, side })
      bottom = top - POP_STACK
    }
    return placed
  }
  if (side === "below") {
    let top = balance.bottom + POP_GAP
    for (const pop of pops) {
      const left = alignEnd(balance, pop.width, viewport.width)
      if (top + pop.height > viewport.height - POP_MARGIN || left + pop.width > viewport.width - POP_MARGIN) return null
      placed.push({ left, top, side })
      top += pop.height + POP_STACK
    }
    return placed
  }
  if (side === "right") {
    let top = balance.top + (balance.height - (pops[0]?.height ?? 0)) / 2
    for (const pop of pops) {
      const left = balance.right + POP_GAP
      if (left < POP_MARGIN || top < POP_MARGIN || left + pop.width > viewport.width - POP_MARGIN || top + pop.height > viewport.height - POP_MARGIN) {
        return null
      }
      placed.push({ left, top, side })
      top += pop.height + POP_STACK
    }
    return placed
  }
  let top = balance.top + (balance.height - (pops[0]?.height ?? 0)) / 2
  for (const pop of pops) {
    const left = balance.left - POP_GAP - pop.width
    if (left < POP_MARGIN || top < POP_MARGIN || top + pop.height > viewport.height - POP_MARGIN) return null
    placed.push({ left, top, side })
    top += pop.height + POP_STACK
  }
  return placed
}

/** Last resort when every side clips: pin under the balance and pull it back on screen. */
function clampBelow(balance: PopRect, pops: readonly PopBox[], viewport: PopViewport): PlacedPop[] {
  const stackHeight = pops.reduce((sum, pop) => sum + pop.height, 0) + POP_STACK * (pops.length - 1)
  let top = clamp(balance.bottom + POP_GAP, POP_MARGIN, Math.max(POP_MARGIN, viewport.height - POP_MARGIN - stackHeight))
  return pops.map((pop) => {
    const left = alignEnd(balance, pop.width, viewport.width)
    const placed = { left, top, side: "below" as const }
    top += pop.height + POP_STACK
    return placed
  })
}

/** The figure on a settled popover. A win is the gain. A loss is the stake. A flat close is zero. */
export function pricePopText(tone: ResultTone, amountMicros: number, signed: boolean): string {
  if (tone === "debit") return `−${formatMoney(amountMicros)}`
  if (signed && amountMicros > 0) return formatMoney(amountMicros, true)
  return `=${formatMoney(0)}`
}
