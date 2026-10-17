import { microPrice, movedAtLeast, withinDollars } from "./blend"
import { priceSource, type PriceSource } from "./config"
import { openFeed, type FeedConn } from "./feedSocket"
import type { Print } from "./rounds"

const PRICE = /^\d+(\.\d+)?$/

/** Healthy books gap past 1s (Bybit ~1.9s, OKX ~2.1s, Binance ~1.2s). Three seconds is a dead socket. */
export const BREAK_MS = 3_000
export const STANDBY_MS = 3_000
export const SWITCH_DOLLARS = 25
export const COALESCE_MS = 100
const RETRIES = 4

export const VENUE_ORDER: PriceSource[] = ["binance", "bybit", "okx", "coinbase", "kraken", "bitstamp"]

export type Quote = { price: string; kind: "book" | "trade" }

export type Standby = { venue: PriceSource; price: string | null; at: number }

export type OracleView = {
  active: PriceSource | null
  anchor: string | null
  venues: { venue: PriceSource; price: string | null; at: number; feed: string | null; up: boolean }[]
}

let epoch = 0
let latest: OracleView = {
  active: null,
  anchor: null,
  venues: VENUE_ORDER.map((venue) => ({ venue, price: null, at: 0, feed: null, up: false })),
}

export function oracleView(): OracleView {
  return latest
}

export function silenceBreak(lastAt: number | null, now: number): boolean {
  if (lastAt == null) return false
  return now - lastAt >= BREAK_MS
}

/** A stream that has printed stays on that URL for a few retries. A silent open moves on. */
export function nextFeedStep(input: { printed: boolean; retries: number; index: number }): {
  index: number
  retries: number
  delay: number
} {
  if (input.printed && input.retries < RETRIES) {
    const retries = input.retries + 1
    return { index: input.index, retries, delay: Math.min(200 * 2 ** (retries - 1), 2_000) }
  }
  return { index: input.index + 1, retries: 0, delay: 0 }
}

/** Next warm venue after `from` whose price is fresh and within $25 of the last good print. */
export function pickStandby(
  from: PriceSource,
  anchor: string | null,
  rows: readonly Standby[],
  now: number,
): PriceSource | null {
  if (!anchor) return null
  const start = VENUE_ORDER.indexOf(from)
  if (start < 0) return null
  for (let step = 1; step < VENUE_ORDER.length; step++) {
    const venue = VENUE_ORDER[(start + step) % VENUE_ORDER.length]!
    const row = rows.find((item) => item.venue === venue)
    if (!row?.price) continue
    if (now - row.at > STANDBY_MS) continue
    if (!withinDollars(anchor, row.price, SWITCH_DOLLARS)) continue
    return venue
  }
  return null
}

type Feed = {
  name: string
  url: string
  subscribe?: (send: (text: string) => void) => void
  heartbeatMs?: number
  beat?: (send: (text: string) => void) => void
  consume?: (text: string, send: (text: string) => void) => boolean
  parse: (data: string) => Quote | null
}

const binance = (name: string, url: string): Feed => ({ name, url, parse: parseBinance })

const BINANCE: Feed[] = [
  binance("binance vision book", "wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/btcusdt@trade"),
  binance("binance stream book", "wss://stream.binance.com:443/stream?streams=btcusdt@bookTicker/btcusdt@trade"),
  binance("binance stream book 9443", "wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/btcusdt@trade"),
  binance("binance vision trades", "wss://data-stream.binance.vision/ws/btcusdt@trade"),
]

const BYBIT: Feed[] = [
  {
    name: "bybit book",
    url: "wss://stream.bybit.com/v5/public/spot",
    subscribe: (send) => send(JSON.stringify({ op: "subscribe", args: ["orderbook.1.BTCUSDT"] })),
    heartbeatMs: 20_000,
    beat: (send) => send(JSON.stringify({ op: "ping" })),
    consume: consumeBybit,
    parse: parseBybitBook,
  },
  {
    name: "bybit trades",
    url: "wss://stream.bybit.com/v5/public/spot",
    subscribe: (send) => send(JSON.stringify({ op: "subscribe", args: ["publicTrade.BTCUSDT"] })),
    heartbeatMs: 20_000,
    beat: (send) => send(JSON.stringify({ op: "ping" })),
    consume: consumeBybit,
    parse: parseBybitTrade,
  },
]

