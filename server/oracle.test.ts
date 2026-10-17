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
  pickStandby,
  silenceBreak,
  BREAK_MS,
  STANDBY_MS,
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

test("silence inside the break window keeps the market", () => {
  expect(silenceBreak(null, 5_000)).toBe(false)
  expect(silenceBreak(1_000, 1_000 + BREAK_MS - 1)).toBe(false)
  expect(silenceBreak(1_000, 1_000 + BREAK_MS)).toBe(true)
})

test("a stream that has printed retries the same URL before walking on", () => {
  expect(nextFeedStep({ printed: true, retries: 0, index: 2 })).toEqual({ index: 2, retries: 1, delay: 200 })
  expect(nextFeedStep({ printed: true, retries: 3, index: 2 })).toEqual({ index: 2, retries: 4, delay: 1_600 })
  expect(nextFeedStep({ printed: true, retries: 4, index: 2 })).toEqual({ index: 3, retries: 0, delay: 0 })
  expect(nextFeedStep({ printed: false, retries: 0, index: 2 })).toEqual({ index: 3, retries: 0, delay: 0 })
})

test("a standby more than $25 away is skipped", () => {
  const now = 10_000
  const rows = [
    { venue: "bybit" as const, price: "81600", at: now },
    { venue: "kraken" as const, price: "81400", at: now },
    { venue: "okx" as const, price: "81590", at: now - STANDBY_MS - 1 },
  ]
  expect(pickStandby("binance", "81620", rows, now)).toBe("bybit")
  expect(pickStandby("binance", "81620", [{ venue: "kraken", price: "81400", at: now }], now)).toBeNull()
  expect(pickStandby("bitstamp", "100", [{ venue: "binance", price: "101", at: now }], now)).toBe("binance")
})
