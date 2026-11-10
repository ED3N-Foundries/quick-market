import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { LATE_BUY_IN_CODE } from "../../shared/buyIn"
import { GRANT_FOLLOW_MS, MINT_CONFIRMATIONS } from "../../shared/mint"
import { writeCachedBalance } from "./balanceCache"
import { applyBuyIn } from "./buyInIntent"
import type { TapeChart, TapePoint } from "./chart"
import { createClock, easeClock, noteClock } from "./clock"
import {
  connectionState,
  createLag,
  createProbe,
  lagProbe,
  linkStatus,
  noteDown,
  noteEcho,
  noteHidden,
  noteProbeInbound,
  noteProbeSent,
  noteWakeProbe,
  readEcho,
  silenceMs,
  socketPhase,
  supervise,
  wakeAction,
} from "./lag"
import { parseAmountMicros } from "./format"
import { grantLanded } from "./grantWatch"
import type { Handoff, Ticker } from "../../shared/source"
import { tickerFor } from "../../shared/source"
import { dismissRound, dueBuyIns, emptyNotices, settleNotice, tickNotices } from "./resultNotice"
import type { Board, Config, SettledMessage, Side, You } from "./types"

function readTape(value: unknown): TapePoint[] | null {
  if (!Array.isArray(value)) return null
  const points: TapePoint[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const row = item as { t?: unknown; price?: unknown }
    if (typeof row.t !== "number" || typeof row.price !== "string") continue
    const price = Number(row.price)
    if (!Number.isFinite(row.t) || !Number.isFinite(price)) continue
    points.push({ t: row.t, price, text: row.price })
  }
  return points
}

function headers(token: string | null, json = false): HeadersInit {
  const result: Record<string, string> = {}
  if (json) result["content-type"] = "application/json"
  if (token) result.authorization = `Bearer ${token}`
  return result
}

