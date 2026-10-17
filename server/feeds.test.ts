import { expect, test } from "bun:test"
import { feedsNow, legRole } from "./feeds"
import { STANDBY_MS } from "./oracle"

const now = 10_000

test("legRole names the publishing venue and each backup gate", () => {
  expect(legRole({ venue: "binance", active: "binance", anchor: "100", price: "100", at: now, up: true, now }).role).toBe("active")
  expect(legRole({ venue: "binance", active: "binance", anchor: "100", price: null, at: 0, up: false, now }).role).toBe("active")
  expect(legRole({ venue: "bybit", active: "binance", anchor: "100", price: "125", at: now - STANDBY_MS, up: true, now }).role).toBe("ready")
  expect(legRole({ venue: "bybit", active: "binance", anchor: "100", price: "125", at: now - STANDBY_MS - 1, up: true, now }).role).toBe("stale")
  expect(legRole({ venue: "okx", active: "binance", anchor: "100", price: "125.01", at: now, up: true, now }).role).toBe("far")
  expect(legRole({ venue: "okx", active: "binance", anchor: null, price: "100", at: now, up: true, now }).role).toBe("far")
  expect(legRole({ venue: "coinbase", active: "binance", anchor: "100", price: null, at: 0, up: true, now }).role).toBe("quiet")
  expect(legRole({ venue: "kraken", active: "binance", anchor: "100", price: "100", at: now, up: false, now }).role).toBe("down")
})

test("feedsNow keeps venue order and the dollar gap", () => {
  const frame = feedsNow(
    {
      active: "binance",
      anchor: "67420.12",
      venues: [
        { venue: "binance", price: "67420.12", at: 9_920, feed: "binance vision book", up: true },
        { venue: "bybit", price: "67419.80", at: 9_600, feed: "bybit book", up: true },
        { venue: "bitstamp", price: "67500.00", at: 9_800, feed: "bitstamp book", up: true },
      ],
    },
    { configured: "binance", live: "live", handoff: null, now },
  )
  expect(frame.venues.map((row) => row.venue)).toEqual(["binance", "bybit", "okx", "coinbase", "kraken", "bitstamp"])
  expect(frame.venues.map((row) => row.role)).toEqual(["active", "ready", "down", "down", "down", "far"])
  expect(frame.venues[1]?.gap).toBe("0.32")
  expect(frame.venues[5]?.gap).toBe("79.88")
  expect(frame.venues[2]?.reason).toBe("socket is down")
})
