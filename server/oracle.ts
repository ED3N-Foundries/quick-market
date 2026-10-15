import { averagePrice, quoteFromLegs, type Leg } from "./blend"
import { priceSource, type PriceSource } from "./config"
import { openFeed, type FeedConn } from "./feedSocket"
import type { Print } from "./rounds"

const PRICE = /^\d+(\.\d+)?$/

type Venue = "binance" | "coinbase"

type Feed = {
  name: string
  url: string
  subscribe?: (send: (text: string) => void) => void
  parse: (data: string) => Print | null
}

/** Fastest public stream first. A dead type moves to the next; the venue stays up if any type prints. */
const BINANCE: Feed[] = [
  { name: "binance vision trades", url: "wss://data-stream.binance.vision/ws/btcusdt@trade", parse: parseBinance },
  { name: "binance stream trades", url: "wss://stream.binance.com:443/ws/btcusdt@trade", parse: parseBinance },
  { name: "binance stream trades 9443", url: "wss://stream.binance.com:9443/ws/btcusdt@trade", parse: parseBinance },
  { name: "binance agg trades", url: "wss://data-stream.binance.vision/ws/btcusdt@aggTrade", parse: parseBinance },
  { name: "binance book", url: "wss://data-stream.binance.vision/ws/btcusdt@bookTicker", parse: parseBinance },
  { name: "binance stream book", url: "wss://stream.binance.com:443/ws/btcusdt@bookTicker", parse: parseBinance },
]

const COINBASE: Feed[] = [
  {
    name: "coinbase ticker",
    url: "wss://advanced-trade-ws.coinbase.com",
    subscribe: subscribeAdvanced("ticker"),
    parse: parseCoinbaseAdvanced,
  },
  {
    name: "coinbase matches",
    url: "wss://ws-feed.exchange.coinbase.com",
    subscribe: subscribeExchange("matches"),
    parse: parseCoinbaseExchange,
  },
  {
    name: "coinbase exchange ticker",
    url: "wss://ws-feed.exchange.coinbase.com",
    subscribe: subscribeExchange("ticker"),
    parse: parseCoinbaseExchange,
  },
  {
    name: "coinbase trades",
    url: "wss://advanced-trade-ws.coinbase.com",
    subscribe: subscribeAdvanced("market_trades"),
    parse: parseCoinbaseAdvanced,
  },
]

export function startOracle(onPrint: (print: Print) => void) {
  const source = priceSource()
  if (source !== "average") return startVenue(source, onPrint)
  const legs: { binance: Leg | null; coinbase: Leg | null } = { binance: null, coinbase: null }
  let mode: PriceSource | null = null
  const emit = (venue: Venue, print: Print) => {
    legs[venue] = { price: print.price, receivedAt: print.receivedAt }
    const now = Date.now()
    const quote = quoteFromLegs(legs.binance, legs.coinbase, now)
    if (!quote) return
    if (quote.source !== mode) {
      mode = quote.source
      console.log(
        quote.source === "average"
          ? "price feed: average, binance and coinbase"
          : `price feed: average, using ${quote.source}`,
      )
    }
    onPrint({ price: quote.price, exchangeTs: now, receivedAt: now, source: quote.source })
  }
  const stopBinance = startVenue("binance", (print) => emit("binance", print))
  const stopCoinbase = startVenue("coinbase", (print) => emit("coinbase", print))
  return () => {
    stopBinance()
    stopCoinbase()
  }
}