const okx = (name: string, channel: string, kind: "book" | "trade"): Feed => ({
  name,
  url: "wss://ws.okx.com/ws/v5/public",
  subscribe: (send) => send(JSON.stringify({ op: "subscribe", args: [{ channel, instId: "BTC-USDT" }] })),
  consume: consumeOkx,
  parse: (data) => parseOkx(data, kind),
})

const OKX: Feed[] = [okx("okx bbo", "bbo-tbt", "book"), okx("okx books", "books5", "book"), okx("okx trades", "trades", "trade")]

const COINBASE: Feed[] = [
  {
    name: "coinbase ticker",
    url: "wss://advanced-trade-ws.coinbase.com",
    subscribe: (send) => {
      send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channel: "ticker" }))
      send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channel: "heartbeats" }))
    },
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
]

const KRAKEN: Feed[] = [
  {
    name: "kraken ticker",
    url: "wss://ws.kraken.com/v2",
    subscribe: (send) =>
      send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD"], event_trigger: "bbo" } })),
    consume: consumeKraken,
    parse: (data) => parseKraken(data, "book"),
  },
  {
    name: "kraken trades",
    url: "wss://ws.kraken.com/v2",
    subscribe: (send) => send(JSON.stringify({ method: "subscribe", params: { channel: "trade", symbol: ["BTC/USD"] } })),
    consume: consumeKraken,
    parse: (data) => parseKraken(data, "trade"),
  },
]

const BITSTAMP: Feed[] = [
  {
    name: "bitstamp book",
    url: "wss://ws.bitstamp.net",
    subscribe: (send) => send(JSON.stringify({ event: "bts:subscribe", data: { channel: "order_book_btcusd" } })),
    consume: consumeBitstamp,
    parse: parseBitstampBook,
  },
  {
    name: "bitstamp trades",
    url: "wss://ws.bitstamp.net",
    subscribe: (send) => send(JSON.stringify({ event: "bts:subscribe", data: { channel: "live_trades_btcusd" } })),
    consume: consumeBitstamp,
    parse: parseBitstampTrade,
  },
]

const FEEDS: Record<PriceSource, Feed[]> = {
  binance: BINANCE,
  bybit: BYBIT,
  okx: OKX,
  coinbase: COINBASE,
  kraken: KRAKEN,
  bitstamp: BITSTAMP,
}

export type OracleHandlers = {
  onPrint: (print: Print) => void
  onAlive: (at: number) => void
  onBreak: (event: { from: PriceSource; to: PriceSource | null; at: number }) => void
  onAdopt: (event: { to: PriceSource; at: number }) => void
}

type Leg = { price: string | null; at: number; bookAt: number }

