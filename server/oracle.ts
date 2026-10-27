import { compareGap, dollarGap, microPrice, movedAtLeast, withinDollars } from "./blend"
import { priceSource, type PriceSource } from "./config"
import { openFeed, type FeedConn } from "./feedSocket"
import type { Print } from "./rounds"

const PRICE = /^\d+(\.\d+)?$/
const MONEY = /^\d+(\.\d+)?$/

/** A book quote older than this may be replaced by a trade. The switch clock is MOVE_MS. */
export const BREAK_MS = 3_000
/** No price change for this long leaves the active venue. */
export const MOVE_MS = 5_000
export const STANDBY_MS = MOVE_MS
export const RATE_MS = 30_000
export const RECOVERY_MS = 2_000
export const PRINTED_IDLE_MS = 8_000
export const OPEN_ARM_MS = 2_000
export const SWITCH_DOLLARS = 25
export const COALESCE_MS = 100
export const SWITCH_LOG = 5
/** Binance allows 300 connection attempts per 5 minutes per IP. Stay far under that. */
export const BINANCE_ATTEMPT_GAP_MS = 10_000
export const BINANCE_MAX_ATTEMPTS = 12
export const BINANCE_WINDOW_MS = 5 * 60_000
export const BINANCE_FAST_MS = 1_000
export const BINANCE_FAST_FAILS = 3
export const BINANCE_FREEZE_MS = 5 * 60_000
const RETRIES = 4

export const VENUE_ORDER: PriceSource[] = ["binance", "bybit", "okx", "coinbase", "kraken", "bitstamp"]

export type Quote = { price: string; kind: "book" | "trade" }

export type SwingSample = { at: number; dollars: string }

export type Standby = { venue: PriceSource; price: string | null; at: number; swing?: string }

export type SwitchEvent = {
  at: number
  from: PriceSource
  to: PriceSource | null
  reason: string
}

export type RankedStandby = { venue: PriceSource; swing: string }

export type MoveState = { price: string | null; movedAt: number; samples: SwingSample[] }

export type BinanceAttempt = { at: number; diedAt: number | null }

export type BinanceBudget = { ok: boolean; reason: string }

export type OracleView = {
  active: PriceSource | null
  anchor: string | null
  switches?: SwitchEvent[]
  venues: {
    venue: PriceSource
    price: string | null
    at: number
    movedAt?: number
    swing?: string
    feed: string | null
    up: boolean
  }[]
}

let epoch = 0
let latest: OracleView = {
  active: null,
  anchor: null,
  switches: [],
  venues: VENUE_ORDER.map((venue) => ({ venue, price: null, at: 0, movedAt: 0, swing: "0", feed: null, up: false })),
}

export function oracleView(): OracleView {
  return latest
}

/** True once the active price itself has been still for MOVE_MS. A missing clock has not earned a switch. */
export function moveBreak(lastMoveAt: number | null, now: number): boolean {
  if (lastMoveAt == null || lastMoveAt <= 0) return false
  return now - lastMoveAt >= MOVE_MS
}

/** Any numeric difference counts. An equal value spelled two ways does not. */
export function priceChanged(left: string, right: string): boolean {
  const gap = dollarGap(left, right)
  return gap != null && gap !== "0"
}

/** A socket that has printed may sit quiet longer than the switch clock. A silent open still fails fast. */
export function feedIdleMs(printed: boolean): number {
  return printed ? PRINTED_IDLE_MS : OPEN_ARM_MS
}

/** First price starts the clock and adds no dollars. Later changes add the absolute gap. */
export function noteMove(state: MoveState, price: string | null, now: number): MoveState {
  const samples = state.samples.filter((sample) => sample.at <= now && now - sample.at <= RATE_MS)
  if (!price) return { ...state, samples }
  if (!state.price) return { price, movedAt: now, samples }
  if (!priceChanged(state.price, price)) return { price: state.price, movedAt: state.movedAt, samples }
  const dollars = dollarGap(state.price, price)
  if (!dollars) return { price, movedAt: now, samples }
  return { price, movedAt: now, samples: [...samples, { at: now, dollars }] }
}

