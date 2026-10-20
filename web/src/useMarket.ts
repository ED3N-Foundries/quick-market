import { useCallback, useEffect, useRef, useState } from "react"
import { LATE_BET_CODE } from "../../shared/bet"
import { chainFromEnv, moneyLabel, tokenKind, tokenLabel, type ChainConfig } from "../../shared/chain"
import { marketPreferences } from "../../shared/market"
import { writeCachedBalance } from "./balanceCache"
import { applyBet } from "./betIntent"
import type { TapeChart, TapePoint } from "./chart"
import { createClock, easeClock, noteClock } from "./clock"
import { parseAmountMicros } from "./format"
import { betMarket } from "./focus"
import type { Handoff, Ticker } from "../../shared/source"
import { tickerFor } from "../../shared/source"
import type { Board, Config, SettledMessage, Side, You } from "./types"

function configuredChain(): ChainConfig {
  try {
    return chainFromEnv(marketPreferences.chain, import.meta.env.USDC_ADDRESS)
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
  const [ticker, setTicker] = useState<Ticker>(tickerFor("binance"))
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [notices, setNotices] = useState<SettledMessage[]>([])
  const [lateNotices, setLateNotices] = useState<number[]>([])
  const [pulse, setPulse] = useState(0)
  const [unauthorized, setUnauthorized] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const offsetRef = useRef(0)
  const clockRef = useRef(createClock())
  const priceRef = useRef<string | null>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const tokenRef = useRef(token)
  const youRef = useRef<You | null>(null)
  const configRef = useRef(config)
  const seedRef = useRef<TapePoint[] | null>(null)
  const bufferRef = useRef<TapePoint[]>([])
  const seededRef = useRef(false)
  const betLock = useRef(false)
  const betIntent = useRef(0)
  const confirmedRef = useRef(false)
  const youEpoch = useRef(0)
  tokenRef.current = token
  youRef.current = you
  configRef.current = config

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

  const markConfirmed = useCallback((value: boolean) => {
    confirmedRef.current = value
    setConfirmed(value)
  }, [])

  const acceptYou = useCallback((next: You | null) => {
    youEpoch.current += 1
    if (next) writeCachedBalance(next)
    setYou(next)
    return next
  }, [])

  const noteServerNow = useCallback((serverNow: number) => {
    clockRef.current = noteClock(clockRef.current, serverNow, Date.now())
    offsetRef.current = clockRef.current.offset
  }, [])

  const pushTick = useCallback((t: number, price: string) => {
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
      markConfirmed(false)
      return null
    }
    const body = await response.json()
    setBoard(body.board)
    setConfig(body.config)
    setFeed(body.feed)
    if (body.ticker) setTicker(body.ticker)
    setHandoff(body.handoff ?? null)
    noteServerNow(body.serverNow)
    acceptYou(body.you ?? null)
    markConfirmed(true)
    return body.you ?? null
  }, [acceptYou, markConfirmed, noteServerNow])

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
    let raf = 0
    const loop = () => {
      clockRef.current = easeClock(clockRef.current, Date.now())
      offsetRef.current = clockRef.current.offset
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    setUnauthorized(false)
    markConfirmed(false)
    if (!token) setYou(null)
    const seen = youEpoch.current
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
        if (body.ticker) setTicker(body.ticker)
        setHandoff(body.handoff ?? null)
        noteServerNow(body.serverNow)
        if (youEpoch.current === seen) acceptYou(body.you ?? null)
        if (token) markConfirmed(true)
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
  }, [token, acceptYou, applySeed, markConfirmed, noteServerNow])

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
          | { type: "round"; serverNow: number; feed: "live" | "stale"; board: Board; ticker?: Ticker; handoff?: Handoff | null }
          | SettledMessage
        if ("serverNow" in message) noteServerNow(message.serverNow)
        if (message.type === "tick") {
          setFeed(message.feed)
          pushTick(message.exchangeTs, message.price)
        } else if (message.type === "round") {
          setFeed(message.feed)
          setBoard(message.board)
          if (message.ticker) setTicker(message.ticker)
          setHandoff(message.handoff ?? null)
        } else if (message.type === "settled") {
          const address = youRef.current?.address ?? null
          const mine = address ? message.payouts.find((payout) => payout.address === address) : null
          const balance = address ? message.balances.find((row) => row.address === address) : null
          setYou((current) => {
            if (!current) return current
            const next = {
              ...current,
              balanceMicros: balance?.balanceMicros ?? current.balanceMicros,
              openBets: current.openBets.filter((bet) => bet.roundId !== message.roundId),
            }
            youEpoch.current += 1
            writeCachedBalance(next)
            return next
          })
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
  }, [pushTick, noteServerNow])

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

  const pushLate = useCallback(() => {
    setLateNotices((current) => (current.length > 0 ? current : [1]))
  }, [])

  const place = useCallback(
    async (side: Side, stake: string, roundId: number, blockStart: number, windowEndsAt: number) => {
      if (!confirmedRef.current || !tokenRef.current || betLock.current) return
      const now = Date.now() + offsetRef.current
      if (betMarket(roundId, blockStart, windowEndsAt, now) === "miss") {
        if (now >= windowEndsAt) pushLate()
        return
      }
      const current = youRef.current
      if (!current) return
      const stakeMicros = parseAmountMicros(stake)
      if (stakeMicros === null) {
        setError("Stake is invalid")
        return
      }
      if (stakeMicros < configRef.current.minStakeMicros) {
        setError("Minimum stake is 1 USDC")
        return
      }
      if (stakeMicros > current.balanceMicros) {
        setError("Insufficient balance")
        return
      }
      betLock.current = true
      const intent = ++betIntent.current
      const snapshot = current
      youEpoch.current += 1
      setYou(applyBet(current, { side, stakeMicros, roundId }))
      setPending(true)
      setError(null)
      const stale = () => intent !== betIntent.current
      try {
        const response = await fetch("/api/bets", {
          method: "POST",
          headers: headers(tokenRef.current, true),
          body: JSON.stringify({ side, stake, roundId }),
        })
        const body = (await response.json()) as { error?: string; code?: string; you?: You; board?: Board }
        if (stale()) return
        if (response.status === 401) {
          youEpoch.current += 1
          setYou(snapshot)
          setUnauthorized(true)
          return
        }
        if (!response.ok) {
          youEpoch.current += 1
          setYou(snapshot)
          if (body.code === LATE_BET_CODE) {
            pushLate()
            return
          }
          setError(body.error ?? "Bet failed")
          return
        }
        if (body.you) acceptYou(body.you)
        if (body.board) setBoard(body.board)
      } catch {
        if (stale()) return
        youEpoch.current += 1
        setYou(snapshot)
        setError("Can't reach the market server")
      } finally {
        if (!stale()) {
          betLock.current = false
          setPending(false)
        }
      }
    },
    [acceptYou, pushLate],
  )

  const claimGrant = useCallback(async (): Promise<{ ok: true; granted: boolean } | { ok: false; message: string }> => {
    if (!tokenRef.current) return { ok: false, message: "Sign in to receive a grant." }
    try {
      const response = await fetch("/api/grant", {
        method: "POST",
        headers: headers(tokenRef.current),
      })
      const body = (await response.json().catch(() => null)) as { error?: string; granted?: boolean; you?: You } | null
      if (body?.you) {
        acceptYou(body.you)
        markConfirmed(true)
      }
      if (response.status === 401) {
        setUnauthorized(true)
        return { ok: false, message: "Sign in to receive a grant." }
      }
      if (!response.ok) return { ok: false, message: body?.error ?? "The grant did not land. Try again." }
      return { ok: true, granted: Boolean(body?.granted) }
    } catch {
      return { ok: false, message: "Can't reach the market server" }
    }
  }, [acceptYou, markConfirmed])

  const withdrawWallet = useCallback(async (amount: string): Promise<string | null> => {
    if (!tokenRef.current) return "Connect a wallet first"
    try {
      const response = await fetch("/api/withdraw", {
        method: "POST",
        headers: headers(tokenRef.current, true),
        body: JSON.stringify({ amount }),
      })
      const body = await response.json()
      if (body.you) acceptYou(body.you)
      if (response.status === 401) {
        setUnauthorized(true)
        return "Connect a wallet first"
      }
      if (!response.ok) return body.error ?? "Withdraw failed"
      return null
    } catch {
      return "Can't reach the market server"
    }
  }, [acceptYou])

  const now = Date.now() + offsetRef.current
  void pulse

  return {
    address: you?.address ?? null,
    board,
    you,
    config,
    feed,
    ticker,
    handoff,
    error,
    setError,
    pending,
    historyVersion,
    notices,
    lateNotices,
    dismissNotice: useCallback((roundId: number) => {
      setNotices((current) => current.filter((notice) => notice.roundId !== roundId))
    }, []),
    dismissLate: useCallback((id: number) => {
      setLateNotices((current) => current.filter((notice) => notice !== id))
    }, []),
    unauthorized,
    confirmed,
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
