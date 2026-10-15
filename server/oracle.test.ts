import { expect, test } from "bun:test"
import { parseBinance, parseCoinbaseAdvanced, parseCoinbaseExchange } from "./oracle"

test("parseBinance keeps a trade price string", () => {
  const print = parseBinance(JSON.stringify({ e: "trade", p: "83378.01000000", T: 1_700_000_000_000 }))
  expect(print?.price).toBe("83378.01000000")
  expect(print?.exchangeTs).toBe(1_700_000_000_000)
  expect(print?.source).toBe("binance")
  expect(parseBinance(JSON.stringify({ e: "aggTrade", p: "83378.02", T: 5 }))?.price).toBe("83378.02")
  expect(parseBinance(JSON.stringify({ s: "BTCUSDT", b: "100.00", a: "102.00" }))?.price).toBe("101.00")
  expect(parseBinance(JSON.stringify({ s: "ETHUSDT", b: "100", a: "102" }))).toBeNull()
})

test("parseCoinbaseExchange accepts a match and ignores other messages", () => {
  const print = parseCoinbaseExchange(
    JSON.stringify({ type: "match", product_id: "BTC-USD", price: "83362.59", time: "2026-10-13T00:00:00.000Z" }),
  )
  expect(print?.price).toBe("83362.59")
  expect(print?.source).toBe("coinbase")
  expect(Number.isFinite(print?.exchangeTs)).toBe(true)
  const ticker = parseCoinbaseExchange(
    JSON.stringify({ type: "ticker", product_id: "BTC-USD", price: "83300", time: "2026-10-13T00:00:00.000Z" }),
  )
  expect(ticker?.price).toBe("83300")
  expect(parseCoinbaseExchange(JSON.stringify({ type: "heartbeat" }))).toBeNull()
  expect(parseCoinbaseExchange(JSON.stringify({ type: "last_match", product_id: "ETH-USD", price: "1" }))).toBeNull()
})

test("parseCoinbaseAdvanced uses the newest BTC-USD print in the batch", () => {
  const print = parseCoinbaseAdvanced(
    JSON.stringify({
      channel: "ticker",
      events: [
        {
          tickers: [
            { product_id: "BTC-USD", price: "100", time: "2026-10-13T00:00:00.000Z" },
            { product_id: "BTC-USD", price: "101", time: "2026-10-13T00:00:01.000Z" },
            { product_id: "ETH-USD", price: "9", time: "2026-10-13T00:00:02.000Z" },
          ],
        },
      ],
    }),
  )
  expect(print?.price).toBe("101")
  expect(print?.source).toBe("coinbase")

  const trade = parseCoinbaseAdvanced(
    JSON.stringify({
      channel: "market_trades",
      events: [{ trades: [{ product_id: "BTC-USD", price: "50.5", time: "2026-10-13T00:00:00.000Z" }] }],
    }),
  )
  expect(trade?.price).toBe("50.5")
  expect(parseCoinbaseAdvanced(JSON.stringify({ channel: "heartbeats" }))).toBeNull()
})