export function startOracle(handlers: OracleHandlers): () => void {
  const mine = ++epoch
  let stopped = false
  let active: PriceSource | null = priceSource()
  let waiting = false
  let brokeFrom: PriceSource | null = null
  let anchor: string | null = null
  let lastEmitted: string | null = null
  let lastEmitAt = 0
  let lastActiveAt = 0
  let pendingPrint: Print | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let breakTimer: ReturnType<typeof setTimeout> | null = null
  const legs = Object.fromEntries(VENUE_ORDER.map((venue) => [venue, { price: null, at: 0, bookAt: 0 }])) as Record<PriceSource, Leg>
  const sockets = Object.fromEntries(VENUE_ORDER.map((venue) => [venue, { feed: null as string | null, up: false }])) as Record<
    PriceSource,
    { feed: string | null; up: boolean }
  >
  const seen = new Set<string>()

  const publish = () => {
    if (mine !== epoch) return
    latest = {
      active,
      anchor,
      venues: VENUE_ORDER.map((venue) => ({
        venue,
        price: legs[venue].price,
        at: legs[venue].at,
        feed: sockets[venue].feed,
        up: sockets[venue].up,
      })),
    }
  }

  const clearPending = () => {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = null
    pendingPrint = null
    lastEmitted = null
    lastEmitAt = 0
  }

  const snapshot = (): Standby[] => VENUE_ORDER.map((venue) => ({ venue, price: legs[venue].price, at: legs[venue].at }))

  const armBreak = (fromAt: number) => {
    lastActiveAt = fromAt
    if (breakTimer) clearTimeout(breakTimer)
    const wait = Math.max(0, BREAK_MS - (Date.now() - fromAt))
    breakTimer = setTimeout(fireBreak, wait)
  }

  const emit = (print: Print) => {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = null
    pendingPrint = null
    lastEmitted = print.price
    lastEmitAt = Date.now()
    anchor = print.price
    handlers.onPrint(print)
    publish()
  }

  const consider = (print: Print) => {
    if (print.source !== active) return
    if (!lastEmitted) {
      emit(print)
      return
    }
    if (print.price === lastEmitted) return
    const now = Date.now()
    if (movedAtLeast(lastEmitted, print.price, "0.01") || now - lastEmitAt >= COALESCE_MS) {
      emit(print)
      return
    }
    pendingPrint = print
    if (pendingTimer) return
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      const next = pendingPrint
      pendingPrint = null
      if (next && next.source === active) emit(next)
    }, Math.max(0, COALESCE_MS - (now - lastEmitAt)))
  }

  const tryAdopt = (now: number) => {
    if (stopped || !waiting || !brokeFrom) return
    const to = pickStandby(brokeFrom, anchor, snapshot(), now)
    if (!to) return
    waiting = false
    active = to
    clearPending()
    console.log(`price feed: ${to}`)
    handlers.onAdopt({ to, at: now })
    armBreak(now)
    publish()
  }

  const fireBreak = () => {
    if (stopped || !active) return
    const now = Date.now()
    if (!silenceBreak(lastActiveAt, now)) {
      armBreak(lastActiveAt)
      return
    }
    const from = active
    brokeFrom = from
    const to = pickStandby(from, anchor ?? legs[from].price, snapshot(), now)
    active = to
    waiting = to == null
    clearPending()
    console.log(`price feed: ${from} dropped, ${to ?? "waiting"}`)
    handlers.onBreak({ from, to, at: now })
    if (to) armBreak(now)
    publish()
  }

  const note = (venue: PriceSource, quote: Quote) => {
    if (stopped) return
    const now = Date.now()
    const leg = legs[venue]
    leg.at = now
    if (quote.kind === "book") {
      leg.bookAt = now
      leg.price = quote.price
    } else if (now - leg.bookAt > BREAK_MS) {
      leg.price = quote.price
    }
    if (venue !== active) {
      if (waiting) tryAdopt(now)
      publish()
      return
    }
    armBreak(now)
    handlers.onAlive(now)
    const publishPrint = quote.kind === "book" || now - leg.bookAt > BREAK_MS
    if (publishPrint && leg.price) consider({ price: leg.price, exchangeTs: now, receivedAt: now, source: venue })
    publish()
  }

  const stops = VENUE_ORDER.map((venue) =>
    startWalker(
      FEEDS[venue],
      (feed, quote) => {
        if (!seen.has(feed.name)) {
          seen.add(feed.name)
          console.log(`price feed: ${feed.name}`)
        }
        note(venue, quote)
      },
      (status) => {
        sockets[venue] = status
        publish()
      },
    ),
  )

  publish()

  return () => {
    stopped = true
    active = null
    // A late socket from this oracle must not overwrite the view a restart just published.
    if (epoch === mine) epoch += 1
    if (breakTimer) clearTimeout(breakTimer)
    if (pendingTimer) clearTimeout(pendingTimer)
    for (const stop of stops) stop()
  }
}

