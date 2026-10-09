import type { Print } from "./rounds"

const PRICE = /^\d+(\.\d+)?$/

export function startOracle(onPrint: (print: Print) => void) {
  let stopped = false
  let lastBinance = 0
  let binanceDelay = 500
  let coinbaseDelay = 500
  let binanceWs: WebSocket | null = null
  let coinbaseWs: WebSocket | null = null

  const connectBinance = () => {
    if (stopped) return
    let opened = false
    const ws = new WebSocket("wss://data-stream.binance.vision/ws/btcusdt@trade")
    binanceWs = ws
    ws.addEventListener("open", () => {
      opened = true
      binanceDelay = 500
      console.log("price feed: binance")
    })
    ws.addEventListener("message", (event) => {
      let message: { e?: string; p?: string; T?: number }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.e !== "trade" || typeof message.p !== "string" || typeof message.T !== "number") return
      if (!PRICE.test(message.p)) return
      lastBinance = Date.now()
      onPrint({ price: message.p, exchangeTs: message.T, receivedAt: lastBinance, source: "binance" })
    })
    let retried = false
    const retry = () => {
      if (stopped || retried || binanceWs !== ws) return
      retried = true
      const wait = binanceDelay
      binanceDelay = Math.min(binanceDelay * 2, 10_000)
      setTimeout(connectBinance, wait)
    }
    ws.addEventListener("close", retry)
    ws.addEventListener("error", () => {
      if (!opened) console.log("price feed: binance unavailable, waiting")
      ws.close()
    })
  }

  const connectCoinbase = () => {
    if (stopped) return
    const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com")
    coinbaseWs = ws
    ws.addEventListener("open", () => {
      coinbaseDelay = 500
      ws.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: ["BTC-USD"],
          channels: ["ticker", "heartbeat"],
        }),
      )
      console.log("price feed: coinbase standby")
    })
    ws.addEventListener("message", (event) => {
      if (Date.now() - lastBinance < 2_000) return
      let message: { type?: string; price?: string; time?: string }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.type !== "ticker" || typeof message.price !== "string" || !PRICE.test(message.price)) return
      const exchangeTs = message.time ? Date.parse(message.time) : Date.now()
      if (!Number.isFinite(exchangeTs)) return
      onPrint({ price: message.price, exchangeTs, receivedAt: Date.now(), source: "coinbase" })
    })
    let retried = false
    const retry = () => {
      if (stopped || retried || coinbaseWs !== ws) return
      retried = true
      const wait = coinbaseDelay
      coinbaseDelay = Math.min(coinbaseDelay * 2, 10_000)
      setTimeout(connectCoinbase, wait)
    }
    ws.addEventListener("close", retry)
    ws.addEventListener("error", () => ws.close())
  }

  connectBinance()
  connectCoinbase()

  return () => {
    stopped = true
    binanceWs?.close()
    coinbaseWs?.close()
  }
}
