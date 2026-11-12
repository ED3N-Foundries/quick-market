import { expect, test } from "bun:test"
import {
  nextFeedStep,
  parseBinance,
  parseBitstampBook,
  parseBybitBook,
  parseCoinbaseAdvanced,
  parseCoinbaseExchange,
  parseKraken,
  parseOkx,
  allowBinanceConnect,
  binanceWaitMs,
  BINANCE_FREEZE_MS,
  BINANCE_MAX_ATTEMPTS,
  feedIdleMs,
  fillSwitch,
  formatSwing,
  MOVE_MS,
  moveBreak,
  switchClockAt,
  noteMove,
  OPEN_ARM_MS,
  pickStandby,
  priceChanged,
  PRINTED_IDLE_MS,
  pushSwitch,
  RATE_MS,
  recoveryAction,
  STANDBY_MS,
  swingScore,
  switchReason,
  type SwitchEvent,
} from "./oracle"

test("parseBinance unwraps a combined book frame and weights the size", () => {
  const wrapped = parseBinance(
    JSON.stringify({
      stream: "btcusdt@bookTicker",
      data: { s: "BTCUSDT", b: "100.00", B: "1", a: "102.00", A: "3" },
    }),
  )
  expect(wrapped).toEqual({ price: "100.5000", kind: "book" })
  const trade = parseBinance(JSON.stringify({ e: "trade", p: "83378.01000000", T: 1_700_000_000_000 }))
  expect(trade).toEqual({ price: "83378.01000000", kind: "trade" })
  expect(parseBinance(JSON.stringify({ e: "aggTrade", p: "83378.02", T: 5 }))?.price).toBe("83378.02")
  expect(parseBinance(JSON.stringify({ s: "BTCUSDT", b: "100.00", a: "102.00" }))?.price).toBe("101.00")
  expect(parseBinance(JSON.stringify({ s: "ETHUSDT", b: "100", a: "102" }))).toBeNull()
})

test("a quantity-only book update moves the microprice", () => {
  const first = parseBinance(JSON.stringify({ s: "BTCUSDT", b: "100", B: "1", a: "102", A: "1" }))
  const next = parseBinance(JSON.stringify({ s: "BTCUSDT", b: "100", B: "3", a: "102", A: "1" }))
  expect(first?.price).toBe("101.0000")
  expect(next?.price).toBe("101.5000")
  expect(first?.price).not.toBe(next?.price)
})

test("parseBybit and parseOkx read the top of book", () => {
  expect(
    parseBybitBook(
      JSON.stringify({ topic: "orderbook.1.BTCUSDT", data: { b: [["100", "1"]], a: [["102", "1"]] } }),
    )?.price,
  ).toBe("101.0000")
  expect(parseOkx(JSON.stringify({ data: [{ bids: [["100", "1"]], asks: [["102", "3"]] }] }), "book")?.price).toBe("100.5000")
  expect(parseOkx(JSON.stringify({ data: [{ px: "50.5" }] }), "trade")?.price).toBe("50.5")
})

test("parseCoinbaseExchange accepts a match and ignores other messages", () => {
  const print = parseCoinbaseExchange(
    JSON.stringify({ type: "match", product_id: "BTC-USD", price: "83362.59", time: "2026-10-13T00:00:00.000Z" }),
  )
  expect(print).toEqual({ price: "83362.59", kind: "trade" })
  const ticker = parseCoinbaseExchange(
    JSON.stringify({ type: "ticker", product_id: "BTC-USD", price: "83300", time: "2026-10-13T00:00:00.000Z" }),
  )
  expect(ticker?.price).toBe("83300")
  expect(parseCoinbaseExchange(JSON.stringify({ type: "heartbeat" }))).toBeNull()
  expect(parseCoinbaseExchange(JSON.stringify({ type: "last_match", product_id: "ETH-USD", price: "1" }))).toBeNull()
})

test("parseCoinbaseAdvanced prefers the touch and falls back to the last price", () => {
  const print = parseCoinbaseAdvanced(
    JSON.stringify({
      channel: "ticker",
      events: [
        {
          tickers: [
            { product_id: "BTC-USD", price: "100", best_bid: "100", best_ask: "102", best_bid_quantity: "1", best_ask_quantity: "1", time: "2026-10-13T00:00:00.000Z" },
            { product_id: "ETH-USD", price: "9", time: "2026-10-13T00:00:02.000Z" },
          ],
        },
      ],
    }),
  )
  expect(print).toEqual({ price: "101.0000", kind: "book" })
  const trade = parseCoinbaseAdvanced(
    JSON.stringify({
      channel: "ticker",
      events: [{ tickers: [{ product_id: "BTC-USD", price: "50.5", time: "2026-10-13T00:00:00.000Z" }] }],
    }),
  )
  expect(trade).toEqual({ price: "50.5", kind: "trade" })
  expect(parseCoinbaseAdvanced(JSON.stringify({ channel: "heartbeats" }))).toBeNull()
})