/** Sum of absolute dollar changes inside the rating window. */
export function swingScore(samples: readonly SwingSample[], now: number): string {
  let total = "0"
  for (const sample of samples) {
    if (sample.at > now || now - sample.at > RATE_MS) continue
    total = addMoney(total, sample.dollars)
  }
  return total
}

export function pushSwitch(log: readonly SwitchEvent[], event: SwitchEvent): SwitchEvent[] {
  return [event, ...log].slice(0, SWITCH_LOG)
}

/** An adopt fills the open drop instead of taking a second slot. */
export function fillSwitch(log: readonly SwitchEvent[], to: PriceSource): SwitchEvent[] {
  const index = log.findIndex((row) => row.to == null)
  if (index < 0) return log.slice()
  return log.map((row, at) => (at === index ? { ...row, to } : row))
}

export function formatSwing(dollars: string): string {
  const amount = Number(dollars)
  if (!Number.isFinite(amount)) return `$${dollars}`
  return `$${amount.toFixed(2)}`
}

export function switchReason(cause: string, ranked: readonly RankedStandby[]): string {
  const top = ranked.slice(0, 2)
  if (top.length === 0) return cause
  return `${cause}; ${top.map((row) => `${row.venue} swing ${formatSwing(row.swing)}`).join(", ")}`
}

/**
 * Refuse a Binance connect when it would add to a ban.
 * Twelve attempts are already in the window, the last one is inside 10s, or three fast deaths froze us.
 */
export function allowBinanceConnect(attempts: readonly BinanceAttempt[], now: number): BinanceBudget {
  const freeze = fastFreezeUntil(attempts)
  if (freeze > now) return { ok: false, reason: "fast failures" }
  const recent = attempts.filter((item) => item.at <= now && now - item.at < BINANCE_WINDOW_MS)
  if (recent.length >= BINANCE_MAX_ATTEMPTS) return { ok: false, reason: `${BINANCE_MAX_ATTEMPTS} attempts in 5m` }
  const last = recent.reduce((max, item) => Math.max(max, item.at), 0)
  if (last > 0 && now - last < BINANCE_ATTEMPT_GAP_MS) {
    const seconds = Math.floor((now - last) / 1000)
    return { ok: false, reason: `last attempt ${seconds}s ago` }
  }
  return { ok: true, reason: "" }
}

/** How long to wait before the next Binance connect is inside the budget. */
export function binanceWaitMs(attempts: readonly BinanceAttempt[], now: number): number {
  if (allowBinanceConnect(attempts, now).ok) return 0
  const recent = attempts.filter((item) => item.at <= now && now - item.at < BINANCE_WINDOW_MS)
  let wait = 0
  const freeze = fastFreezeUntil(attempts)
  if (freeze > now) wait = freeze - now
  if (recent.length >= BINANCE_MAX_ATTEMPTS) {
    const oldest = Math.min(...recent.map((item) => item.at))
    wait = Math.max(wait, oldest + BINANCE_WINDOW_MS - now)
  }
  const last = recent.reduce((max, item) => Math.max(max, item.at), 0)
  if (last > 0 && now - last < BINANCE_ATTEMPT_GAP_MS) wait = Math.max(wait, BINANCE_ATTEMPT_GAP_MS - (now - last))
  return Math.max(wait, 1)
}

