import { useCallback, useEffect, useRef, useState } from "react"
import type { TapeChart, TapePoint } from "./chart"
import { formatGainLoss } from "./format"
import type { Board, Config, SettledMessage, Side, You } from "./types"

const ADDRESS_KEY = "qm.address"

const defaultConfig: Config = {
  windowSeconds: 5,
  marketSeconds: 5,
  feeBps: 25,
  minStakeMicros: 1_000_000,
  source: "binance",
  botCount: 8,
}

export function useMarket() {
  const [address, setAddress] = useState<string | null>(() => localStorage.getItem(ADDRESS_KEY))
  const [board, setBoard] = useState<Board | null>(null)
  const [you, setYou] = useState<You | null>(null)
  const [config, setConfig] = useState<Config>(defaultConfig)
  const [feed, setFeed] = useState<"live" | "stale">("stale")
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [notices, setNotices] = useState<SettledMessage[]>([])
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
        setBoard(body.board)
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
          | { type: "round"; serverNow: number; feed: "live" | "stale"; board: Board }
          | SettledMessage
        if ("serverNow" in message) offsetRef.current = message.serverNow - Date.now()
        if (message.type === "tick") {
          setFeed(message.feed)
          pushTick(message.exchangeTs, message.price)
        } else if (message.type === "round") {
          setFeed(message.feed)
          setBoard(message.board)
        } else if (message.type === "settled") {
          const mine = message.payouts.find((payout) => payout.address === addressRef.current)
          const balance = message.balances.find((row) => row.address === addressRef.current)
          setYou((current) =>
            current
              ? {
                  ...current,
                  balanceMicros: balance?.balanceMicros ?? current.balanceMicros,
                  openBets: current.openBets.filter((bet) => bet.roundId !== message.roundId),
                }
              : current,
          )
          if (mine) {
            setResult(describeResult(message, mine))
            setNotices((current) =>
              current.some((notice) => notice.roundId === message.roundId) ? current : [...current, message],
            )
          }
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

  const openKey = you?.openBets.map((bet) => bet.roundId).join(",") ?? ""
  const caught = useRef("")
  useEffect(() => {
    if (!address || !board || !you?.openBets.length) return
    const live = new Set<number>()
    if (board.live) live.add(board.live.id)
    if (board.join) live.add(board.join.id)
    const stuck = you.openBets
      .filter((bet) => !live.has(bet.roundId))
      .map((bet) => bet.roundId)
      .join(",")
    if (!stuck || caught.current === stuck) return
    caught.current = stuck
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
  }, [address, board, openKey, you?.openBets])

  const connect = useCallback((nextAddress: string) => {
    localStorage.setItem(ADDRESS_KEY, nextAddress)
    setAddress(nextAddress)
    setResult(null)
    setNotices([])
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
        setBoard(body.board)
        setResult(null)
      } catch {
        setError("Can't reach the market server")
      } finally {
        setPending(false)
      }
    },
    [address],
  )

  const fundWallet = useCallback(
    async (amount: string) => {
      if (!address) return
      setError(null)
      const response = await fetch("/api/fund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, amount }),
      })
      const body = await response.json()
      if (!response.ok) {
        setError(body.error ?? "Fund failed")
        return
      }
      setYou(body.you)
    },
    [address],
  )

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
    board,
    you,
    config,
    feed,
    result,
    error,
    pending,
    historyVersion,
    notices,
    dismissNotice: useCallback((roundId: number) => {
      setNotices((current) => current.filter((notice) => notice.roundId !== roundId))
    }, []),
    now,
    offsetRef,
    priceRef,
    connect,
    place,
    fundWallet,
    withdrawWallet,
    bindChart,
  }
}

function describeResult(event: SettledMessage, mine: SettledMessage["payouts"][number]): string {
  if (event.resolution === "void") return "Void"
  if (event.winningSide === "push") return "Push"
  const label = mine.side === "up" ? "▲ Up" : "▼ Down"
  return `${label} ${formatGainLoss(mine.stakeMicros, mine.payoutMicros)}`
}
