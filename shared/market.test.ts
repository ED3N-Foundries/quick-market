import { expect, test } from "bun:test"
import { feeBps, windowMs } from "../server/config"
import { loadMarket } from "./market"

test("hardcoded preferences replace a valid env declaration", () => {
  const loaded = loadMarket({
    WINDOW_SECONDS: "10",
    MARKET_SECONDS: "30",
    VIEW_SECONDS: "15",
    FEE_BPS: "25",
    PRICE_SOURCE: "coinbase",
    CHAIN: "base",
    GRANT_MICROS: "1",
    GRANT_INTERVAL_MS: "1",
  })
  expect(loaded.windowSeconds).toBe(5)
  expect(loaded.marketSeconds).toBe(5)
  expect(loaded.viewSeconds).toBe(5)
  expect(loaded.feeBps).toBe(0)
  expect(loaded.priceSource).toBe("binance")
  expect(loaded.chain).toBe("base-sepolia")
  expect(loaded.grantMicros).toBe(100_000_000)
  expect(loaded.grantIntervalMs).toBe(120_000)
})

test("a blank preference is ignored and an invalid one throws", () => {
  expect(loadMarket({ WINDOW_SECONDS: "  ", FEE_BPS: "" }).windowSeconds).toBe(5)
  expect(() => loadMarket({ FEE_BPS: "nope" })).toThrow("FEE_BPS")
  expect(() => loadMarket({ PRICE_SOURCE: "gemini" })).toThrow("PRICE_SOURCE")
})

test("window length stays on the schema after a later env write", () => {
  const previous = process.env.WINDOW_SECONDS
  process.env.WINDOW_SECONDS = "99"
  expect(windowMs()).toBe(5_000)
  expect(feeBps()).toBe(0)
  if (previous === undefined) delete process.env.WINDOW_SECONDS
  else process.env.WINDOW_SECONDS = previous
})
