import { expect, test } from "bun:test"
import {
  chainBadgeText,
  chainMenuLabel,
  chainNetworkLabel,
  extractAccountLabel,
  formatDollarMove,
  formatReturn,
  briefGrantLine,
  formatGrantTimer,
  formatGrantWait,
  formatMoney,
  formatPrice,
  sideOffer,
  stakeQuote,
  yourSidePot,
  formatPriceDelta,
  grantButtonLabel,
  grantNextLabel,
  grantSentence,
  grantStatusLabel,
  grantTiming,
  isTestnetChain,
  nextStakeField,
  parseAmountMicros,
  payoutMicros,
  formatClock,
  quoteDollar,
  handoffBanner,
  quotePair,
  sourceLabel,
  walletDisplayLabel,
} from "./format"
import { priceTone } from "./chart"

test("formatMoney rounds half-up to cents for display", () => {
  expect(formatMoney(1_234_567)).toBe("$1.23")
  expect(formatMoney(1_235_000)).toBe("$1.24")
  expect(formatMoney(10_000_000)).toBe("$10.00")
  expect(formatMoney(1_000_000_000)).toBe("$1,000.00")
  expect(formatMoney(-10_004_000)).toBe("-$10.00")
  expect(formatMoney(15_500_000, true)).toBe("+$15.50")
  expect(formatMoney(0)).toBe("$0.00")
})

test("formatReturn shows what came back, and the profit only on a win", () => {
  expect(formatReturn(10_000_000, 0)).toEqual({ back: "$0.00", profit: null, tone: "loss" })
  expect(formatReturn(10_000_000, 18_500_000)).toEqual({ back: "$18.50", profit: "+$8.50", tone: "gain" })
  expect(formatReturn(10_000_000, 10_000_000)).toEqual({ back: "$10.00", profit: null, tone: "flat" })
})

test("source labels follow the configured feed", () => {
  expect(sourceLabel("binance")).toBe("Binance BTCUSDT")
  expect(sourceLabel("bybit")).toBe("Bybit BTCUSDT")
  expect(sourceLabel("okx")).toBe("OKX BTC-USDT")
  expect(sourceLabel("coinbase")).toBe("Coinbase BTC-USD")
  expect(sourceLabel("kraken")).toBe("Kraken BTC/USD")
  expect(sourceLabel("bitstamp")).toBe("Bitstamp BTC/USD")
  expect(sourceLabel("other")).toBe("an unknown feed")
  expect(quotePair("binance")).toBe("BTC-USDT")
  expect(quotePair("coinbase")).toBe("BTC-USD")
  expect(quotePair("kraken")).toBe("BTC/USD")
  expect(quotePair("other")).toBe("BTC")
  expect(handoffBanner("binance", "bybit")).toBe("Binance → Bybit")
  expect(handoffBanner("binance", null)).toBe("Binance dropped")
})

test("formatPrice always shows 4 decimal places", () => {
  expect(formatPrice("85000.9000")).toBe("85,000.9000")
  expect(formatPrice("67234.10")).toBe("67,234.1000")
  expect(formatPrice("100")).toBe("100.0000")
  expect(formatPrice("100.5")).toBe("100.5000")
  expect(formatPrice("100.12345600")).toBe("100.1235")
  expect(formatPrice("100.12344999")).toBe("100.1234")
  expect(formatPrice("99.99996")).toBe("100.0000")
  expect(formatPrice("0.00004")).toBe("0.0000")
  expect(formatPrice("0.00005")).toBe("0.0001")
})

test("formatPriceDelta subtracts without rounding away decimals", () => {
  expect(formatPriceDelta("100.1234", "100.0000")).toEqual({ text: "+0.1234", side: "up" })
  expect(formatPriceDelta("99.9", "100.0")).toEqual({ text: "−0.10", side: "down" })
  expect(formatPriceDelta("100.00", "100.00")).toEqual({ text: "=", side: "push" })
})