function startVenue(venue: Venue, onPrint: (print: Print) => void) {
  const feeds = venue === "binance" ? BINANCE : COINBASE
  let stopped = false
  let index = 0
  let delay = 200
  let generation = 0
  let socket: FeedConn | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let quiet = false
  let shown = ""
  let retrySame = false

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const connect = () => {
    if (stopped) return
    const gen = ++generation
    const feed = feeds[index % feeds.length]
    let printed = false

    const giveUp = () => {
      if (stopped || gen !== generation) return
      generation++
      clearTimer()
      socket?.close()
      socket = null
      if (printed && !retrySame) {
        retrySame = true
        delay = 200
        setTimeout(connect, 200)
        return
      }
      retrySame = false
      const failed = feed
      index++
      const next = feeds[index % feeds.length]
      if (!quiet) console.log(`price feed: ${failed.name} unavailable, trying ${next.name}`)
      const wrapped = index % feeds.length === 0
      const wait = wrapped ? delay : 0
      if (wrapped) {
        quiet = true
        delay = Math.min(delay * 2, 2_000)
      }
      setTimeout(connect, wait)
    }

    const arm = (ms: number) => {
      clearTimer()
      timer = setTimeout(giveUp, ms)
    }

    socket = openFeed(feed.url, {
      onOpen: (send) => {
        if (gen !== generation) return
        feed.subscribe?.(send)
        arm(2_000)
      },
      onMessage: (data) => {
        if (gen !== generation) return
        const print = feed.parse(data)
        if (!print) return
        printed = true
        retrySame = false
        delay = 200
        quiet = false
        if (shown !== feed.name) {
          shown = feed.name
          console.log(`price feed: ${feed.name}`)
        }
        arm(3_000)
        onPrint(print)
      },
      onDown: giveUp,
    })
    arm(3_000)
  }

  connect()
  return () => {
    stopped = true
    generation++
    clearTimer()
    socket?.close()
  }
}

function subscribeAdvanced(channel: "ticker" | "market_trades") {
  return (send: (text: string) => void) => {
    send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channel }))
    send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channel: "heartbeats" }))
  }
}

function subscribeExchange(channel: "matches" | "ticker") {
  return (send: (text: string) => void) => {
    send(
      JSON.stringify({
        type: "subscribe",
        product_ids: ["BTC-USD"],
        channels: [channel, "heartbeat"],
      }),
    )
  }
}

export function parseBinance(data: string): Print | null {
  let message: { e?: string; p?: string; T?: number; s?: string; b?: string; a?: string }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  if (message.s && message.s !== "BTCUSDT") return null
  if ((message.e === "trade" || message.e === "aggTrade") && typeof message.p === "string" && typeof message.T === "number") {
    if (!PRICE.test(message.p)) return null
    return { price: message.p, exchangeTs: message.T, receivedAt: Date.now(), source: "binance" }
  }
  if (typeof message.b !== "string" || typeof message.a !== "string") return null
  if (!PRICE.test(message.b) || !PRICE.test(message.a)) return null
  const price = averagePrice(message.b, message.a)
  if (!price) return null
  return { price, exchangeTs: Date.now(), receivedAt: Date.now(), source: "binance" }
}

export function parseCoinbaseExchange(data: string): Print | null {
  let message: { type?: string; price?: string; product_id?: string; time?: string }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  const trade = message.type === "match" || message.type === "last_match" || message.type === "ticker"
  if (!trade || message.product_id !== "BTC-USD") return null
  if (typeof message.price !== "string" || !PRICE.test(message.price)) return null
  const exchangeTs = message.time ? Date.parse(message.time) : Date.now()
  if (!Number.isFinite(exchangeTs)) return null
  return { price: message.price, exchangeTs, receivedAt: Date.now(), source: "coinbase" }
}

export function parseCoinbaseAdvanced(data: string): Print | null {
  let message: {
    channel?: string
    events?: { tickers?: AdvancedRow[]; trades?: AdvancedRow[] }[]
  }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  const channel = message.channel
  if (channel !== "ticker" && channel !== "market_trades") return null
  if (!Array.isArray(message.events)) return null
  let best: { price: string; exchangeTs: number } | null = null
  for (const event of message.events) {
    const rows = channel === "ticker" ? event.tickers : event.trades
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (row.product_id !== "BTC-USD") continue
      if (typeof row.price !== "string" || !PRICE.test(row.price)) continue
      const exchangeTs = row.time ? Date.parse(row.time) : Date.now()
      if (!Number.isFinite(exchangeTs)) continue
      if (!best || exchangeTs >= best.exchangeTs) best = { price: row.price, exchangeTs }
    }
  }
  if (!best) return null
  return { price: best.price, exchangeTs: best.exchangeTs, receivedAt: Date.now(), source: "coinbase" }
}

type AdvancedRow = { product_id?: string; price?: string; time?: string }
