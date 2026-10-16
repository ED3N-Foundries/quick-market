import { useCallback, useEffect, useRef, useState } from "react"
import { chainFromEnv, moneyLabel, tokenKind, tokenLabel, type ChainConfig } from "../../shared/chain"
import type { TapeChart, TapePoint } from "./chart"
import type { Board, Config, SettledMessage, Side, You } from "./types"

function configuredChain(): ChainConfig {
  try {
    return chainFromEnv(import.meta.env.CHAIN, import.meta.env.USDC_ADDRESS)
  } catch {
    return chainFromEnv(undefined)
  }
}

const pageChain = configuredChain()

const defaultConfig: Config = {
  windowSeconds: 5,
  marketSeconds: 5,
  viewSeconds: 5,
  feeBps: 0,
  minStakeMicros: 1_000_000,
  source: "binance",
  chainId: pageChain.id,
  chainName: pageChain.name,
  usdc: pageChain.usdc,
  treasury: "",
  moneyLabel: moneyLabel(pageChain),
  tokenKind: tokenKind(pageChain),
  tokenLabel: tokenLabel(pageChain),
  grantMicros: 0,
  grantIntervalMs: 0,
}

function headers(token: string | null, json = false): HeadersInit {
  const result: Record<string, string> = {}
  if (json) result["content-type"] = "application/json"
  if (token) result.authorization = `Bearer ${token}`
  return result
}

