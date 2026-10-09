import { priceSource } from "./config"
import type { Print } from "./rounds"

const PRICE = /^\d+(\.\d+)?$/

export function startOracle(onPrint: (print: Print) => void) {
  const source = priceSource()
  let stopped = false
  let delay = 500
  let socket: WebSocket | null = null

  const connect = () => {
    if (stopped) return
    const ws =
      source === "coinbase"
        ? new WebSocket("wss://ws-feed.exchange.coinbase.com")
        : new WebSocket("wss://data-stream.binance.vision/ws/btcusdt@trade")
    socket = ws
    let opened = false
    ws.addEventListener("open", () => {
      opened = true
      delay = 500
      if (source === "coinbase") {
        ws.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker", "heartbeat"] }))
      }
      console.log(`price feed: ${source}`)
    })
    ws.addEventListener("message", (event) => {
      if (source === "binance") onBinance(event.data, onPrint)
      else onCoinbase(event.data, onPrint)
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
      if (!opened) console.log(`price feed: ${source} unavailable, waiting`)
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

function onCoinbase(data: unknown, onPrint: (print: Print) => void) {
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
