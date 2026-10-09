export function formatMicros(micros: number): string {
  const negative = micros < 0
  const abs = Math.abs(Math.trunc(micros))
  const whole = Math.floor(abs / 1_000_000)
  let frac = String(abs % 1_000_000).padStart(6, "0").replace(/0+$/, "")
  if (frac.length < 2) frac = frac.padEnd(2, "0")
  const text = `${whole.toLocaleString("en-US")}.${frac}`
  return negative ? `−${text}` : text
}

export function formatCents(micros: number): string {
  return (Math.abs(micros) / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function quotePair(source: string): string {
  return source === "coinbase" ? "BTC-USD" : "BTC-USDT"
}

export function microsToInput(micros: number): string {
  const whole = Math.floor(Math.max(0, micros) / 1_000_000)
  const frac = String(Math.max(0, micros) % 1_000_000).padStart(6, "0").replace(/0+$/, "")
  return frac ? `${whole}.${frac}` : String(whole)
}

export function formatPrice(price: string): string {
  const value = Number(price)
  if (!Number.isFinite(value)) return price
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

export function moneyShare(side: number, total: number): string {
  if (total <= 0) return "0%"
  return `${Math.round((side / total) * 100)}%`
}

export function randomAddress(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
