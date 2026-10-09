export function formatMicros(micros: number): string {
  const negative = micros < 0
  const abs = Math.abs(Math.trunc(micros))
  const whole = Math.floor(abs / 1_000_000)
  let frac = String(abs % 1_000_000).padStart(6, "0").replace(/0+$/, "")
  if (frac.length < 2) frac = frac.padEnd(2, "0")
  const text = `${whole.toLocaleString("en-US")}.${frac}`
  return negative ? `−${text}` : text
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

export function moneyShare(side: number, total: number): string {
  if (total <= 0) return "0%"
  return `${Math.round((side / total) * 100)}%`
}

export function randomAddress(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
