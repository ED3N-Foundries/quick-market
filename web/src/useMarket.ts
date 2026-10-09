import { useCallback, useEffect, useRef, useState } from "react"
import type { TapeChart, TapePoint } from "./chart"
import { formatMicros } from "./format"
import type { Config, RoundSnapshot, SettledMessage, Side, You } from "./types"

const ADDRESS_KEY = "qm.address"

const defaultConfig: Config = {
  roundSeconds: 10,
  feeBps: 25,
  betCutoffMs: 1000,
  minStakeMicros: 1_000_000,
}

export function useMarket() {
  const [address, setAddress] = useState<string | null>(() => localStorage.getItem(ADDRESS_KEY))
  const [round, setRound] = useState<RoundSnapshot | null>(null)
  const [you, setYou] = useState<You | null>(null)
  const [config, setConfig] = useState<Config>(defaultConfig)
  const [feed, setFeed] = useState<"live" | "stale">("stale")
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [pulse, setPulse] = useState(0)

  const offsetRef = useRef(0)
  const priceRef = useRef<string | null>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const addressRef = useRef(address)
  const seedRef = useRef<TapePoint[] | null>(null)
  const bufferRef = useRef<TapePoint[]>([])
  const seededRef = useRef(false)
  addressRef.current = address

  const applySeed = useCallback((chart: TapeChart) => {
    if (!seedRef.current) return
    chart.reset(seedRef.current)
    const last = seedRef.current[seedRef.current.length - 1]?.t ?? 0
    for (const point of bufferRef.current) {
      if (point.t >= last) chart.push(point.t, point.price)
    }
    bufferRef.current = []
    seededRef.current = true
  }, [])

  const bindChart = useCallback(
    (chart: TapeChart | null) => {
      chartRef.current = chart
      if (chart) applySeed(chart)
    },
    [applySeed],
  )

  const pushTick = useCallback((t: number, price: string) => {
    priceRef.current = price
    const point = { t, price: Number(price) }
    const chart = chartRef.current
    if (!seededRef.current || !chart) {
      bufferRef.current.push(point)
      return
    }
    chart.push(point.t, point.price)
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setPulse((value) => value + 1), 200)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let cancel = false
    const query = address ? `?address=${encodeURIComponent(address)}` : ""
    fetch(`/api/state${query}`)
      .then((response) => response.json())
      .then((body) => {
        if (cancel) return
        setRound(body.round)
        setConfig(body.config)
        setFeed(body.feed)
        offsetRef.current = body.serverNow - Date.now()
        if (body.you) setYou(body.you)
        if (!seededRef.current) {
          seedRef.current = (body.tape as { t: number; price: string }[]).map((point) => ({
            t: point.t,
            price: Number(point.price),
          }))
          if (chartRef.current) applySeed(chartRef.current)
        }
      })
      .catch(() => {
        if (!cancel) setError("Can't reach the market server")
      })
    return () => {
      cancel = true
    }
  }, [address, applySeed])

  useEffect(() => {
    let stopped = false
    let socket: WebSocket | null = null
    let retry = 0

    const connect = () => {
      if (stopped) return
      const protocol = location.protocol === "https:" ? "wss" : "ws"
      socket = new WebSocket(`${protocol}://${location.host}/ws`)
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as
          | { type: "tick"; price: string; exchangeTs: number; serverNow: number; feed: "live" | "stale" }
          | { type: "round"; serverNow: number; feed: "live" | "stale"; round: RoundSnapshot }
          | SettledMessage
        if ("serverNow" in message) offsetRef.current = message.serverNow - Date.now()
        if (message.type === "tick") {
          setFeed(message.feed)
          pushTick(message.exchangeTs, message.price)
        } else if (message.type === "round") {
          setFeed(message.feed)
          setRound(message.round)
        } else if (message.type === "settled") {
          const mine = message.payouts.find((payout) => payout.address === addressRef.current)
          const balance = message.balances.find((row) => row.address === addressRef.current)
          if (balance) {
            setYou((current) =>
              current
                ? {
                    ...current,
                    balanceMicros: balance.balanceMicros,
                    openBet: current.openBet?.roundId === message.roundId ? null : current.openBet,
                  }
                : current,
            )
          }
          setResult(describeResult(message, mine ?? null))
          setHistoryVersion((value) => value + 1)
        }
      }
      socket.onclose = () => {
        if (stopped) return
        retry = window.setTimeout(connect, 400)
      }
    }

    connect()
    return () => {
      stopped = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [pushTick])

  useEffect(() => {
    const roundId = round?.id
    const openRound = you?.openBet?.roundId
    if (!address || !roundId || !openRound || openRound === roundId) return
    let cancel = false
    fetch(`/api/state?address=${encodeURIComponent(address)}`)
      .then((response) => response.json())
      .then((body) => {
        if (!cancel && body.you) setYou(body.you)
      })
      .catch(() => {})
    return () => {
      cancel = true
    }
  }, [address, round?.id, you?.openBet?.roundId])

  const connect = useCallback((nextAddress: string) => {
    localStorage.setItem(ADDRESS_KEY, nextAddress)
    setAddress(nextAddress)
    setResult(null)
    setError(null)
  }, [])

  const place = useCallback(
    async (side: Side, stake: string) => {
      if (!address) return
      setPending(true)
      setError(null)
      try {
        const response = await fetch("/api/bets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, side, stake }),
        })
        const body = await response.json()
        if (!response.ok) {
          setError(body.error ?? "Bet failed")
          return
        }
        setYou(body.you)
        setRound(body.round)
        setResult(null)
      } catch {
        setError("Can't reach the market server")
      } finally {
        setPending(false)
      }
    },
    [address],
  )

  const fundWallet = useCallback(async () => {
    if (!address) return
    setError(null)
    const response = await fetch("/api/fund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    })
    const body = await response.json()
    if (!response.ok) {
      setError(body.error ?? "Fund failed")
      return
    }
    setYou(body.you)
  }, [address])

  const withdrawWallet = useCallback(
    async (amount: string) => {
      if (!address) return
      setError(null)
      const response = await fetch("/api/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, amount }),
      })
      const body = await response.json()
      if (!response.ok) {
        setError(body.error ?? "Withdraw failed")
        return
      }
      setYou(body.you)
    },
    [address],
  )

  const now = Date.now() + offsetRef.current
  void pulse

  return {
    address,
    round,
    you,
    config,
    feed,
    result,
    error,
    pending,
    historyVersion,
    now,
    offsetRef,
    priceRef,
    connect,
    place,
    fundWallet,
    withdrawWallet,
    bindChart,
    setRoundOnChart: (chart: TapeChart, current: RoundSnapshot) => {
      chart.setRound(current.startsAt, current.endsAt, current.strike === null ? null : Number(current.strike))
    },
  }
}

function describeResult(event: SettledMessage, mine: SettledMessage["payouts"][number] | null): string {
  if (event.resolution === "void") return mine ? "Void, refunded" : "Void"
  if (event.winningSide === "push") return mine ? "Push, refunded" : "Push"
  if (event.resolution === "refund") {
    if (mine) return "Refunded"
    if (event.winningSide === "up") return "Up, refund"
    if (event.winningSide === "down") return "Down, refund"
    return "Refunded"
  }
  if (!mine) {
    if (event.winningSide === "up") return "Up won"
    if (event.winningSide === "down") return "Down won"
    return "Resolved"
  }
  const profit = mine.payoutMicros - mine.stakeMicros
  const label = mine.side === "up" ? "Up" : "Down"
  if (profit === 0) return `${label} +0.00`
  const sign = profit > 0 ? "+" : "−"
  return `${label} ${sign}${formatMicros(Math.abs(profit))}`
}