test("formatDollarMove puts a dollar sign on the strike change", () => {
  expect(formatDollarMove("100.1234", "100.0000")).toEqual({ text: "+$0.1234", side: "up" })
  expect(formatDollarMove("99.9", "100.0")).toEqual({ text: "−$0.10", side: "down" })
  expect(formatDollarMove("100.00", "100.00")).toEqual({ text: "=$0.00", side: "push" })
})

test("payoutMicros matches a paid pool and refunds a one-sided pool", () => {
  expect(payoutMicros(50_000_000, "up", 50_000_000, 100_000_000, 25)).toBe(149_625_000)
  expect(payoutMicros(10_000_000, "up", 10_000_000, 0, 25)).toBe(10_000_000)
  expect(payoutMicros(10_000_000, "down", 0, 0, 25)).toBe(10_000_000)
})

test("quoteDollar prices one dollar and says when it only comes back", () => {
  expect(quoteDollar("up", 0, 0, 25)).toBe("$1 back")
  expect(quoteDollar("up", 50_000_000, 0, 25)).toBe("$1 back")
  expect(quoteDollar("up", 50_000_000, 100_000_000, 25)).toBe("$1 gets $2.95")
})

test("parseAmountMicros rejects empty and non-positive amounts", () => {
  expect(parseAmountMicros("10")).toBe(10_000_000)
  expect(parseAmountMicros("0")).toBeNull()
  expect(parseAmountMicros("0.00")).toBeNull()
  expect(parseAmountMicros("1.0000001")).toBeNull()
  expect(parseAmountMicros("")).toBeNull()
})

test("priceTone marks a price sitting on the baseline as a push", () => {
  expect(priceTone(100, 100)).toBe("push")
  expect(priceTone(100 + 1e-10, 100)).toBe("push")
  expect(priceTone(100.01, 100)).toBe("up")
  expect(priceTone(99.99, 100)).toBe("down")
})

test("walletDisplayLabel prefers a non-empty account label and falls back to shortAddress", () => {
  const addr = "0x1234567890abcdef1234567890abcdef12345678"
  expect(walletDisplayLabel(addr, "Main Wallet")).toBe("Main Wallet")
  expect(walletDisplayLabel(addr, "  Trading 1  ")).toBe("Trading 1")
  expect(walletDisplayLabel(addr, "")).toBe("0x1234…5678")
  expect(walletDisplayLabel(addr, "   ")).toBe("0x1234…5678")
  expect(walletDisplayLabel(addr, null)).toBe("0x1234…5678")
  expect(walletDisplayLabel(addr, addr)).toBe("0x1234…5678")
})

test("extractAccountLabel finds matching Phantom or standard wallet account labels", () => {
  const addr = "0x1234567890abcdef1234567890abcdef12345678"
  expect(
    extractAccountLabel(addr, {
      addresses: [{ address: addr.toUpperCase(), label: "Account 1" }],
    }),
  ).toBe("Account 1")

  expect(
    extractAccountLabel(addr, {
      addresses: [{ address: addr, name: "Phantom" }],
      accounts: [{ address: addr, label: "Vault" }],
    }),
  ).toBe("Vault")

  expect(
    extractAccountLabel(addr, {
      user: { username: "alice.eth" },
    }),
  ).toBe("alice.eth")

  expect(
    extractAccountLabel(addr, {
      addresses: [{ address: addr }],
    }),
  ).toBeNull()
})

test("chain and testnet label helpers distinguish Base Sepolia testnet from Base mainnet", () => {
  expect(isTestnetChain(84532)).toBe(true)
  expect(isTestnetChain(8453)).toBe(false)
  expect(chainMenuLabel(84532, "Base Sepolia")).toBe("Base Sepolia · Testnet")
  expect(chainMenuLabel(8453, "Base")).toBe("Base")
  expect(chainBadgeText(84532, "Base Sepolia")).toBe("Base Sepolia Testnet")
  expect(chainBadgeText(8453, "Base")).toBe("Base Mainnet")
  expect(chainNetworkLabel(84532, "Base Sepolia")).toBe("Base Sepolia (Testnet)")
  expect(chainNetworkLabel(8453, "Base")).toBe("Base Mainnet")
})

