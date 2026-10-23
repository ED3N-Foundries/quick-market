import type { PriceSource } from "./market"

export type Ticker = { venue: PriceSource; label: string }

export type Handoff = { from: PriceSource; to: PriceSource | null; resumeAt: number | null }

const NAMES: Record<PriceSource, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  coinbase: "Coinbase",
  kraken: "Kraken",
  bitstamp: "Bitstamp",
}

const PAIRS: Record<PriceSource, string> = {
  binance: "BTCUSDT",
  bybit: "BTCUSDT",
  okx: "BTC-USDT",
  coinbase: "BTC-USD",
  kraken: "BTC/USD",
  bitstamp: "BTC/USD",
}

const QUOTES: Record<PriceSource, string> = {
  binance: "BTC-USDT",
  bybit: "BTC-USDT",
  okx: "BTC-USDT",
  coinbase: "BTC-USD",
  kraken: "BTC/USD",
  bitstamp: "BTC/USD",
}

export function sourceName(source: string): string {
  if (source in NAMES) return NAMES[source as PriceSource]
  return "The price feed"
}

export function sourceLabel(source: string): string {
  if (source in NAMES) return `${NAMES[source as PriceSource]} ${PAIRS[source as PriceSource]}`
  return "an unknown feed"
}

export function quotePair(source: string): string {
  if (source in QUOTES) return QUOTES[source as PriceSource]
  return "BTC"
}

export function tickerFor(venue: PriceSource): Ticker {
  return { venue, label: sourceLabel(venue) }
}

/** Shown on the chart and returned when a buy-in is rejected during the hold. */
export function handoffBanner(from: string, to: string | null): string {
  if (!to) return `${sourceName(from)} dropped`
  return `${sourceName(from)} → ${sourceName(to)}`
}
