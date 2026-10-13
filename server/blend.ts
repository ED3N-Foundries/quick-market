import { LIVE_MS } from "./config"

const PRICE = /^\d+(\.\d+)?$/

export type Leg = { price: string; receivedAt: number }

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
 * Last trade from each venue. Emits only when both arrived within maxAge and
 * differ by at most 1% of their midpoint. A missing or stale leg emits nothing.
 */
export function blendLegs(
  binance: Leg | null,
  coinbase: Leg | null,
  now: number,
  maxAge = LIVE_MS,
): string | null {
  if (!binance || !coinbase) return null
  if (now - binance.receivedAt > maxAge || now - coinbase.receivedAt > maxAge) return null
  const scaled = scalePair(binance.price, coinbase.price)
  if (!scaled) return null
  const sum = scaled.left + scaled.right
  if (sum === 0n) return null
  const diff = scaled.left > scaled.right ? scaled.left - scaled.right : scaled.right - scaled.left
  // |a-b| / midpoint <= 1%. Midpoint is sum/2, so |a-b| * 200 <= sum.
  if (diff * 200n > sum) return null
  return averagePrice(binance.price, coinbase.price)
}

function scalePair(left: string, right: string): { left: bigint; right: bigint; scale: number } | null {
  const a = decimalParts(left)
  const b = decimalParts(right)
  if (!a || !b) return null
  const scale = Math.max(a.frac.length, b.frac.length)
  return {
    left: digitsToBigInt(a.whole + a.frac.padEnd(scale, "0")),
    right: digitsToBigInt(b.whole + b.frac.padEnd(scale, "0")),
    scale,
  }
}

function decimalParts(value: string): { whole: string; frac: string } | null {
  if (!PRICE.test(value)) return null
  const [whole, frac = ""] = value.split(".")
  return { whole, frac }
}

function digitsToBigInt(digits: string): bigint {
  return BigInt(digits.replace(/^0+(?=\d)/, ""))
}

function formatScaled(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, "0")
  if (scale === 0) return digits
  const cut = digits.length - scale
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`
}
