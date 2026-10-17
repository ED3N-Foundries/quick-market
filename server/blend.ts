const PRICE = /^\d+(\.\d+)?$/

type Dec = { n: bigint; scale: number }

/** Equal-weight mean of two decimal price strings. An odd sum keeps one extra digit. */
export function averagePrice(left: string, right: string): string | null {
  const scaled = scalePair(left, right)
  if (!scaled) return null
  const sum = scaled.left + scaled.right
  if (sum === 0n) return null
  const half = sum / 2n
  if (sum % 2n === 0n) return formatScaled(half, scaled.scale)
  return formatScaled(half * 10n + 5n, scaled.scale + 1)
}

/**
 * Size-weighted touch price, rounded half-up to 4 decimal places.
 * A missing or zero size falls back to the plain mid.
 */
export function microPrice(bid: string, ask: string, bidQty?: string | null, askQty?: string | null): string | null {
  const mid = averagePrice(bid, ask)
  const left = bidQty ? parseDec(bidQty) : null
  const right = askQty ? parseDec(askQty) : null
  if (!left || !right || left.n === 0n || right.n === 0n) return mid
  const b = parseDec(bid)
  const a = parseDec(ask)
  if (!b || !a) return null
  const num = addDec(mulDec(b, right), mulDec(a, left))
  const den = addDec(left, right)
  return divRound(num, den, 4)
}

/** True when the absolute gap is at most `dollars`. */
export function withinDollars(left: string, right: string, dollars: number): boolean {
  return compareAbs(left, right, String(dollars)) <= 0
}

/** Absolute gap between two decimal prices. Trailing zeros are trimmed. */
export function dollarGap(left: string, right: string): string | null {
  const gap = absDiff(left, right)
  if (!gap) return null
  const text = formatScaled(gap.n, gap.scale)
  if (!text.includes(".")) return text
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "")
  return trimmed.length === 0 ? "0" : trimmed
}

/** True when the absolute gap is at least `threshold`. */
export function movedAtLeast(left: string, right: string, threshold: string): boolean {
  return compareAbs(left, right, threshold) >= 0
}

function compareAbs(left: string, right: string, threshold: string): number {
  const gap = absDiff(left, right)
  const limit = parseDec(threshold)
  if (!gap || !limit) return 1
  const scale = Math.max(gap.scale, limit.scale)
  const a = scaleTo(gap.n, gap.scale, scale)
  const b = scaleTo(limit.n, limit.scale, scale)
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function absDiff(left: string, right: string): Dec | null {
  const a = parseDec(left)
  const b = parseDec(right)
  if (!a || !b) return null
  const scale = Math.max(a.scale, b.scale)
  const x = scaleTo(a.n, a.scale, scale)
  const y = scaleTo(b.n, b.scale, scale)
  return { n: x > y ? x - y : y - x, scale }
}

function parseDec(value: string): Dec | null {
  if (!PRICE.test(value)) return null
  const [whole, frac = ""] = value.split(".")
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, "")
  return { n: BigInt(digits), scale: frac.length }
}

function scaleTo(n: bigint, from: number, to: number): bigint {
  if (to <= from) return n / 10n ** BigInt(from - to)
  return n * 10n ** BigInt(to - from)
}

function mulDec(left: Dec, right: Dec): Dec {
  return { n: left.n * right.n, scale: left.scale + right.scale }
}

function addDec(left: Dec, right: Dec): Dec {
  const scale = Math.max(left.scale, right.scale)
  return { n: scaleTo(left.n, left.scale, scale) + scaleTo(right.n, right.scale, scale), scale }
}

function divRound(num: Dec, den: Dec, places: number): string | null {
  if (den.n === 0n) return null
  const extra = places + 1
  const numerator = num.n * 10n ** BigInt(den.scale + extra)
  const denominator = den.n * 10n ** BigInt(num.scale)
  const raw = numerator / denominator
  const rounded = (raw + 5n) / 10n
  return formatScaled(rounded, places)
}

function scalePair(left: string, right: string): { left: bigint; right: bigint; scale: number } | null {
  const a = parts(left)
  const b = parts(right)
  if (!a || !b) return null
  const scale = Math.max(a.frac.length, b.frac.length)
  return {
    left: digits(a.whole + a.frac.padEnd(scale, "0")),
    right: digits(b.whole + b.frac.padEnd(scale, "0")),
    scale,
  }
}

function parts(value: string): { whole: string; frac: string } | null {
  if (!PRICE.test(value)) return null
  const [whole, frac = ""] = value.split(".")
  return { whole, frac }
}

function digits(value: string): bigint {
  return BigInt(value.replace(/^0+(?=\d)/, ""))
}

function formatScaled(value: bigint, scale: number): string {
  const text = value.toString().padStart(scale + 1, "0")
  if (scale === 0) return text
  const cut = text.length - scale
  return `${text.slice(0, cut)}.${text.slice(cut)}`
}