function startWalker(
  feeds: Feed[],
  onQuote: (feed: Feed, quote: Quote) => void,
  onStatus: (status: { feed: string | null; up: boolean }) => void,
): () => void {
  let stopped = false
  let index = 0
  let retries = 0
  let delay = 200
  let generation = 0
  let socket: FeedConn | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let beat: ReturnType<typeof setInterval> | null = null
  let quiet = false

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const clearBeat = () => {
    if (!beat) return
    clearInterval(beat)
    beat = null
  }

  const connect = () => {
    if (stopped) return
    const gen = ++generation
    const feed = feeds[index % feeds.length]!
    let printed = false
    let send: (text: string) => void = () => {}

    const giveUp = () => {
      if (stopped || gen !== generation) return
      generation++
      clearTimer()
      clearBeat()
      socket?.close()
      socket = null
      onStatus({ feed: null, up: false })
      const step = nextFeedStep({ printed, retries, index })
      const moved = step.index !== index
      index = step.index
      retries = step.retries
      if (!moved) {
        setTimeout(connect, step.delay)
        return
      }
      const next = feeds[index % feeds.length]!
      if (!quiet) console.log(`price feed: ${feed.name} unavailable, trying ${next.name}`)
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
      onOpen: (next) => {
        if (gen !== generation) return
        send = next
        onStatus({ feed: feed.name, up: true })
        feed.subscribe?.(send)
        if (feed.beat && feed.heartbeatMs) beat = setInterval(() => feed.beat?.(send), feed.heartbeatMs)
        arm(2_000)
      },
      onMessage: (data) => {
        if (gen !== generation) return
        if (feed.consume?.(data, send)) {
          arm(3_000)
          return
        }
        const quote = feed.parse(data)
        if (!quote) return
        printed = true
        retries = 0
        delay = 200
        quiet = false
        arm(3_000)
        onQuote(feed, quote)
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
    clearBeat()
    socket?.close()
    onStatus({ feed: null, up: false })
  }
}

function subscribeExchange(channel: "matches" | "ticker") {
  return (send: (text: string) => void) => {
    send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: [channel, "heartbeat"] }))
  }
}

function consumeOkx(text: string, send: (text: string) => void): boolean {
  if (text !== "ping") return false
  send("pong")
  return true
}

function consumeBybit(text: string, send: (text: string) => void): boolean {
  let message: { op?: string; success?: boolean }
  try {
    message = JSON.parse(text)
  } catch {
    return false
  }
  if (message.op === "ping") {
    send(JSON.stringify({ op: "pong" }))
    return true
  }
  return message.op === "pong" || message.success === true
}

function consumeKraken(text: string, send: (text: string) => void): boolean {
  let message: { method?: string; channel?: string }
  try {
    message = JSON.parse(text)
  } catch {
    return false
  }
  if (message.method !== "ping" && message.channel !== "heartbeat") return false
  send(JSON.stringify({ method: "pong" }))
  return true
}

function consumeBitstamp(text: string): boolean {
  let message: { event?: string }
  try {
    message = JSON.parse(text)
  } catch {
    return false
  }
  return message.event === "bts:subscription_succeeded"
}

export function parseBinance(data: string): Quote | null {
  let message: { stream?: string; data?: Record<string, unknown>; e?: string; p?: string; s?: string; b?: string; a?: string; B?: string; A?: string }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  if (message.data && typeof message.data === "object") message = { ...message, ...message.data }
  if (message.s && message.s !== "BTCUSDT") return null
  if (typeof message.b === "string" && typeof message.a === "string") {
    const price = microPrice(message.b, message.a, message.B, message.A)
    return price ? { price, kind: "book" } : null
  }
  if ((message.e === "trade" || message.e === "aggTrade") && typeof message.p === "string" && PRICE.test(message.p)) {
    return { price: message.p, kind: "trade" }
  }
  return null
}

export function parseBybitBook(data: string): Quote | null {
  let message: { topic?: string; data?: { s?: string; b?: [string, string][]; a?: [string, string][] } }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  if (message.topic !== "orderbook.1.BTCUSDT") return null
  const bid = message.data?.b?.[0]
  const ask = message.data?.a?.[0]
  if (!bid || !ask) return null
  const price = microPrice(bid[0], ask[0], bid[1], ask[1])
  return price ? { price, kind: "book" } : null
}

export function parseBybitTrade(data: string): Quote | null {
  let message: { topic?: string; data?: { s?: string; p?: string }[] }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  if (message.topic !== "publicTrade.BTCUSDT" || !Array.isArray(message.data)) return null
  const row = message.data[message.data.length - 1]
  if (!row || row.s !== "BTCUSDT" || !row.p || !PRICE.test(row.p)) return null
  return { price: row.p, kind: "trade" }
}