export function recoveryAction(input: {
  venue: PriceSource
  messagesSilentMs: number
  budget: BinanceBudget
  alreadyTried: boolean
}): { action: "switch" | "reconnect"; reason: string } {
  const stalled = input.messagesSilentMs >= MOVE_MS
  if (input.venue !== "binance" || !stalled) return { action: "switch", reason: "no price change for 5.0s" }
  if (input.alreadyTried) return { action: "switch", reason: "reconnect produced no move" }
  if (!input.budget.ok) return { action: "switch", reason: `reconnect skipped (${input.budget.reason})` }
  return { action: "reconnect", reason: "" }
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

/**
 * Freshest changing book, weighted by swing.
 * Inside $25 wins over a wider quote. Equal swings prefer the configured venue, then the smaller gap.
 */
export function rankStandbys(
  from: PriceSource,
  anchor: string | null,
  rows: readonly Standby[],
  now: number,
  configured: PriceSource = priceSource(),
): RankedStandby[] {
  const fresh = rows.filter((row) => row.venue !== from && row.price && row.at > 0 && now - row.at <= STANDBY_MS)
  if (fresh.length === 0) return []
  const near = anchor ? fresh.filter((row) => row.price != null && withinDollars(anchor, row.price, SWITCH_DOLLARS)) : fresh
  const pool = near.length > 0 ? near : fresh
  const order = (venue: PriceSource) => VENUE_ORDER.indexOf(venue)
  return [...pool]
    .sort((a, b) => {
      const swing = compareMoney(b.swing ?? "0", a.swing ?? "0")
      if (swing !== 0) return swing
      const prefer = Number(a.venue !== configured) - Number(b.venue !== configured)
      if (prefer !== 0) return prefer
      if (anchor && a.price && b.price) {
        const gap = compareGap(anchor, a.price, b.price)
        if (gap !== 0) return gap
      }
      return order(a.venue) - order(b.venue)
    })
    .map((row) => ({ venue: row.venue, swing: row.swing ?? "0" }))
}

export function pickStandby(
  from: PriceSource,
  anchor: string | null,
  rows: readonly Standby[],
  now: number,
  configured: PriceSource = priceSource(),
): PriceSource | null {
  return rankStandbys(from, anchor, rows, now, configured)[0]?.venue ?? null
}

function fastFreezeUntil(attempts: readonly BinanceAttempt[]): number {
  let streak = 0
  let until = 0
  for (const item of attempts) {
    if (item.diedAt == null) {
      streak = 0
      continue
    }
    const life = item.diedAt - item.at
    if (life >= 0 && life < BINANCE_FAST_MS) {
      streak += 1
      if (streak >= BINANCE_FAST_FAILS) until = item.diedAt + BINANCE_FREEZE_MS
    } else streak = 0
  }
  return until
}

function addMoney(left: string, right: string): string {
  const a = moneyParts(left)
  const b = moneyParts(right)
  if (!a || !b) return "0"
  const scale = Math.max(a.scale, b.scale)
  return formatMoney(scaleMoney(a.n, a.scale, scale) + scaleMoney(b.n, b.scale, scale), scale)
}

function compareMoney(left: string, right: string): number {
  const a = moneyParts(left)
  const b = moneyParts(right)
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  const scale = Math.max(a.scale, b.scale)
  const x = scaleMoney(a.n, a.scale, scale)
  const y = scaleMoney(b.n, b.scale, scale)
  if (x < y) return -1
  if (x > y) return 1
  return 0
}

function moneyParts(value: string): { n: bigint; scale: number } | null {
  if (!MONEY.test(value)) return null
  const [whole, frac = ""] = value.split(".")
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, "")
  return { n: BigInt(digits.length === 0 ? "0" : digits), scale: frac.length }
}

function scaleMoney(n: bigint, from: number, to: number): bigint {
  if (to <= from) return n / 10n ** BigInt(from - to)
  return n * 10n ** BigInt(to - from)
}

