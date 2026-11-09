import type { Lang } from "../../shared/lang"
import { copy } from "./copy"

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

export type ReturnFigures = {
  back: string
  profit: string | null
  tone: "gain" | "loss" | "flat"
}

/** What came back. The profit is set only when the payout is larger than the stake. A wipe is $0.00. */
export function formatReturn(stakeMicros: number, payoutMicros: number): ReturnFigures {
  if (payoutMicros <= 0) return { back: formatMoney(0), profit: null, tone: "loss" }
  if (payoutMicros > stakeMicros) {
    return { back: formatMoney(payoutMicros), profit: formatMoney(payoutMicros - stakeMicros, true), tone: "gain" }
  }
  return { back: formatMoney(payoutMicros), profit: null, tone: "flat" }
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

const PRICE_PLACES = 4

/** Four decimal places, so 85,000.9000 stays as wide as 85,000.9012. Half-up, no float. */
export function formatPrice(price: string): string {
  const text = price.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return price
  const [wholeRaw, frac = ""] = text.split(".")
  const whole = wholeRaw.replace(/^0+(?=\d)/, "")
  const padded = frac.padEnd(PRICE_PLACES, "0")
  let digits = `${whole}${padded.slice(0, PRICE_PLACES)}`.replace(/^0+(?=\d)/, "") || "0"
  if (padded.length > PRICE_PLACES && padded.charAt(PRICE_PLACES) >= "5") digits = (BigInt(digits) + 1n).toString()
  const raw = digits.padStart(PRICE_PLACES + 1, "0")
  const cut = raw.length - PRICE_PLACES
  return `${Number(raw.slice(0, cut)).toLocaleString("en-US")}.${raw.slice(cut)}`
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

/** Elapsed time in the grant window, as m:ss. */
export function formatGrantTimer(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function formatGrantWait(waitMs: number, lang: Lang = "en"): string {
  const text = copy(lang)
  const totalSeconds = Math.max(1, Math.ceil(Math.max(0, waitMs) / 1000))
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    return minutes ? text.waitHoursMinutes(hours, minutes) : text.waitHours(hours)
  }
  if (totalSeconds >= 60) return text.waitMinutes(Math.ceil(totalSeconds / 60))
  return text.waitSeconds(totalSeconds)
}

export function grantPace(intervalMs: number, lang: Lang = "en"): string {
  const text = copy(lang)
  if (intervalMs === 3_600_000) return text.paceHour
  if (intervalMs > 0 && intervalMs % 3_600_000 === 0) return text.paceHours(intervalMs / 3_600_000)
  if (intervalMs > 0 && intervalMs % 60_000 === 0) {
    const minutes = intervalMs / 60_000
    return minutes === 1 ? text.paceMinute : text.paceMinutes(minutes)
  }
  const seconds = Math.max(1, Math.round(intervalMs / 1000))
  return text.paceSeconds(seconds)
}

export function grantButtonLabel(timing: GrantTiming, amountMicros: number, lang: Lang = "en"): string {
  const text = copy(lang)
  if (timing.due) return text.grantButton(formatGrantDollars(amountMicros))
  return text.nextGrant(formatGrantWait(timing.waitMs, lang))
}

export function grantStatusLabel(timing: GrantTiming, amountMicros: number, lang: Lang = "en"): string {
  const text = copy(lang)
  if (timing.due) return text.grantReadyAmount(formatGrantDollars(amountMicros))
  return text.nextGrant(formatGrantWait(timing.waitMs, lang))
}

export function grantNextLabel(timing: GrantTiming, lang: Lang = "en"): string {
  return timing.due ? copy(lang).ready : formatGrantWait(timing.waitMs, lang)
}

export function grantSentence(amountMicros: number, intervalMs: number, lang: Lang = "en"): string {
  return copy(lang).grantSentence(formatGrantDollars(amountMicros), grantPace(intervalMs, lang))
}

/** Short pace for the testnet brief. Other intervals keep the grantPace wording. */
export function briefPace(intervalMs: number, lang: Lang = "en"): string {
  const text = copy(lang)
  if (intervalMs === 3_600_000) return text.briefHour
  if (intervalMs > 0 && intervalMs % 3_600_000 === 0) return text.briefHours(intervalMs / 3_600_000)
  if (intervalMs > 0 && intervalMs % 60_000 === 0) {
    const minutes = intervalMs / 60_000
    return minutes === 1 ? text.briefMinute : text.briefMinutes(minutes)
  }
  return grantPace(intervalMs, lang)
}

export function briefGrantLine(amountMicros: number, intervalMs: number, lang: Lang = "en"): string {
  return copy(lang).briefGrant(formatGrantDollars(amountMicros), briefPace(intervalMs, lang))
}

export function chainMenuLabel(chainId: number, chainName = "Base", lang: Lang = "en"): string {
  if (isTestnetChain(chainId)) return copy(lang).chainTestnetMenu
  return chainName || "Base"
}

export function chainBadgeText(chainId: number, chainName = "Base", lang: Lang = "en"): string {
  const text = copy(lang)
  if (isTestnetChain(chainId)) return text.chainTestnetBadge
  if (chainId === 8453) return text.chainMainnet
  return chainName || "Base"
}

export function chainNetworkLabel(chainId: number, chainName = "Base", lang: Lang = "en"): string {
  const text = copy(lang)
  if (isTestnetChain(chainId)) return text.chainTestnetNetwork
  if (chainId === 8453) return text.chainMainnet
  return chainName || "Base"
}

/** Local timezone unless `timeZone` is passed. `locale` selects the hour cycle. */
export function formatClock(ms: number, locale?: string, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    ...(timeZone ? { timeZone } : {}),
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

/** What one dollar added to `side` gets. A refund is stake back, not a priced quote. */
export function quoteDollar(side: "up" | "down", up: number, down: number, feeBps: number, lang: Lang = "en"): string {
  const text = copy(lang)
  const stake = 1_000_000
  const nextUp = up + (side === "up" ? stake : 0)
  const nextDown = down + (side === "down" ? stake : 0)
  const other = side === "up" ? nextDown : nextUp
  if (other <= 0) return text.quoteBack
  return text.quoteGets(formatMoney(payoutMicros(stake, side, nextUp, nextDown, feeBps)))
}

export function moneyShare(side: number, total: number): string {
  if (total <= 0) return "0%"
  return `${Math.round((side / total) * 100)}%`
}