test("grant timing and labels describe an hourly claim", () => {
  const hour = 3_600_000
  const amount = 100_000_000
  expect(grantTiming(null, 5_000, hour)).toEqual({ due: true, waitMs: 0 })
  expect(grantTiming(0, hour - 1, hour)).toEqual({ due: false, waitMs: 1 })
  expect(grantTiming(0, hour, hour)).toEqual({ due: true, waitMs: 0 })
  expect(grantTiming(0, 0, 0)).toEqual({ due: false, waitMs: 0 })
  expect(formatGrantTimer(0)).toBe("0:00")
  expect(formatGrantTimer(1_500)).toBe("0:01")
  expect(formatGrantTimer(65_000)).toBe("1:05")
  expect(formatGrantWait(23 * 60_000)).toBe("23m")
  expect(formatGrantWait(42_000)).toBe("42s")
  expect(formatGrantWait(3_600_000 + 5 * 60_000)).toBe("1h 5m")
  const ready = grantTiming(null, 0, hour)
  expect(grantButtonLabel(ready, amount)).toBe("Grant $100")
  expect(grantStatusLabel(ready, amount)).toBe("Grant ready · $100")
  expect(grantStatusLabel(ready, amount, "en", true)).toBe("Processing grant")
  expect(grantStatusLabel(ready, amount, "zh-TW", true)).toBe("正在處理撥款")
  expect(grantNextLabel(ready)).toBe("Ready")
  const waiting = grantTiming(0, 0, hour)
  expect(grantButtonLabel(waiting, amount)).toBe("Next grant in 1h")
  expect(grantStatusLabel(waiting, amount)).toBe("Next grant in 1h")
  expect(grantNextLabel(waiting)).toBe("1h")
  const soon = grantTiming(0, hour - 23 * 60_000, hour)
  expect(grantButtonLabel(soon, amount)).toBe("Next grant in 23m")
  expect(grantStatusLabel(soon, amount)).toBe("Next grant in 23m")
  expect(grantSentence(amount, hour)).toBe(
    "Quick Market adds $100 QM USDC to this balance once an hour. The wallet is not charged, and Phantom is not involved.",
  )
  expect(grantSentence(amount, 2 * 60_000)).toBe(
    "Quick Market adds $100 QM USDC to this balance once every 2 minutes. The wallet is not charged, and Phantom is not involved.",
  )
  const taiwan = grantSentence(amount, hour, "zh-TW")
  expect(taiwan).toContain("每小時一次")
  expect(taiwan).not.toContain("once an hour")
  expect(isTestnetChain(0, "near-testnet")).toBe(true)
  expect(chainMenuLabel(0, "NEAR Testnet", "en", "near-testnet")).toBe("NEAR Testnet")
  expect(chainBadgeText(0, "NEAR Testnet", "en", "near-testnet")).toBe("NEAR Testnet")
  expect(chainNetworkLabel(0, "NEAR Testnet", "en", "near-testnet")).toBe("NEAR Testnet")
  expect(grantSentence(amount, hour, "en", "near-testnet")).toBe(
    "Quick Market adds $100 QM to this balance once an hour on NEAR Testnet. The wallet is not charged, and no wallet popup is involved.",
  )
  expect(grantSentence(amount, hour, "zh-TW", "near-testnet")).toContain("NEAR 測試網")
})

test("the testnet brief states the live grant cadence", () => {
  const amount = 100_000_000
  expect(briefGrantLine(amount, 2 * 60_000)).toBe("You receive $100 every 2 minutes.")
  expect(briefGrantLine(amount, 60_000)).toBe("You receive $100 every minute.")
  expect(briefGrantLine(amount, 3_600_000)).toBe("You receive $100 every hour.")
  expect(briefGrantLine(amount, 3 * 3_600_000)).toBe("You receive $100 every 3 hours.")
  expect(briefGrantLine(amount, 5_000)).toBe("You receive $100 once every 5s.")
  expect(briefGrantLine(amount, 2 * 60_000, "zh-TW")).toBe("每 2 分鐘撥款 $100。")
  expect(briefGrantLine(amount, 60_000, "zh-TW")).toBe("每分鐘撥款 $100。")
  expect(briefGrantLine(amount, 3_600_000, "zh-TW")).toBe("每小時撥款 $100。")
})

