/** Display only. Half-up to cents. The ledger stays in integer micros. */
export function formatMoney(micros: number, signed = false): string {
  const negative = micros < 0
  const abs = Math.abs(Math.trunc(micros))
  const cents = Math.floor((abs + 5_000) / 10_000)
  const whole = Math.floor(cents / 100)
  const frac = String(cents % 100).padStart(2, "0")
  const text = `${whole.toLocaleString("en-US")}.${frac}`
  if (negative && cents > 0) return `-$${text}`
  if (signed && cents > 0) return `+$${text}`
  return `$${text}`
}

/** Loss is the stake. A win is the stake plus the winnings, which is the payout. */
export function formatGainLoss(stakeMicros: number, payoutMicros: number): string {
  if (payoutMicros <= 0) return formatMoney(-Math.abs(Math.trunc(stakeMicros)))
  if (payoutMicros > stakeMicros) return formatMoney(payoutMicros, true)
  return formatMoney(0)
}

export function parseAmountMicros(input: string): number | null {
  const text = input.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null
  const [whole, frac = ""] = text.split(".")
  const micros = Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"))
  if (!Number.isSafeInteger(micros) || micros <= 0) return null
  return micros
}

export function quotePair(source: string): string {
  return source === "coinbase" ? "BTC-USD" : "BTC-USDT"
}

export function microsToInput(micros: number): string {
  const whole = Math.floor(Math.max(0, micros) / 1_000_000)
  const frac = String(Math.max(0, micros) % 1_000_000).padStart(6, "0").replace(/0+$/, "")
  return frac ? `${whole}.${frac}` : String(whole)
}

export function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  const text = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })
  if (value > 0) return `+${text}`
  if (value < 0) return `−${text}`
  return text
}

/** Keep the feed's fractional digits. At least two places, and no rounding. */
export function formatPrice(price: string): string {
  const text = price.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return price
  const [whole, frac = ""] = text.split(".")
  const digits = frac.replace(/0+$/, "")
  const decimals = digits.length < 2 ? digits.padEnd(2, "0") : digits
  return `${Number(whole).toLocaleString("en-US")}.${decimals}`
}

export function formatPriceDelta(price: string, baseline: string): { text: string; side: "up" | "down" | "push" } | null {
  const left = decimalParts(price)
  const right = decimalParts(baseline)
  if (!left || !right) return null
  const scale = Math.max(left.frac.length, right.frac.length)
  const diff = BigInt(left.whole + left.frac.padEnd(scale, "0")) - BigInt(right.whole + right.frac.padEnd(scale, "0"))
  if (diff === 0n) return { text: "=", side: "push" }
  const negative = diff < 0n
  const abs = negative ? -diff : diff
  const digits = abs.toString().padStart(scale + 1, "0")
  const cut = Math.max(digits.length - scale, 1)
  const whole = digits.slice(0, cut)
  let frac = scale > 0 ? digits.slice(cut) : ""
  frac = frac.replace(/0+$/, "")
  if (frac.length < 2) frac = frac.padEnd(2, "0")
  const text = `${Number(whole).toLocaleString("en-US")}.${frac}`
  if (negative) return { text: `−${text}`, side: "down" }
  return { text: `+${text}`, side: "up" }
}

function decimalParts(value: string): { whole: string; frac: string } | null {
  const text = value.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const [whole, frac = ""] = text.split(".")
  return { whole, frac }
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function botLabel(address: string): string {
  if (!address.startsWith("0xb07")) return "Bot"
  const index = Number.parseInt(address.slice(5), 16)
  return Number.isFinite(index) ? `Bot ${index + 1}` : "Bot"
}

export function sourceLabel(source: string): string {
  return source === "coinbase" ? "Coinbase BTC-USD" : "Binance BTCUSDT"
}

export function takeMicros(stake: number, side: "up" | "down", up: number, down: number, feeBps: number): number {
  const mine = side === "up" ? up : down
  if (mine <= 0 || stake <= 0) return 0
  const pot = up + down
  const fee = Number((BigInt(pot) * BigInt(feeBps)) / 10_000n)
  const payout = Number((BigInt(stake) * BigInt(pot - fee)) / BigInt(mine))
  return Math.max(0, payout - stake)
}

/** What comes back if `side` wins. A one-sided pool returns the stake, with no fee. */
export function payoutMicros(stake: number, side: "up" | "down", up: number, down: number, feeBps: number): number {
  if (stake <= 0) return 0
  const other = side === "up" ? down : up
  const mine = side === "up" ? up : down
  if (other <= 0 || mine <= 0) return stake
  return stake + takeMicros(stake, side, up, down, feeBps)
}

/** Price of one dollar added to `side`. A refund is stake back, not a win. */
export function quoteDollar(side: "up" | "down", up: number, down: number, feeBps: number): string {
  const stake = 1_000_000
  const nextUp = up + (side === "up" ? stake : 0)
  const nextDown = down + (side === "down" ? stake : 0)
  const other = side === "up" ? nextDown : nextUp
  if (other <= 0) return "$1 back"
  return `$1 = ${formatMoney(payoutMicros(stake, side, nextUp, nextDown, feeBps))}`
}

export function moneyShare(side: number, total: number): string {
  if (total <= 0) return "0%"
  return `${Math.round((side / total) * 100)}%`
}

export function randomAddress(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