export function useMarket(token: string | null, seed: You | null = null, initialConfig: Config) {
  const [board, setBoard] = useState<Board | null>(null)
  const [you, setYou] = useState<You | null>(null)
  const [config, setConfig] = useState<Config>(initialConfig)
  const [feed, setFeed] = useState<"live" | "stale">("stale")
  const [ticker, setTicker] = useState<Ticker>(tickerFor("binance"))
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [noticeState, setNoticeState] = useState(emptyNotices)
  const [lateNotices, setLateNotices] = useState<number[]>([])
  const [pulse, setPulse] = useState(0)
  const [unauthorized, setUnauthorized] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const offsetRef = useRef(0)
  const clockRef = useRef(createClock())
  const lagRef = useRef(createLag())
  const probeRef = useRef(createProbe())
  const lastInboundRef = useRef<number | null>(null)
  const openedAtRef = useRef<number | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const connectingSinceRef = useRef<number | null>(null)
  const retryPendingRef = useRef(false)
  const replaceRef = useRef<() => void>(() => {})
  const reloadRef = useRef<(opts?: { tape?: boolean }) => Promise<You | null>>(async () => null)
  const priceRef = useRef<string | null>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const tokenRef = useRef(token)
  const youRef = useRef<You | null>(null)
  const boardRef = useRef<Board | null>(null)
  const configRef = useRef(config)
  const feedRef = useRef<"live" | "stale">(feed)
  feedRef.current = feed
  const seedRef = useRef<TapePoint[] | null>(null)
  const bufferRef = useRef<TapePoint[]>([])
  const seededRef = useRef(false)
  const betLock = useRef(false)
  const betIntent = useRef(0)
  const confirmedRef = useRef(false)
  const youEpoch = useRef(0)
  tokenRef.current = token
  youRef.current = you
  boardRef.current = board
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

  const reload = useCallback(async (opts?: { tape?: boolean }): Promise<You | null> => {
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
    const holdYou = Boolean(opts?.tape) && betLock.current
    if (!holdYou) acceptYou(body.you ?? null)
    if (opts?.tape && !holdYou) {
      const points = readTape(body.tape)
      if (points) {
        seedRef.current = points
        if (chartRef.current) applySeed(chartRef.current)
      }
    }
    if (!holdYou) markConfirmed(true)
    return body.you ?? null
  }, [acceptYou, applySeed, markConfirmed, noteServerNow])
  reloadRef.current = reload

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
    const id = window.setInterval(() => {
      const now = Date.now()
      const socket = socketRef.current
      const decision = supervise({
        phase: socketPhase(socket ? socket.readyState : null),
        now,
        lastInboundAt: lastInboundRef.current,
        openedAt: openedAtRef.current,
        connectingSince: connectingSinceRef.current,
        retryPending: retryPendingRef.current,
        probe: probeRef.current,
      })
      probeRef.current = decision.probe
      if (decision.action === "replace") {
        replaceRef.current()
      } else if (decision.action === "probe" && socket && socket.readyState === WebSocket.OPEN) {
        const t = Date.now()
        try {
          socket.send(lagProbe(t))
          probeRef.current = noteProbeSent(probeRef.current, t)
        } catch {
          replaceRef.current()
        }
      }
      setPulse((value) => value + 1)
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let raf = 0
    const loop = () => {
      const wallNow = Date.now()
      clockRef.current = easeClock(clockRef.current, wallNow)
      offsetRef.current = clockRef.current.offset
      const clockNow = wallNow + offsetRef.current
      const bets = dueBuyIns(boardRef.current, youRef.current?.openBuyIns ?? [])
      setNoticeState((state) => tickNotices(state, bets, clockNow, wallNow))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  useLayoutEffect(() => {
    if (!token || !seed) return
    acceptYou(seed)
  }, [token, seed, acceptYou])

  const grantPendingAt = you?.grantPending?.startedAt ?? null
  useEffect(() => {
    if (!token || grantPendingAt == null) return
    const id = window.setInterval(() => {
      void reload().catch(() => {})
    }, 1_000)
    return () => window.clearInterval(id)
  }, [token, grantPendingAt, reload])

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
    let generation = 0
    let resyncAt = 0
    let wokeAt = 0

    const detach = (current: WebSocket) => {
      current.onopen = null
      current.onmessage = null
      current.onclose = null
      current.onerror = null
      try {
        current.close()
      } catch {
        // The socket is already closing.
      }
    }

    const resync = () => {
      if (betLock.current) return
      const hole = silenceMs(lastInboundRef.current, openedAtRef.current, Date.now())
      const viewMs = Math.max(1_000, configRef.current.viewSeconds * 1000)
      if (hole == null || hole < viewMs) return
      const now = Date.now()
      if (now - resyncAt < 2_000) return
      resyncAt = now
      seededRef.current = false
      void reloadRef
        .current({ tape: true })
        .then(() => {
          if (!seededRef.current && seedRef.current && chartRef.current) applySeed(chartRef.current)
        })
        .catch(() => {
          if (seedRef.current && chartRef.current) applySeed(chartRef.current)
        })
    }

    function sendProbe(current: WebSocket, wakeProbe: boolean) {
      const t = Date.now()
      try {
        current.send(lagProbe(t))
      } catch {
        connect()
        return
      }
      if (socket !== current) return
      probeRef.current = wakeProbe ? noteWakeProbe(probeRef.current, t) : noteProbeSent(probeRef.current, t)
    }

    function connect() {
      if (stopped) return
      window.clearTimeout(retry)
      retryPendingRef.current = false
      generation += 1
      const gen = generation
      if (socket) detach(socket)
      socket = null
      socketRef.current = null
      lagRef.current = createLag()
      probeRef.current = createProbe()
      openedAtRef.current = null
      connectingSinceRef.current = Date.now()
      const protocol = location.protocol === "https:" ? "wss" : "ws"
      let current: WebSocket
      try {
        current = new WebSocket(`${protocol}://${location.host}/ws`)
      } catch {
        retryPendingRef.current = true
        retry = window.setTimeout(() => {
          retryPendingRef.current = false
          connect()
        }, 400)
        return
      }
      socket = current
      socketRef.current = current
      current.onopen = () => {
        if (gen !== generation || socket !== current) return
        resync()
        openedAtRef.current = Date.now()
        connectingSinceRef.current = null
        sendProbe(current, false)
      }
      current.onmessage = (event) => {
        if (gen !== generation || socket !== current) return
        const arrival = Date.now()
        lastInboundRef.current = arrival
        probeRef.current = noteProbeInbound(probeRef.current)
        const message = JSON.parse(String(event.data)) as
          | { type: "tick"; price: string; exchangeTs: number; serverNow: number; feed: "live" | "stale" }
          | { type: "round"; serverNow: number; feed: "live" | "stale"; board: Board; ticker?: Ticker; handoff?: Handoff | null }
          | { type: "lag" }
          | SettledMessage
        if (message.type === "lag") {
          const echo = readEcho(message)
          if (echo) {
            lagRef.current = noteEcho(lagRef.current, echo, arrival)
            noteServerNow(echo.serverNow)
          }
          return
        }
        if ("serverNow" in message) {
          noteServerNow(message.serverNow)
          lagRef.current = noteDown(lagRef.current, message.serverNow, arrival)
        }
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
          const balance = address ? message.balances.find((row) => row.address === address) : null
          setYou((row) => {
            if (!row) return row
            const next = {
              ...row,
              balanceMicros: balance?.balanceMicros ?? row.balanceMicros,
              openBuyIns: row.openBuyIns.filter((bet) => bet.roundId !== message.roundId),
            }
            youEpoch.current += 1
            writeCachedBalance(next)
            return next
          })
          if (address) setNoticeState((state) => settleNotice(state, message, address, arrival))
          setHistoryVersion((value) => value + 1)
        }
      }
      current.onclose = () => {
        if (gen !== generation) return
        if (socket === current) {
          socket = null
          socketRef.current = null
          openedAtRef.current = null
          connectingSinceRef.current = null
        }
        if (stopped) return
        retryPendingRef.current = true
        retry = window.setTimeout(() => {
          retryPendingRef.current = false
          connect()
        }, 400)
      }
    }

    function wake() {
      if (stopped) return
      const now = Date.now()
      if (now - wokeAt < 50) return
      wokeAt = now
      probeRef.current = noteHidden(probeRef.current)
      setPulse((value) => value + 1)
      const action = wakeAction({
        phase: socketPhase(socket ? socket.readyState : null),
        lastInboundAt: lastInboundRef.current,
        openedAt: openedAtRef.current,
        now,
        connectingSince: connectingSinceRef.current,
      })
      if (action === "replace") {
        connect()
        return
      }
      const hole = silenceMs(lastInboundRef.current, openedAtRef.current, now)
      const viewMs = Math.max(1_000, configRef.current.viewSeconds * 1000)
      if (hole != null && hole >= viewMs) resync()
      if (action === "probe" && socket && socket.readyState === WebSocket.OPEN) sendProbe(socket, true)
    }

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        probeRef.current = noteHidden(probeRef.current)
        return
      }
      wake()
    }
    const onResume: EventListener = () => wake()

    replaceRef.current = connect
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", wake)
    window.addEventListener("online", wake)
    ;(document as EventTarget).addEventListener("resume", onResume)
    connect()
    return () => {
      stopped = true
      generation += 1
      window.clearTimeout(retry)
      retryPendingRef.current = false
      replaceRef.current = () => {}
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", wake)
      window.removeEventListener("online", wake)
      ;(document as EventTarget).removeEventListener("resume", onResume)
      if (socket) detach(socket)
      socketRef.current = null
      connectingSinceRef.current = null
    }
  }, [pushTick, noteServerNow])

  const openKey = you?.openBuyIns.map((bet) => bet.roundId).join(",") ?? ""
  const caught = useRef("")
  useEffect(() => {
    if (!token || !board || !you?.openBuyIns.length) return
    const live = new Set<number>()
    if (board.live) live.add(board.live.id)
    if (board.join) live.add(board.join.id)
    const stuck = you.openBuyIns
      .filter((bet) => !live.has(bet.roundId))
      .map((bet) => bet.roundId)
      .join(",")
    if (!stuck || caught.current === stuck) return
    caught.current = stuck
    reload().catch(() => {})
  }, [token, board, openKey, you?.openBuyIns, reload])

  const pushLate = useCallback(() => {
    setLateNotices((current) => (current.length > 0 ? current : [1]))
  }, [])

  /** Dynamic check: recompute link + feed at call time so a socket that died
   * after render still blocks the attempt. Returns an English error or null. */
  const connectionErrorNow = useCallback((): string | null => {
    const live = linkStatus(
      lagRef.current,
      Date.now(),
      socketRef.current?.readyState === WebSocket.OPEN,
      lastInboundRef.current,
      openedAtRef.current,
    )
    const state = connectionState(live, feedRef.current)
    if (!state.blocked) return null
    return state.reason === "delayed" ? "Price feed is delayed" : "Reconnecting to the market"
  }, [])

  const place = useCallback(
    async (side: Side, stake: string, roundId: number) => {
      if (!confirmedRef.current || !tokenRef.current || betLock.current) return
      const offline = connectionErrorNow()
      if (offline) {
        setError(offline)
        return
      }
      // The id is the market painted with this click. A clock that has already
      // crossed still posts it. The server rejects a window that is not open.
      if (!Number.isSafeInteger(roundId) || roundId < 0) return
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
      const windowMs = configRef.current.windowSeconds * 1000
      const openAt = roundId * windowMs
      const now = Date.now() + offsetRef.current
      const windowOpen = windowMs > 0 && now >= openAt && now < openAt + windowMs
      betLock.current = true
      const intent = ++betIntent.current
      const snapshot = current
      if (windowOpen) {
        youEpoch.current += 1
        setYou(applyBuyIn(current, { side, stakeMicros, roundId }))
      }
      setPending(true)
      setError(null)
      const stale = () => intent !== betIntent.current
      const restore = () => {
        if (!windowOpen) return
        youEpoch.current += 1
        setYou(snapshot)
      }
      try {
        const response = await fetch("/api/buy-ins", {
          method: "POST",
          headers: headers(tokenRef.current, true),
          body: JSON.stringify({ side, stake, roundId }),
        })
        const body = (await response.json()) as { error?: string; code?: string; you?: You; board?: Board }
        if (stale()) return
        if (response.status === 401) {
          restore()
          setUnauthorized(true)
          return
        }
        if (!response.ok) {
          restore()
          if (body.code === LATE_BUY_IN_CODE) {
            pushLate()
            return
          }
          setError(body.error ?? "Buy-in failed")
          return
        }
        if (body.you) acceptYou(body.you)
        if (body.board) setBoard(body.board)
      } catch {
        if (stale()) return
        restore()
        setError("Can't reach the market server")
      } finally {
        if (!stale()) {
          betLock.current = false
          setPending(false)
        }
      }
    },
    [acceptYou, pushLate, connectionErrorNow],
  )

  const claimGrant = useCallback(async (): Promise<
    | { ok: true; granted: boolean; pending: boolean; txHash: string | null; confirmations: number }
    | { ok: false; message: string; dropped: boolean; txHash: string | null }
  > => {
    if (!tokenRef.current) return { ok: false, message: "Sign in to receive a grant.", dropped: false, txHash: null }
    const offline = connectionErrorNow()
    if (offline) return { ok: false, message: offline, dropped: false, txHash: null }
    try {
      const response = await fetch("/api/grant", {
        method: "POST",
        headers: headers(tokenRef.current),
      })
      const body = (await response.json().catch(() => null)) as {
        error?: string
        granted?: boolean
        pending?: boolean
        txHash?: string
        confirmations?: number
        you?: You
      } | null
      if (body?.you) {
        acceptYou(body.you)
        markConfirmed(true)
      }
      const txHash = typeof body?.txHash === "string" && body.txHash.length > 0 ? body.txHash : null
      if (response.status === 401) {
        setUnauthorized(true)
        return { ok: false, message: "Sign in to receive a grant.", dropped: false, txHash }
      }
      if (!response.ok) return { ok: false, message: body?.error ?? "The grant did not land. Try again.", dropped: false, txHash }
      const confirmations =
        typeof body?.confirmations === "number" && body.confirmations > 0 ? body.confirmations : MINT_CONFIRMATIONS
      return {
        ok: true,
        granted: Boolean(body?.granted),
        pending: Boolean(body?.pending),
        txHash,
        confirmations,
      }
    } catch {
      return { ok: false, message: "Can't reach the market server", dropped: true, txHash: null }
    }
  }, [acceptYou, markConfirmed, connectionErrorNow])

  const waitForGrant = useCallback(
    async (beforeGrantAt: number | null) => {
      const start = Date.now()
      while (Date.now() - start < GRANT_FOLLOW_MS) {
        const next = await reload().catch(() => null)
        if (next && grantLanded(beforeGrantAt, next.grantAt)) return next
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      return null
    },
    [reload],
  )

  const withdrawWallet = useCallback(async (amount: string): Promise<string | null> => {
    if (!tokenRef.current) return "Connect a wallet first"
    const offline = connectionErrorNow()
    if (offline) return offline
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
  }, [acceptYou, connectionErrorNow])

  const now = Date.now() + offsetRef.current
  void pulse
  const link = linkStatus(
    lagRef.current,
    Date.now(),
    socketRef.current?.readyState === WebSocket.OPEN,
    lastInboundRef.current,
    openedAtRef.current,
  )
  const connection = connectionState(link, feed)
  const blocked = connection.blocked
  const slow = connection.slow

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
    notices: noticeState.cards,
    lateNotices,
    dismissNotice: useCallback((roundId: number) => {
      setNoticeState((state) => dismissRound(state, roundId))
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
    waitForGrant,
    withdrawWallet,
    reload,
    waitForBalance,
    bindChart,
    token,
    link,
    blocked,
    slow,
    connectionReason: connection.reason,
    connectionErrorNow,
  }
}