test("parseKraken and parseBitstamp keep decimal strings", () => {
  expect(parseKraken(JSON.stringify({ channel: "ticker", data: [{ bid: 100.1, ask: 100.3, bid_qty: 1, ask_qty: 1 }] }), "book")?.price).toBe(
    "100.2000",
  )
  expect(
    parseBitstampBook(
      JSON.stringify({ event: "data", channel: "order_book_btcusd", data: { bids: [["100", "1"]], asks: [["102", "1"]] } }),
    )?.price,
  ).toBe("101.0000")
})

test("a price that changed inside five seconds keeps the market", () => {
  expect(moveBreak(null, 5_000)).toBe(false)
  expect(moveBreak(0, 5_000)).toBe(false)
  expect(moveBreak(1_000, 1_000 + MOVE_MS - 1)).toBe(false)
  expect(moveBreak(1_000, 1_000 + MOVE_MS)).toBe(true)
})

test("a primary that has never printed still arms the switch clock from boot", () => {
  const boot = 10_000
  expect(switchClockAt(0, boot)).toBe(boot)
  expect(moveBreak(switchClockAt(0, boot), boot + MOVE_MS - 1)).toBe(false)
  expect(moveBreak(switchClockAt(0, boot), boot + MOVE_MS)).toBe(true)
  expect(switchClockAt(boot + 500, boot)).toBe(boot + 500)
})

test("any price change counts, and an identical number does not", () => {
  expect(priceChanged("100", "100.0001")).toBe(true)
  expect(priceChanged("100", "100.0")).toBe(false)
  expect(priceChanged("100.00", "100.00")).toBe(false)
  const first = noteMove({ price: null, movedAt: 0, samples: [] }, "100", 1_000)
  expect(first).toEqual({ price: "100", movedAt: 1_000, samples: [] })
  expect(noteMove(first, "100.000", 2_000).movedAt).toBe(1_000)
  const tick = noteMove(first, "100.0001", 2_000)
  expect(tick.movedAt).toBe(2_000)
  expect(tick.samples).toEqual([{ at: 2_000, dollars: "0.0001" }])
})

test("swing is the sum of absolute changes, so a wild book outranks a busy one", () => {
  const now = 50_000
  const tiny = Array.from({ length: 40 }, (_, index) => ({ at: now - index, dollars: "0.10" }))
  const wild = [
    { at: now, dollars: "10" },
    { at: now - 1, dollars: "10" },
  ]
  expect(swingScore(tiny, now)).toBe("4")
  expect(swingScore(wild, now)).toBe("20")
  expect(swingScore([{ at: now - RATE_MS - 1, dollars: "10" }, { at: now, dollars: "1" }], now)).toBe("1")
  expect(formatSwing("18.2")).toBe("$18.20")
  expect(feedIdleMs(true)).toBe(PRINTED_IDLE_MS)
  expect(feedIdleMs(false)).toBe(OPEN_ARM_MS)
})

test("a stream that has printed retries the same URL before walking on", () => {
  expect(nextFeedStep({ printed: true, retries: 0, index: 2 })).toEqual({ index: 2, retries: 1, delay: 200 })
  expect(nextFeedStep({ printed: true, retries: 3, index: 2 })).toEqual({ index: 2, retries: 4, delay: 1_600 })
  expect(nextFeedStep({ printed: true, retries: 4, index: 2 })).toEqual({ index: 3, retries: 0, delay: 0 })
  expect(nextFeedStep({ printed: false, retries: 0, index: 2 })).toEqual({ index: 3, retries: 0, delay: 0 })
})

test("equal swings fall back to the closest quote, and a far quote can still take over", () => {
  const now = 10_000
  const rows = [
    { venue: "bybit" as const, price: "81600", at: now },
    { venue: "kraken" as const, price: "81400", at: now },
    { venue: "okx" as const, price: "81590", at: now - STANDBY_MS - 1 },
  ]
  expect(pickStandby("binance", "81620", rows, now)).toBe("bybit")
  expect(pickStandby("binance", "81620", [{ venue: "kraken", price: "81400", at: now }], now)).toBe("kraken")
  expect(pickStandby("bitstamp", "100", [{ venue: "binance", price: "101", at: now }], now)).toBe("binance")
  expect(
    pickStandby(
      "binance",
      "81620",
      [
        { venue: "bybit", price: "80000", at: now },
        { venue: "kraken", price: "81600", at: now },
      ],
      now,
    ),
  ).toBe("kraken")
  expect(
    pickStandby(
      "binance",
      "100",
      [
        { venue: "kraken", price: "100", at: now },
        { venue: "bybit", price: "100", at: now },
      ],
      now,
    ),
  ).toBe("bybit")
  expect(
    pickStandby(
      "binance",
      null,
      [
        { venue: "kraken", price: "100", at: now },
        { venue: "bybit", price: "90", at: now },
      ],
      now,
    ),
  ).toBe("bybit")
  expect(pickStandby("binance", "100", [{ venue: "binance", price: "100", at: now }], now)).toBeNull()
})

