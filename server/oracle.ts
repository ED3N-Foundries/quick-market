import { blendLegs, type Leg } from "./blend"
import { priceSource } from "./config"
import type { Print } from "./rounds"

const PRICE = /^\d+(\.\d+)?$/

type Venue = "binance" | "coinbase"

export function startOracle(onPrint: (print: Print) => void) {
  const source = priceSource()
  if (source !== "average") return startVenue(source, onPrint)
  const legs: { binance: Leg | null; coinbase: Leg | null } = { binance: null, coinbase: null }
  const emit = (venue: Venue, print: Print) => {
    legs[venue] = { price: print.price, receivedAt: print.receivedAt }
    const now = Date.now()
    const price = blendLegs(legs.binance, legs.coinbase, now)
    if (!price) return
    onPrint({ price, exchangeTs: now, receivedAt: now, source: "average" })
  }
  const stopBinance = startVenue("binance", (print) => emit("binance", print), "average, binance trades")
  const stopCoinbase = startVenue("coinbase", (print) => emit("coinbase", print), "average, coinbase trades", "matches")
  return () => {
    stopBinance()
    stopCoinbase()
  }
}

function startVenue(
  venue: Venue,
  onPrint: (print: Print) => void,
  label = venue,
  coinbaseChannel: "ticker" | "matches" = "ticker",
) {
  let stopped = false
  let delay = 500
  let socket: WebSocket | null = null

  const connect = () => {
    if (stopped) return
    const ws =
      venue === "coinbase"
        ? new WebSocket("wss://ws-feed.exchange.coinbase.com")
        : new WebSocket("wss://data-stream.binance.vision/ws/btcusdt@trade")
    socket = ws
    let opened = false
    ws.addEventListener("open", () => {
      opened = true
      delay = 500
      if (venue === "coinbase") {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: ["BTC-USD"],
            channels: [coinbaseChannel, "heartbeat"],
          }),
        )
      }
      console.log(`price feed: ${label}`)
    })
    ws.addEventListener("message", (event) => {
      if (venue === "binance") onBinance(event.data, onPrint)
      else if (coinbaseChannel === "matches") onCoinbaseMatch(event.data, onPrint)
      else onCoinbaseTicker(event.data, onPrint)
    })
    let retried = false
    const retry = () => {
      if (stopped || retried || socket !== ws) return
      retried = true
      const wait = delay
      delay = Math.min(delay * 2, 10_000)
      setTimeout(connect, wait)
    }
    ws.addEventListener("close", retry)
    ws.addEventListener("error", () => {
      if (!opened) console.log(`price feed: ${label} unavailable, waiting`)
      ws.close()
    })
  }

  connect()
  return () => {
    stopped = true
    socket?.close()
  }
}

function onBinance(data: unknown, onPrint: (print: Print) => void) {
  let message: { e?: string; p?: string; T?: number }
  try {
    message = JSON.parse(String(data))
  } catch {
    return
  }
  if (message.e !== "trade" || typeof message.p !== "string" || typeof message.T !== "number") return
  if (!PRICE.test(message.p)) return
  onPrint({ price: message.p, exchangeTs: message.T, receivedAt: Date.now(), source: "binance" })
}

function onCoinbaseTicker(data: unknown, onPrint: (print: Print) => void) {
  let message: { type?: string; price?: string; time?: string }
  try {
    message = JSON.parse(String(data))
  } catch {
    return
  }
  if (message.type !== "ticker" || typeof message.price !== "string" || !PRICE.test(message.price)) return
  const exchangeTs = message.time ? Date.parse(message.time) : Date.now()
  if (!Number.isFinite(exchangeTs)) return
  onPrint({ price: message.price, exchangeTs, receivedAt: Date.now(), source: "coinbase" })
}

function onCoinbaseMatch(data: unknown, onPrint: (print: Print) => void) {
  let message: { type?: string; price?: string; product_id?: string; time?: string }
  try {
    message = JSON.parse(String(data))
  } catch {
    return
  }
  if (message.type !== "match" || message.product_id !== "BTC-USD") return
  if (typeof message.price !== "string" || !PRICE.test(message.price)) return
  const exchangeTs = message.time ? Date.parse(message.time) : Date.now()
  if (!Number.isFinite(exchangeTs)) return
  onPrint({ price: message.price, exchangeTs, receivedAt: Date.now(), source: "coinbase" })
}
