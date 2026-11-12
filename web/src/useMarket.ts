import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { LATE_BUY_IN_CODE } from "../../shared/buyIn"
import { GRANT_FOLLOW_MS, MINT_CONFIRMATIONS } from "../../shared/mint"
import { writeCachedBalance } from "./balanceCache"
import { applyBuyIn } from "./buyInIntent"
import type { TapeChart, TapePoint } from "./chart"
import { createClock, easeClock, noteClock } from "./clock"
import { listedRoundIds } from "./focus"
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
  reconnectDelay,
  silenceMs,
  socketPhase,
  supervise,
  wakeAction,
} from "./lag"
import { parseAmountMicros } from "./format"
import { grantLanded } from "./grantWatch"
import { buyIsStuck, shouldReleaseStuckBuy, STUCK_BUY_MS } from "./stuckBuy"
import type { Handoff, Ticker } from "../../shared/source"
import { tickerFor } from "../../shared/source"
import { dismissRound, dueBuyIns, emptyNotices, settleNotice, tickNotices } from "./resultNotice"
import { applyBookPatch } from "./boardStream"
import { tapeLead } from "./tapeLead"
import type { AccountMessage, Board, Config, ServerStreamMessage, Side, SnapshotMessage, You } from "./types"
import { withChainQuery } from "./runtimeConfig"

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
  const chainKeyRef = useRef(initialConfig.chainKey)
  chainKeyRef.current = config.chainKey
  const api = useCallback((path: string) => withChainQuery(path, chainKeyRef.current), [])
  const feedRef = useRef<"live" | "stale">(feed)
  feedRef.current = feed
  const seedRef = useRef<TapePoint[] | null>(null)
  const bufferRef = useRef<TapePoint[]>([])
  const seededRef = useRef(false)
  const betLock = useRef(false)
  const releasingRef = useRef(false)
  const pendingBetRef = useRef<{
    requestId: string
    side: Side
    stake: string
    roundId: number
    token: string
    snapshot: You
    windowOpen: boolean
    sentAt: number
  } | null>(null)
  const sendBetRef = useRef<() => void>(() => {})
  const epochRef = useRef<string | null>(null)
  const seqRef = useRef(0)
  const needsSnapshotRef = useRef(false)
  const tapeRequestsRef = useRef(new Set<string>())
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
    youRef.current = next
    youEpoch.current += 1
    if (next) writeCachedBalance(next)
    setYou(next)
    return next
  }, [])

  const acceptAccount = useCallback(
    (message: Pick<AccountMessage, "you" | "unauthorized" | "result" | "results">) => {
      const outstanding = new Set(youRef.current?.openBuyIns.map((bet) => bet.roundId) ?? [])
      if (message.unauthorized) {
        setUnauthorized(true)
        acceptYou(null)
        markConfirmed(false)
        return
      }
      if (message.you) {
        acceptYou(message.you)
        markConfirmed(true)
      }
      const results = message.result
        ? [message.result]
        : (message.results ?? []).filter((result) => outstanding.has(result.roundId))
      if (results.length === 0) return
      const arrival = Date.now()
      setNoticeState((state) => results.reduce((next, result) => settleNotice(next, result, arrival), state))
      setHistoryVersion((value) => value + 1)
    },
    [acceptYou, markConfirmed],
  )

  const acceptSnapshot = useCallback(
    (message: SnapshotMessage) => {
      epochRef.current = message.epoch
      seqRef.current = message.seq
      needsSnapshotRef.current = false
      boardRef.current = message.board
      setBoard(message.board)
      setFeed(message.feed)
      setTicker(message.ticker)
      setHandoff(message.handoff)
      const points = readTape(message.tape)
      if (points) {
        const chart = chartRef.current
        if (chart && seededRef.current) chart.merge(points)
        else {
          seedRef.current = points
          if (chart) applySeed(chart)
        }
      }
      if ("you" in message) {
        acceptAccount({ you: message.you ?? null, results: message.results })
      }
    },
    [acceptAccount, applySeed],
  )

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
    const response = await fetch(api("/api/state"), { headers: headers(tokenRef.current), cache: "no-store" })
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

  // Drop a buy whose result will never arrive. The server account from this
  // reload is the position: the bet is in openBuyIns, or it is not.
  const recoverBuy = useCallback(async () => {
    if (releasingRef.current) return false
    if (!betLock.current && pendingBetRef.current == null) return false
    releasingRef.current = true
    const saved = pendingBetRef.current
    pendingBetRef.current = null
    try {
      await reload()
      if (!shouldReleaseStuckBuy({ pending: true, releaseRequested: true, serverYouApplied: true })) return false
      betLock.current = false
      setPending(false)
      return true
    } catch {
      if (pendingBetRef.current == null) pendingBetRef.current = saved
      return false
    } finally {
      releasingRef.current = false
    }
  }, [reload])
  const recoverBuyRef = useRef(recoverBuy)
  recoverBuyRef.current = recoverBuy

  const loadTape = useCallback(async (from: number, to: number) => {
    const chart = chartRef.current
    if (!chart || !chart.needsBefore(from) || !Number.isFinite(from) || !Number.isFinite(to)) return
    const start = Math.floor(from / 1_000) * 1_000
    const end = Math.ceil(to / 1_000) * 1_000
    const key = `${start}:${end}`
    if (tapeRequestsRef.current.has(key)) return
    tapeRequestsRef.current.add(key)
    try {
      const response = await fetch(api(`/api/tape?from=${start}&to=${end}`))
      if (!response.ok) return
      const points = readTape((await response.json()).tape)
      if (points) chartRef.current?.merge(points)
    } catch {
      return
    } finally {
      tapeRequestsRef.current.delete(key)
    }
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
    fetch(api("/api/state"), { headers: headers(token), cache: "no-store" })
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
    let snapshotWait = 0
    let generation = 0
    let failures = 0
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

    const scheduleRetry = () => {
      if (stopped) return
      retryPendingRef.current = true
      retry = window.setTimeout(() => {
        retryPendingRef.current = false
        connect()
      }, reconnectDelay(failures++))
    }

    const sendPending = (current: WebSocket) => {
      const bet = pendingBetRef.current
      if (!bet || current.readyState !== WebSocket.OPEN) return
      if (bet.token !== tokenRef.current) {
        pendingBetRef.current = null
        betLock.current = false
        setPending(false)
        return
      }
      try {
        current.send(JSON.stringify({
          type: "buy-in",
          requestId: bet.requestId,
          side: bet.side,
          stake: bet.stake,
          roundId: bet.roundId,
        }))
      } catch {
        connect()
      }
    }

    const requestSnapshot = () => {
      needsSnapshotRef.current = true
      const current = socketRef.current
      if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: "resync" }))
      else connect()
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
      window.clearTimeout(snapshotWait)
      retryPendingRef.current = false
      generation += 1
      const gen = generation
      if (socket) detach(socket)
      socket = null
      socketRef.current = null
      lagRef.current = createLag()
      probeRef.current = createProbe()
      openedAtRef.current = null
      needsSnapshotRef.current = true
      connectingSinceRef.current = Date.now()
      const protocol = location.protocol === "https:" ? "wss" : "ws"
      let current: WebSocket
      try {
        current = new WebSocket(`${protocol}://${location.host}${api("/ws")}`)
      } catch {
        scheduleRetry()
        return
      }
      socket = current
      socketRef.current = current
      current.onopen = () => {
        if (gen !== generation || socket !== current) return
        failures = 0
        openedAtRef.current = Date.now()
        connectingSinceRef.current = null
        current.send(JSON.stringify({ type: "hello", ...(tokenRef.current ? { token: tokenRef.current } : {}) }))
        sendPending(current)
        sendProbe(current, false)
        // The open snapshot is sent without a recover callback. If it was
        // coalesced away, ask again so later books are not dropped.
        window.clearTimeout(snapshotWait)
        snapshotWait = window.setTimeout(() => {
          if (gen !== generation || socket !== current || !needsSnapshotRef.current) return
          if (current.readyState !== WebSocket.OPEN) return
          try {
            current.send(JSON.stringify({ type: "resync" }))
          } catch {
            connect()
          }
        }, 1_000)
      }
      current.onmessage = (event) => {
        if (gen !== generation || socket !== current) return
        const arrival = Date.now()
        lastInboundRef.current = arrival
        probeRef.current = noteProbeInbound(probeRef.current)
        let message: ServerStreamMessage
        try {
          const parsed = JSON.parse(String(event.data)) as unknown
          if (!parsed || typeof parsed !== "object") {
            requestSnapshot()
            return
          }
          message = parsed as ServerStreamMessage
        } catch {
          requestSnapshot()
          return
        }
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
        if (message.type === "snapshot") {
          acceptSnapshot(message)
          return
        }
        if (message.type === "account") {
          acceptAccount(message)
          return
        }
        if (message.type === "buy-in-result") {
          const bet = pendingBetRef.current
          if (!bet || bet.requestId !== message.requestId) return
          pendingBetRef.current = null
          betLock.current = false
          setPending(false)
          if (message.ok && message.you) {
            acceptYou(message.you)
            markConfirmed(true)
            setError(null)
            return
          }
          if (bet.windowOpen) acceptYou(bet.snapshot)
          if (message.code === LATE_BUY_IN_CODE) setLateNotices((current) => (current.length > 0 ? current : [1]))
          else setError(message.error ?? "Buy-in failed")
          return
        }
        if (message.type === "tick" || message.type === "book") {
          const lead = tapeLead({
            type: message.type,
            needsSnapshot: needsSnapshotRef.current,
            epoch: epochRef.current,
            messageEpoch: message.epoch,
          })
          if (lead === "resync") {
            requestSnapshot()
            return
          }
          const inOrder = !needsSnapshotRef.current
          if (inOrder && (message.epoch !== epochRef.current || message.seq !== seqRef.current + 1)) {
            requestSnapshot()
            return
          }
          if (inOrder) seqRef.current = message.seq
          if (message.type === "tick") {
            setFeed(message.feed)
            pushTick(message.exchangeTs, message.price)
            return
          }
          setFeed(message.feed)
          setTicker(message.ticker)
          setHandoff(message.handoff)
          if (!inOrder) return
          const currentBoard = boardRef.current
          if (!currentBoard) {
            requestSnapshot()
            return
          }
          const next = applyBookPatch(currentBoard, message.board)
          boardRef.current = next
          setBoard(next)
          return
        }
        if (needsSnapshotRef.current) return
        if (message.epoch !== epochRef.current || message.seq !== seqRef.current + 1) {
          requestSnapshot()
          return
        }
        seqRef.current = message.seq
        if (message.type === "settled") setHistoryVersion((value) => value + 1)
      }
      current.onclose = () => {
        if (gen !== generation) return
        if (socket === current) {
          socket = null
          socketRef.current = null
          openedAtRef.current = null
          connectingSinceRef.current = null
        }
        scheduleRetry()
      }
    }

    let hiddenAt: number | null = null

    function wake(persisted: boolean) {
      if (stopped) return
      const now = Date.now()
      if (now - wokeAt < 50) return
      wokeAt = now
      probeRef.current = noteHidden(probeRef.current)
      setPulse((value) => value + 1)
      // A socket that stayed "open" across a hide is a zombie in Phantom's
      // webview. Replace it instead of probing a connection that will not answer.
      const openedBeforeHide = hiddenAt != null && openedAtRef.current != null && openedAtRef.current <= hiddenAt
      hiddenAt = null
      const action =
        persisted || openedBeforeHide
          ? "replace"
          : wakeAction({
              phase: socketPhase(socket ? socket.readyState : null),
              lastInboundAt: lastInboundRef.current,
              openedAt: openedAtRef.current,
              now,
              connectingSince: connectingSinceRef.current,
            })
      const recover = betLock.current || pendingBetRef.current != null
      if (recover) pendingBetRef.current = null
      if (action === "replace") connect()
      else {
        const hole = silenceMs(lastInboundRef.current, openedAtRef.current, now)
        if (hole != null && hole >= 5_000 && socket?.readyState === WebSocket.OPEN) requestSnapshot()
        if (action === "probe" && socket && socket.readyState === WebSocket.OPEN) sendProbe(socket, true)
      }
      void (recover ? recoverBuyRef.current() : reloadRef.current().catch(() => {}))
    }

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now()
        probeRef.current = noteHidden(probeRef.current)
        return
      }
      wake(false)
    }
    const onPageShow = (event: Event) => {
      wake(event instanceof PageTransitionEvent && event.persisted)
    }
    const onResume: EventListener = () => wake(false)

    sendBetRef.current = () => {
      if (socket?.readyState === WebSocket.OPEN) sendPending(socket)
    }
    replaceRef.current = connect
    const onOnline = () => wake(false)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
    window.addEventListener("online", onOnline)
    ;(document as EventTarget).addEventListener("resume", onResume)
    connect()
    return () => {
      stopped = true
      generation += 1
      window.clearTimeout(retry)
      window.clearTimeout(snapshotWait)
      retryPendingRef.current = false
      sendBetRef.current = () => {}
      replaceRef.current = () => {}
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
      window.removeEventListener("online", onOnline)
      ;(document as EventTarget).removeEventListener("resume", onResume)
      if (socket) detach(socket)
      socketRef.current = null
      connectingSinceRef.current = null
    }
  }, [pushTick, noteServerNow, token, acceptAccount, acceptSnapshot, acceptYou, markConfirmed])

  useEffect(() => {
    if (!pending) return
    const id = window.setTimeout(() => {
      void recoverBuyRef.current()
    }, STUCK_BUY_MS)
    return () => window.clearTimeout(id)
  }, [pending])

  const openKey = you?.openBuyIns.map((bet) => bet.roundId).join(",") ?? ""
  const caught = useRef("")
  useEffect(() => {
    if (!token || !board || !you?.openBuyIns.length) {
      if (!you?.openBuyIns.length) caught.current = ""
      return
    }
    const synced = Date.now() + offsetRef.current
    const live = new Set(listedRoundIds(board, synced))
    const stuck = you.openBuyIns
      .filter((bet) => !live.has(bet.roundId))
      .map((bet) => bet.roundId)
      .join(",")
    if (!stuck) {
      caught.current = ""
      return
    }
    if (caught.current === stuck) return
    caught.current = stuck
    reload().catch(() => {})
  }, [token, board, openKey, you?.openBuyIns, reload, pulse])

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
      const token = tokenRef.current
      if (!confirmedRef.current || !token) return
      if (betLock.current || pendingBetRef.current) {
        const bet = pendingBetRef.current
        const stuck = buyIsStuck({
          pending: true,
          sentAt: bet?.sentAt ?? null,
          now: Date.now(),
          socketOpen: socketRef.current?.readyState === WebSocket.OPEN,
        })
        if (!stuck) return
        if (!(await recoverBuy())) return
      }
      const offline = connectionErrorNow()
      if (offline) {
        setError(offline)
        return
      }
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
      pendingBetRef.current = {
        requestId: crypto.randomUUID(),
        side,
        stake,
        roundId,
        token,
        snapshot: current,
        windowOpen,
        sentAt: Date.now(),
      }
      if (windowOpen) acceptYou(applyBuyIn(current, { side, stakeMicros, roundId }))
      setPending(true)
      setError(null)
      sendBetRef.current()
    },
    [acceptYou, connectionErrorNow, recoverBuy],
  )

  const claimGrant = useCallback(async (): Promise<
    | { ok: true; granted: boolean; pending: boolean; txHash: string | null; confirmations: number }
    | { ok: false; message: string; dropped: boolean; txHash: string | null }
  > => {
    if (!tokenRef.current) return { ok: false, message: "Sign in to receive a grant.", dropped: false, txHash: null }
    const offline = connectionErrorNow()
    if (offline) return { ok: false, message: offline, dropped: false, txHash: null }
    try {
      const response = await fetch(api("/api/grant"), {
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
        // The grant account is the balance to spend. A lost buy result must
        // not keep the buttons disabled after the credit lands.
        if (shouldReleaseStuckBuy({ pending: betLock.current || pendingBetRef.current != null, releaseRequested: true, serverYouApplied: true })) {
          pendingBetRef.current = null
          betLock.current = false
          setPending(false)
        }
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
        if (next && grantLanded(beforeGrantAt, next.grantAt)) {
          if (shouldReleaseStuckBuy({ pending: betLock.current || pendingBetRef.current != null, releaseRequested: true, serverYouApplied: true })) {
            pendingBetRef.current = null
            betLock.current = false
            setPending(false)
          }
          return next
        }
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
      const response = await fetch(api("/api/withdraw"), {
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
  const [seenLive, setSeenLive] = useState(false)
  const wasBlockedRef = useRef(false)
  useEffect(() => {
    if (!blocked) setSeenLive(true)
  }, [blocked])
  useEffect(() => {
    const wasBlocked = wasBlockedRef.current
    wasBlockedRef.current = blocked
    if (!wasBlocked || blocked) return
    const current = boardRef.current
    if (!current) return
    const synced = Date.now() + offsetRef.current
    if (current.windowEndsAt > synced) return
    reload().catch(() => {})
  }, [blocked, reload])

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
    loadTape,
    bindChart,
    token,
    link,
    blocked,
    seenLive,
    slow,
    connectionReason: connection.reason,
    connectionErrorNow,
  }
}
