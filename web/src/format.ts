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

export { handoffBanner, quotePair, sourceLabel, sourceName } from "../../shared/source"

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

/** Dollar move from a strike. Push is `=$0.00`. */
export function formatDollarMove(price: string, baseline: string): { text: string; side: "up" | "down" | "push" } | null {
  const delta = formatPriceDelta(price, baseline)
  if (!delta) return null
  if (delta.side === "push") return { text: "=$0.00", side: "push" }
  return { text: `${delta.text[0]}$${delta.text.slice(1)}`, side: delta.side }
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

export function walletDisplayLabel(address: string, label?: string | null): string {
  const clean = label?.trim()
  if (clean && clean.toLowerCase() !== address.toLowerCase()) return clean
  return shortAddress(address)
}

type AccountCandidate = {
  address?: unknown
  label?: unknown
  name?: unknown
  accountLabel?: unknown
}

const GENERIC_WALLET_NAMES = new Set(["phantom", "ethereum", "injected", "evm", "metamask", "coinbase wallet"])

function cleanCandidateLabel(value: unknown, address: string): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.toLowerCase() === address.toLowerCase()) return null
  if (GENERIC_WALLET_NAMES.has(trimmed.toLowerCase())) return null
  return trimmed
}

function labelFromList(list: unknown, address: string): string | null {
  if (!Array.isArray(list)) return null
  const lower = address.toLowerCase()
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const record = item as AccountCandidate
    if (typeof record.address === "string" && record.address.toLowerCase() === lower) {
      const found =
        cleanCandidateLabel(record.label, address) ??
        cleanCandidateLabel(record.accountLabel, address) ??
        cleanCandidateLabel(record.name, address)
      if (found) return found
    }
  }
  return null
}

export function extractAccountLabel(
  address: string | null | undefined,
  sources?: {
    addresses?: unknown
    user?: unknown
    phantom?: unknown
    accounts?: unknown
  },
): string | null {
  if (!address) return null
  const fromAddresses = labelFromList(sources?.addresses, address)
  if (fromAddresses) return fromAddresses

  const fromAccounts = labelFromList(sources?.accounts, address)
  if (fromAccounts) return fromAccounts

  if (sources?.user && typeof sources.user === "object") {
    const user = sources.user as Record<string, unknown>
    const fromUserList = labelFromList(user.addresses, address) ?? labelFromList(user.accounts, address)
    if (fromUserList) return fromUserList
    const direct =
      cleanCandidateLabel(user.label, address) ??
      cleanCandidateLabel(user.accountLabel, address) ??
      cleanCandidateLabel(user.username, address) ??
      cleanCandidateLabel(user.name, address)
    if (direct) return direct
  }

  if (sources?.phantom && typeof sources.phantom === "object") {
    const phantom = sources.phantom as Record<string, unknown>
    const eth = phantom.ethereum && typeof phantom.ethereum === "object" ? (phantom.ethereum as Record<string, unknown>) : null
    if (eth) {
      const fromEth =
        labelFromList(eth.accounts, address) ??
        (eth.selectedAccount ? labelFromList([eth.selectedAccount], address) : null) ??
        cleanCandidateLabel(eth.label, address)
      if (fromEth) return fromEth
    }
  }

  return null
}

export function isTestnetChain(chainId: number): boolean {
  return chainId === 84532
}

export type GrantTiming = { due: boolean; waitMs: number }

/** Whether the testnet grant can be claimed, and how long remains when it cannot. */
export function grantTiming(grantAt: number | null, now: number, intervalMs: number): GrantTiming {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) return { due: false, waitMs: 0 }
  if (grantAt === null || !Number.isSafeInteger(grantAt)) return { due: true, waitMs: 0 }
  const waitMs = grantAt + intervalMs - now
  if (waitMs <= 0) return { due: true, waitMs: 0 }
  return { due: false, waitMs }
}

/** Whole dollars when the amount is a whole token, otherwise the cent display. */
export function formatGrantDollars(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros <= 0) return formatMoney(0)
  if (micros % 1_000_000 === 0) return `$${(micros / 1_000_000).toLocaleString("en-US")}`
  return formatMoney(micros)
}

export function formatGrantWait(waitMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(Math.max(0, waitMs) / 1000))
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`
  }
  if (totalSeconds >= 60) return `${Math.ceil(totalSeconds / 60)}m`
  return `${totalSeconds}s`
}

export function grantPace(intervalMs: number): string {
  if (intervalMs === 3_600_000) return "once an hour"
  if (intervalMs > 0 && intervalMs % 3_600_000 === 0) {
    const hours = intervalMs / 3_600_000
    return `once every ${hours} hours`
  }
  if (intervalMs > 0 && intervalMs % 60_000 === 0) {
    const minutes = intervalMs / 60_000
    return minutes === 1 ? "once a minute" : `once every ${minutes} minutes`
  }
  const seconds = Math.max(1, Math.round(intervalMs / 1000))
  return `once every ${seconds}s`
}

export function grantButtonLabel(timing: GrantTiming, amountMicros: number): string {
  if (timing.due) return `Grant ${formatGrantDollars(amountMicros)}`
  return `Next grant in ${formatGrantWait(timing.waitMs)}`
}

export function grantStatusLabel(timing: GrantTiming, amountMicros: number): string {
  if (timing.due) return `Grant ready · ${formatGrantDollars(amountMicros)}`
  return `Next grant in ${formatGrantWait(timing.waitMs)}`
}

export function grantNextLabel(timing: GrantTiming): string {
  return timing.due ? "Ready" : formatGrantWait(timing.waitMs)
}

export function grantSentence(amountMicros: number, intervalMs: number): string {
  return `Quick Market adds ${formatGrantDollars(amountMicros)} QM USDC to this balance ${grantPace(intervalMs)}. The wallet is not charged, and Phantom is not involved.`
}

export function chainMenuLabel(chainId: number, chainName = "Base"): string {
  if (isTestnetChain(chainId)) return "Base Sepolia · Testnet"
  return chainName || "Base"
}

export function chainBadgeText(chainId: number, chainName = "Base"): string {
  if (isTestnetChain(chainId)) return "Base Sepolia Testnet"
  if (chainId === 8453) return "Base Mainnet"
  return chainName || "Base"
}

export function chainNetworkLabel(chainId: number, chainName = "Base"): string {
  if (isTestnetChain(chainId)) return "Base Sepolia (Testnet)"
  if (chainId === 8453) return "Base Mainnet"
  return chainName || "Base"
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
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

/** What one dollar added to `side` can win. A refund is stake back, not a win. */
export function quoteDollar(side: "up" | "down", up: number, down: number, feeBps: number): string {
  const stake = 1_000_000
  const nextUp = up + (side === "up" ? stake : 0)
  const nextDown = down + (side === "down" ? stake : 0)
  const other = side === "up" ? nextDown : nextUp
  if (other <= 0) return "$1 back"
  return `$1 wins ${formatMoney(payoutMicros(stake, side, nextUp, nextDown, feeBps))}`
}

export function moneyShare(side: number, total: number): string {
  if (total <= 0) return "0%"
  return `${Math.round((side / total) * 100)}%`
}