test("a larger swing wins inside $25, and a quiet book is never chosen", () => {
  const now = 10_000
  expect(
    pickStandby("binance", "100", [
      { venue: "bybit", price: "100", at: now, swing: "4" },
      { venue: "okx", price: "120", at: now, swing: "20" },
    ], now),
  ).toBe("okx")
  expect(
    pickStandby("binance", "100", [
      { venue: "bybit", price: "200", at: now, swing: "100" },
      { venue: "okx", price: "100", at: now, swing: "1" },
    ], now),
  ).toBe("okx")
  expect(
    pickStandby("binance", "100", [
      { venue: "bybit", price: "200", at: now, swing: "1" },
      { venue: "kraken", price: "180", at: now, swing: "50" },
    ], now),
  ).toBe("kraken")
  expect(
    pickStandby(
      "okx",
      "100",
      [
        { venue: "binance", price: "110", at: now, swing: "5" },
        { venue: "bybit", price: "101", at: now, swing: "5" },
      ],
      now,
      "binance",
    ),
  ).toBe("binance")
  expect(pickStandby("binance", "100", [{ venue: "bybit", price: "100", at: now - MOVE_MS - 1, swing: "100" }], now)).toBeNull()
})

test("binance reconnects only when the budget and the socket allow it", () => {
  const fresh = { ok: true, reason: "" }
  expect(recoveryAction({ venue: "bybit", messagesSilentMs: MOVE_MS, budget: fresh, alreadyTried: false })).toEqual({
    action: "switch",
    reason: "no price change for 5.0s",
  })
  expect(recoveryAction({ venue: "binance", messagesSilentMs: 1_000, budget: fresh, alreadyTried: false }).action).toBe("switch")
  expect(recoveryAction({ venue: "binance", messagesSilentMs: MOVE_MS, budget: fresh, alreadyTried: false })).toEqual({
    action: "reconnect",
    reason: "",
  })
  expect(
    recoveryAction({
      venue: "binance",
      messagesSilentMs: MOVE_MS,
      budget: { ok: false, reason: "12 attempts in 5m" },
      alreadyTried: false,
    }).reason,
  ).toBe("reconnect skipped (12 attempts in 5m)")
  expect(recoveryAction({ venue: "binance", messagesSilentMs: MOVE_MS, budget: fresh, alreadyTried: true }).reason).toBe(
    "reconnect produced no move",
  )
  expect(switchReason("no price change for 5.0s", [{ venue: "bybit", swing: "18.2" }, { venue: "okx", swing: "0.4" }])).toBe(
    "no price change for 5.0s; bybit swing $18.20, okx swing $0.40",
  )
})

test("twelve binance attempts in five minutes refuse another, and three fast deaths freeze", () => {
  const now = 110_000
  const spaced = (count: number) => Array.from({ length: count }, (_, index) => ({ at: index * 10_000, diedAt: index * 10_000 + 2_000 }))
  expect(allowBinanceConnect(spaced(BINANCE_MAX_ATTEMPTS - 1), now)).toEqual({ ok: true, reason: "" })
  expect(allowBinanceConnect(spaced(BINANCE_MAX_ATTEMPTS), now)).toEqual({ ok: false, reason: "12 attempts in 5m" })
  expect(allowBinanceConnect([{ at: now - 4_000, diedAt: now - 3_000 }], now).reason).toBe("last attempt 4s ago")
  expect(binanceWaitMs([{ at: now - 4_000, diedAt: now - 3_000 }], now)).toBe(6_000)
  const died = (at: number) => ({ at, diedAt: at + 100 })
  const fast = [died(0), died(20_000), died(40_000)]
  expect(allowBinanceConnect(fast, 40_101).reason).toBe("fast failures")
  expect(allowBinanceConnect(fast, 40_100 + BINANCE_FREEZE_MS).ok).toBe(true)
  expect(allowBinanceConnect([died(0), { at: 20_000, diedAt: 25_000 }, died(40_000)], 50_000).ok).toBe(true)
})

test("the switch log keeps five rows and an adopt fills the open one", () => {
  let log: SwitchEvent[] = []
  for (let n = 1; n <= 6; n++) {
    log = pushSwitch(log, { at: n, from: "binance", to: n === 6 ? null : "bybit", reason: `r${n}` })
  }
  expect(log.map((row) => row.reason)).toEqual(["r6", "r5", "r4", "r3", "r2"])
  const filled = fillSwitch(log, "okx")
  expect(filled[0]).toEqual({ at: 6, from: "binance", to: "okx", reason: "r6" })
  expect(filled[1]?.to).toBe("bybit")
})