test("formatClock follows the timezone and the locale hour cycle", () => {
  const ms = Date.UTC(2026, 9, 27, 18, 58, 0)
  const utc = formatClock(ms, "en-US", "UTC")
  const chicago = formatClock(ms, "en-US", "America/Chicago")
  expect(utc).toContain("6:58:00")
  expect(chicago).toContain("1:58:00")
  expect(utc).not.toBe(chicago)
  const gb = formatClock(ms, "en-GB", "UTC")
  expect(gb).toBe("18:58:00")
  expect(gb).not.toMatch(/AM|PM/)
})

test("yourSidePot previews a stake and waits for a locked book to catch up", () => {
  expect(yourSidePot(2_000_000, 10_000_000, { kind: "preview" })).toBe(12_000_000)
  expect(yourSidePot(0, 10_000_000, { kind: "preview" })).toBe(10_000_000)
  expect(yourSidePot(2_000_000, 10_000_000, { kind: "locked", baseline: 10_000_000 })).toBe(12_000_000)
  expect(yourSidePot(2_000_000, 12_000_000, { kind: "locked", baseline: 10_000_000 })).toBe(12_000_000)
  expect(yourSidePot(2_000_000, 4_000_000, { kind: "locked", baseline: null })).toBe(4_000_000)
  expect(yourSidePot(2_000_000, 0, { kind: "locked", baseline: null })).toBe(2_000_000)
})

test("stake quotes name this wallet's return in English and zh-TW", () => {
  expect(stakeQuote(10_000_000, "up", 10_000_000, 0, 25)).toBe("$10.00 back")
  expect(stakeQuote(10_000_000, "up", 10_000_000, 0, 25, "zh-TW")).toBe("$10.00 退回")
  const up = 50_000_000
  const down = 100_000_000
  const stake = 1_000_000
  const preview = sideOffer({ side: "up", stake, up, down, feeBps: 25, mode: { kind: "preview" } })
  expect(preview.you).toBe("You · $1.00 · 2%")
  expect(preview.quote).toBe("$1.00 gets $2.95")
  const lagged = sideOffer({
    side: "up",
    stake,
    up,
    down,
    feeBps: 25,
    mode: { kind: "locked", baseline: up },
  })
  expect(lagged).toEqual(preview)
  const caught = sideOffer({
    side: "up",
    stake,
    up: up + stake,
    down,
    feeBps: 25,
    mode: { kind: "locked", baseline: up },
  })
  expect(caught).toEqual(preview)
  const zh = sideOffer({ side: "up", stake, up, down, feeBps: 25, mode: { kind: "preview" }, lang: "zh-TW" })
  expect(zh.you).toBe("你 · $1.00 · 2%")
  expect(zh.quote).toBe("$1.00 可得 $2.95")
})

test("nextStakeField caps a positive balance and leaves zero alone", () => {
  expect(nextStakeField({ field: "10", balanceMicros: null, held: null })).toEqual({ field: "10", held: null })
  expect(nextStakeField({ field: "10", balanceMicros: 0, held: null })).toEqual({ field: "10", held: null })
  expect(nextStakeField({ field: "10", balanceMicros: 5_000_000, held: null })).toEqual({ field: "5", held: "10" })
  expect(nextStakeField({ field: "5", balanceMicros: 5_000_000, held: "10" })).toEqual({ field: "5", held: "10" })
  expect(nextStakeField({ field: "5", balanceMicros: 8_000_000, held: "10" })).toEqual({ field: "8", held: "10" })
  expect(nextStakeField({ field: "5", balanceMicros: 100_000_000, held: "10" })).toEqual({ field: "10", held: null })
  expect(nextStakeField({ field: "10", balanceMicros: 100_000_000, held: null })).toEqual({ field: "10", held: null })
  expect(nextStakeField({ field: "100", balanceMicros: 5_000_000, held: null })).toEqual({ field: "5", held: "100" })
  expect(nextStakeField({ field: "10.", balanceMicros: 5_000_000, held: null })).toEqual({ field: "10.", held: null })
})