function formatMoney(value: bigint, scale: number): string {
  const text = value.toString().padStart(scale + 1, "0")
  if (scale === 0) return text
  const cut = text.length - scale
  const trimmed = `${text.slice(0, cut)}.${text.slice(cut)}`.replace(/0+$/, "").replace(/\.$/, "")
  return trimmed.length === 0 ? "0" : trimmed
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

type Leg = { price: string | null; at: number; bookAt: number; movedAt: number; samples: SwingSample[] }

type ConnectGate = {
  allow: (now: number) => { ok: boolean; waitMs: number }
  recordOpen: (now: number) => void
  recordDeath: (now: number) => void
}

export function startOracle(handlers: OracleHandlers): () => void {
  const mine = ++epoch
  let stopped = false
  let active: PriceSource | null = priceSource()
  let waiting = false
  let brokeFrom: PriceSource | null = null
  let anchor: string | null = null
  let lastEmitted: string | null = null
  let lastEmitAt = 0
  let lastMoveAt = 0
  let recoveryTried = false
  let pendingPrint: Print | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let breakTimer: ReturnType<typeof setTimeout> | null = null
  let switches: SwitchEvent[] = []
  let binanceAttempts: BinanceAttempt[] = []
  const legs = Object.fromEntries(
    VENUE_ORDER.map((venue) => [venue, { price: null, at: 0, bookAt: 0, movedAt: 0, samples: [] }]),
  ) as Record<PriceSource, Leg>
  const sockets = Object.fromEntries(VENUE_ORDER.map((venue) => [venue, { feed: null as string | null, up: false }])) as Record<
    PriceSource,
    { feed: string | null; up: boolean }
  >
  const seen = new Set<string>()

  const trimAttempts = (now: number) => {
    const keep = now - BINANCE_WINDOW_MS - BINANCE_FREEZE_MS
    binanceAttempts = binanceAttempts.filter((item) => item.at >= keep)
  }

  const gate: ConnectGate = {
    allow(now) {
      const budget = allowBinanceConnect(binanceAttempts, now)
      if (budget.ok) return { ok: true, waitMs: 0 }
      return { ok: false, waitMs: binanceWaitMs(binanceAttempts, now) }
    },
    recordOpen(now) {
      binanceAttempts.push({ at: now, diedAt: null })
      trimAttempts(now)
    },
    recordDeath(now) {
      for (let index = binanceAttempts.length - 1; index >= 0; index--) {
        const item = binanceAttempts[index]!
        if (item.diedAt == null) {
          item.diedAt = now
          break
        }
      }
      trimAttempts(now)
    },
  }

  const publish = () => {
    if (mine !== epoch) return
    const now = Date.now()
    latest = {
      active,
      anchor,
      switches,
      venues: VENUE_ORDER.map((venue) => ({
        venue,
        price: legs[venue].price,
        at: legs[venue].at,
        movedAt: legs[venue].movedAt,
        swing: swingScore(legs[venue].samples, now),
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

  const snapshot = (): Standby[] =>
    VENUE_ORDER.map((venue) => ({
      venue,
      price: legs[venue].price,
      at: legs[venue].movedAt,
      swing: swingScore(legs[venue].samples, Date.now()),
    }))

  const armBreak = (fromAt: number) => {
    if (fromAt <= 0) return
    lastMoveAt = fromAt
    if (breakTimer) clearTimeout(breakTimer)
    const wait = Math.max(0, MOVE_MS - (Date.now() - fromAt))
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
    const ranked = rankStandbys(brokeFrom, anchor, snapshot(), now)
    const to = ranked[0]?.venue
    if (!to) return
    waiting = false
    active = to
    clearPending()
    switches = fillSwitch(switches, to)
    console.log(`price feed: ${to}`)
    handlers.onAdopt({ to, at: now })
    armBreak(legs[to].movedAt)
    publish()
  }

  const fireBreak = () => {
    if (stopped || !active) return
    const now = Date.now()
    if (!moveBreak(lastMoveAt, now)) {
      armBreak(lastMoveAt)
      return
    }
    const from = active
    const silent = legs[from].at > 0 ? now - legs[from].at : MOVE_MS
    const decision = recoveryAction({
      venue: from,
      messagesSilentMs: silent,
      budget: allowBinanceConnect(binanceAttempts, now),
      alreadyTried: recoveryTried,
    })
    if (decision.action === "reconnect") {
      recoveryTried = true
      console.log("price feed: binance reconnect")
      reconnectBinance()
      if (breakTimer) clearTimeout(breakTimer)
      breakTimer = setTimeout(fireBreak, RECOVERY_MS)
      publish()
      return
    }
    recoveryTried = false
    const ranked = rankStandbys(from, anchor ?? legs[from].price, snapshot(), now)
    const to = ranked[0]?.venue ?? null
    const reason = switchReason(decision.reason, ranked)
    brokeFrom = from
    active = to
    waiting = to == null
    clearPending()
    switches = pushSwitch(switches, { at: now, from, to, reason })
    console.log(`price feed: ${from} dropped, ${to ?? "waiting"} (${reason})`)
    handlers.onBreak({ from, to, at: now })
    if (to) armBreak(legs[to].movedAt)
    publish()
  }

  const note = (venue: PriceSource, quote: Quote) => {
    if (stopped) return
    const now = Date.now()
    const leg = legs[venue]
    const prevPrice = leg.price
    const prevMoved = leg.movedAt
    leg.at = now
    let nextPrice = prevPrice
    if (quote.kind === "book") {
      leg.bookAt = now
      nextPrice = quote.price
    } else if (now - leg.bookAt > BREAK_MS) {
      nextPrice = quote.price
    }
    const moved = noteMove({ price: prevPrice, movedAt: prevMoved, samples: leg.samples }, nextPrice, now)
    leg.price = moved.price
    leg.movedAt = moved.movedAt
    leg.samples = moved.samples
    if (venue !== active) {
      if (waiting) tryAdopt(now)
      publish()
      return
    }
    if (moved.movedAt !== prevMoved) {
      recoveryTried = false
      armBreak(leg.movedAt)
    }
    handlers.onAlive(now)
    const publishPrint = quote.kind === "book" || now - leg.bookAt > BREAK_MS
    if (publishPrint && leg.price) consider({ price: leg.price, exchangeTs: now, receivedAt: now, source: venue })
    publish()
  }

  let reconnectBinance = () => {}
  const stops = VENUE_ORDER.map((venue) => {
    const walker = startWalker(
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
      venue === "binance" ? gate : null,
    )
    if (venue === "binance") reconnectBinance = walker.reconnect
    return walker.stop
  })

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
  gate: ConnectGate | null,
): { stop: () => void; reconnect: () => void } {
  let stopped = false
  let index = 0
  let retries = 0
  let delay = 200
  let generation = 0
  let socket: FeedConn | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let beat: ReturnType<typeof setInterval> | null = null
  let quiet = false
  let openAt: number | null = null

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const clearRetry = () => {
    if (!retry) return
    clearTimeout(retry)
    retry = null
  }

  const clearBeat = () => {
    if (!beat) return
    clearInterval(beat)
    beat = null
  }

  const schedule = (ms: number) => {
    clearRetry()
    retry = setTimeout(() => {
      retry = null
      connect()
    }, ms)
  }

  const markDeath = () => {
    if (openAt == null) return
    gate?.recordDeath(Date.now())
    openAt = null
  }

  const connect = () => {
    if (stopped) return
    if (gate) {
      const verdict = gate.allow(Date.now())
      if (!verdict.ok) {
        schedule(verdict.waitMs)
        return
      }
      openAt = Date.now()
      gate.recordOpen(openAt)
    }
    const gen = ++generation
    const feed = feeds[index % feeds.length]!
    let printed = false
    let send: (text: string) => void = () => {}

    const giveUp = () => {
      if (stopped || gen !== generation) return
      generation++
      markDeath()
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
        schedule(step.delay)
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
      schedule(wait)
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
        arm(feedIdleMs(printed))
      },
      onMessage: (data) => {
        if (gen !== generation) return
        if (feed.consume?.(data, send)) {
          arm(feedIdleMs(printed))
          return
        }
        const quote = feed.parse(data)
        if (!quote) return
        printed = true
        retries = 0
        delay = 200
        quiet = false
        arm(feedIdleMs(printed))
        onQuote(feed, quote)
      },
      onDown: giveUp,
    })
    arm(feedIdleMs(false))
  }

  const reconnect = () => {
    if (stopped) return
    clearRetry()
    markDeath()
    generation++
    clearTimer()
    clearBeat()
    socket?.close()
    socket = null
    onStatus({ feed: null, up: false })
    connect()
  }

  connect()
  return {
    stop() {
      stopped = true
      generation++
      clearRetry()
      clearTimer()
      clearBeat()
      socket?.close()
      onStatus({ feed: null, up: false })
    },
    reconnect,
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