export function useMarket(token: string | null) {
  const [board, setBoard] = useState<Board | null>(null)
  const [you, setYou] = useState<You | null>(null)
  const [config, setConfig] = useState<Config>(defaultConfig)
  const [feed, setFeed] = useState<"live" | "stale">("stale")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [notices, setNotices] = useState<SettledMessage[]>([])
  const [pulse, setPulse] = useState(0)
  const [unauthorized, setUnauthorized] = useState(false)

  const offsetRef = useRef(0)
  const priceRef = useRef<string | null>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const tokenRef = useRef(token)
  const youRef = useRef<You | null>(null)
  const seedRef = useRef<TapePoint[] | null>(null)
  const bufferRef = useRef<TapePoint[]>([])
  const seededRef = useRef(false)
  tokenRef.current = token
  youRef.current = you

  const applySeed = useCallback((chart: TapeChart) => {
    if (!seedRef.current) return
    chart.reset(seedRef.current)
    const last = seedRef.current[seedRef.current.length - 1]?.t ?? 0
    for (const point of bufferRef.current) {
      if (point.t >= last) chart.push(point.t, point.price, point.text)
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
    const point = { t, price: Number(price), text: price }
    const chart = chartRef.current
    if (!seededRef.current || !chart) {
      bufferRef.current.push(point)
      return
    }
    chart.push(point.t, point.price, point.text)
  }, [])

  const reload = useCallback(async (): Promise<You | null> => {
    const response = await fetch("/api/state", { headers: headers(tokenRef.current) })
    if (response.status === 401) {
      setUnauthorized(true)
      setYou(null)
      return null
    }
    const body = await response.json()
    setBoard(body.board)
    setConfig(body.config)
    setFeed(body.feed)
    offsetRef.current = body.serverNow - Date.now()
    setYou(body.you ?? null)
    return body.you ?? null
  }, [])

  const waitForBalance = useCallback(
    async (minMicros: number) => {
      const start = Date.now()
      while (Date.now() - start < 30_000) {
        const next = await reload()
        if (next && next.balanceMicros >= minMicros) return next
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      return null
    },
    [reload],
  )

  useEffect(() => {
    const id = window.setInterval(() => setPulse((value) => value + 1), 200)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    setUnauthorized(false)
    if (!token) setYou(null)
    let cancel = false
    fetch("/api/state", { headers: headers(token) })
      .then(async (response) => {
        if (response.status === 401) {
          if (!cancel) {
            setUnauthorized(true)
            setYou(null)
          }
          return null
        }
        return response.json()
      })
      .then((body) => {
        if (cancel || !body) return
        setBoard(body.board)
        setConfig(body.config)
        setFeed(body.feed)
        offsetRef.current = body.serverNow - Date.now()
        setYou(body.you ?? null)
        if (!seededRef.current) {
          seedRef.current = (body.tape as { t: number; price: string }[]).map((point) => ({
            t: point.t,
            price: Number(point.price),
            text: point.price,
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
  }, [token, applySeed])

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
          const address = youRef.current?.address ?? null
          const mine = address ? message.payouts.find((payout) => payout.address === address) : null
          const balance = address ? message.balances.find((row) => row.address === address) : null
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
    if (!token || !board || !you?.openBets.length) return
    const live = new Set<number>()
    if (board.live) live.add(board.live.id)
    if (board.join) live.add(board.join.id)
    const stuck = you.openBets
      .filter((bet) => !live.has(bet.roundId))
      .map((bet) => bet.roundId)
      .join(",")
    if (!stuck || caught.current === stuck) return
    caught.current = stuck
    reload().catch(() => {})
  }, [token, board, openKey, you?.openBets, reload])

  const place = useCallback(
    async (side: Side, stake: string) => {
      if (!tokenRef.current) return
      setPending(true)
      setError(null)
      try {
        const response = await fetch("/api/bets", {
          method: "POST",
          headers: headers(tokenRef.current, true),
          body: JSON.stringify({ side, stake }),
        })
        const body = await response.json()
        if (response.status === 401) {
          setUnauthorized(true)
          return
        }
        if (!response.ok) {
          setError(body.error ?? "Bet failed")
          return
        }
        setYou(body.you)
        setBoard(body.board)
      } catch {
        setError("Can't reach the market server")
      } finally {
        setPending(false)
      }
    },
    [],
  )

  const claimGrant = useCallback(async (): Promise<{ ok: true; granted: boolean } | { ok: false; message: string }> => {
    if (!tokenRef.current) return { ok: false, message: "Sign in to receive a grant." }
    try {
      const response = await fetch("/api/grant", {
        method: "POST",
        headers: headers(tokenRef.current),
      })
      const body = (await response.json().catch(() => null)) as { error?: string; granted?: boolean; you?: You } | null
      if (body?.you) setYou(body.you)
      if (response.status === 401) {
        setUnauthorized(true)
        return { ok: false, message: "Sign in to receive a grant." }
      }
      if (!response.ok) return { ok: false, message: body?.error ?? "The grant did not land. Try again." }
      return { ok: true, granted: Boolean(body?.granted) }
    } catch {
      return { ok: false, message: "Can't reach the market server" }
    }
  }, [])

  const withdrawWallet = useCallback(async (amount: string): Promise<string | null> => {
    if (!tokenRef.current) return "Connect a wallet first"
    try {
      const response = await fetch("/api/withdraw", {
        method: "POST",
        headers: headers(tokenRef.current, true),
        body: JSON.stringify({ amount }),
      })
      const body = await response.json()
      if (body.you) setYou(body.you)
      if (response.status === 401) {
        setUnauthorized(true)
        return "Connect a wallet first"
      }
      if (!response.ok) return body.error ?? "Withdraw failed"
      return null
    } catch {
      return "Can't reach the market server"
    }
  }, [])

  const now = Date.now() + offsetRef.current
  void pulse

  return {
    address: you?.address ?? null,
    board,
    you,
    config,
    feed,
    error,
    setError,
    pending,
    historyVersion,
    notices,
    dismissNotice: useCallback((roundId: number) => {
      setNotices((current) => current.filter((notice) => notice.roundId !== roundId))
    }, []),
    unauthorized,
    now,
    offsetRef,
    priceRef,
    place,
    claimGrant,
    withdrawWallet,
    reload,
    waitForBalance,
    bindChart,
    token,
  }
}