export function parseOkx(data: string, kind: "book" | "trade"): Quote | null {
  let message: { data?: Record<string, unknown>[] }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  const row = message.data?.[message.data.length - 1]
  if (!row) return null
  if (kind === "trade") {
    const price = asPrice(row.px)
    return price ? { price, kind: "trade" } : null
  }
  const bids = row.bids as [string, string][] | undefined
  const asks = row.asks as [string, string][] | undefined
  const bid = bids?.[0]
  const ask = asks?.[0]
  if (!bid || !ask) return null
  const price = microPrice(bid[0], ask[0], bid[1], ask[1])
  return price ? { price, kind: "book" } : null
}

export function parseCoinbaseExchange(data: string): Quote | null {
  let message: { type?: string; price?: string; product_id?: string }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  const trade = message.type === "match" || message.type === "last_match" || message.type === "ticker"
  if (!trade || message.product_id !== "BTC-USD") return null
  if (typeof message.price !== "string" || !PRICE.test(message.price)) return null
  return { price: message.price, kind: "trade" }
}

export function parseCoinbaseAdvanced(data: string): Quote | null {
  let message: { channel?: string; events?: { tickers?: AdvancedRow[] }[] }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  if (message.channel !== "ticker" || !Array.isArray(message.events)) return null
  let best: { quote: Quote; at: number } | null = null
  for (const event of message.events) {
    if (!Array.isArray(event.tickers)) continue
    for (const row of event.tickers) {
      if (row.product_id !== "BTC-USD") continue
      const quote = coinbaseRow(row)
      if (!quote) continue
      const at = row.time ? Date.parse(row.time) : 0
      if (!best || at >= best.at) best = { quote, at }
    }
  }
  return best?.quote ?? null
}

function coinbaseRow(row: AdvancedRow): Quote | null {
  const bid = asPrice(row.best_bid)
  const ask = asPrice(row.best_ask)
  if (bid && ask) {
    const price = microPrice(bid, ask, asPrice(row.best_bid_quantity), asPrice(row.best_ask_quantity))
    if (price) return { price, kind: "book" }
  }
  const price = asPrice(row.price)
  return price ? { price, kind: "trade" } : null
}

type AdvancedRow = {
  product_id?: string
  price?: string
  time?: string
  best_bid?: string
  best_ask?: string
  best_bid_quantity?: string
  best_ask_quantity?: string
}

export function parseKraken(data: string, kind: "book" | "trade"): Quote | null {
  let message: { channel?: string; data?: Record<string, unknown>[] }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  if (message.channel !== (kind === "book" ? "ticker" : "trade") || !Array.isArray(message.data)) return null
  const row = message.data[message.data.length - 1]
  if (!row) return null
  if (kind === "trade") {
    const price = asPrice(row.price)
    return price ? { price, kind: "trade" } : null
  }
  const bid = asPrice(row.bid)
  const ask = asPrice(row.ask)
  if (!bid || !ask) return null
  const price = microPrice(bid, ask, asPrice(row.bid_qty), asPrice(row.ask_qty))
  return price ? { price, kind: "book" } : null
}

export function parseBitstampBook(data: string): Quote | null {
  let message: { event?: string; channel?: string; data?: { bids?: [string, string][]; asks?: [string, string][] } }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  if (message.channel !== "order_book_btcusd" || message.event !== "data") return null
  const bid = message.data?.bids?.[0]
  const ask = message.data?.asks?.[0]
  if (!bid || !ask) return null
  const price = microPrice(bid[0], ask[0], bid[1], ask[1])
  return price ? { price, kind: "book" } : null
}

export function parseBitstampTrade(data: string): Quote | null {
  let message: { event?: string; channel?: string; data?: { price_str?: string; price?: number } }
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  if (message.channel !== "live_trades_btcusd" || message.event !== "trade") return null
  const price = asPrice(message.data?.price_str ?? message.data?.price)
  return price ? { price, kind: "trade" } : null
}

function asPrice(value: unknown): string | null {
  if (typeof value === "string" && PRICE.test(value)) return value
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const text = value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")
    return PRICE.test(text) ? text : null
  }
  return null
}
