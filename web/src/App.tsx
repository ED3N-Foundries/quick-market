import { Children, isValidElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react"
import type { Lang } from "../../shared/lang"
import { reportLines, type TreasuryReport } from "../../shared/near"
import { MINT_CONFIRMATIONS } from "../../shared/mint"
import { mountChart, priceY, type ChartScale, type TapeChart, type TapeSample } from "./chart"
import { chartMarket, focusPool, followWindow, heldMarket, heldStrike } from "./focus"
import {
  chainBadgeText,
  chainMenuLabel,
  chainNetworkLabel,
  formatClock,
  formatDollarMove,
  formatMoney,
  formatReturn,
  formatPrice,
  formatSigned,
  formatGrantDollars,
  handoffBanner,
  grantButtonLabel,
  grantNextLabel,
  grantSentence,
  grantStatusLabel,
  grantTiming,
  isTestnetChain,
  microsToInput,
  moneyShare,
  parseAmountMicros,
  payoutMicros,
  quoteDollar,
  quotePair,
  shortAddress,
  sourceLabel,
  walletDisplayLabel,
} from "./format"
import { placePricePops, pricePopText, type PlacedPop, type PopRect } from "./pricePop"
import { RESULT_MS, SETTLING_MS, type MarketNotice } from "./resultNotice"
import type { Band, Board, Config, HistoryRound, OpenBuyIn, Side, TrayRow } from "./types"
import { readCachedBalance, visibleBalance } from "./balanceCache"
import { TestnetBrief } from "./testnetBriefView"
import { briefDue, readBriefAt, writeBriefAt } from "./testnetBrief"
import { BALANCE_MS, balanceStep } from "./balanceMotion"
import { readGrantConfirmations } from "./grantChain"
import { grantLanded, grantTxUrl } from "./grantWatch"
import { copy, localize, type Copy } from "./copy"
import { LanguageSelect, useI18n } from "./i18n"
import { formatLag, lagButtonName, type LinkStatus } from "./lag"
import { useMarket } from "./useMarket"
import { FeedBadge } from "./venues"
import { prefersReducedMotion } from "./sideFigures"
import { useSideBook } from "./useSideBook"
import { grantWaitStatus, loginStatus, shortWalletFault, SIGN_PROMPT } from "./phantomConnect"
import { ChainLogo, NearLogo, PhantomLogo } from "./logos"
import { ToastStack, useToasts } from "./toasts"
import { useSession } from "./wallet"

export function App({ initialConfig }: { initialConfig: Config }) {
  const { lang, text } = useI18n()
  const langRef = useRef(lang)
  langRef.current = lang
  const session = useSession()
  const market = useMarket(session.token, session.signedYou, initialConfig)
  const expireRef = useRef(session.expire)
  expireRef.current = session.expire
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const walletMenuRef = useRef<HTMLSpanElement>(null)
  const viewRef = useRef({ follow: true, start: 0, end: 0 })
  const viewSecondsRef = useRef(market.config.viewSeconds)
  const handoffRef = useRef(market.handoff)
  const boardRef = useRef(market.board)
  const openBuyInsRef = useRef<OpenBuyIn[]>([])
  const [chart, setChart] = useState<TapeChart | null>(null)
  const [stake, setStake] = useState("10")
  const [windowTick, setWindowTick] = useState(0)
  const [walletMenuOpen, setWalletMenuOpen] = useState(false)
  const [fundAmount, setFundAmount] = useState("")
  const [fundOpen, setFundOpen] = useState(false)
  const [fundError, setFundError] = useState<string | null>(null)
  const [funding, setFunding] = useState(false)
  const [grantTx, setGrantTx] = useState<string | null>(null)
  const [grantSeen, setGrantSeen] = useState(0)
  const [grantNeeded, setGrantNeeded] = useState(MINT_CONFIRMATIONS)
  const [fundPhase, setFundPhase] = useState<"idle" | "phantom" | "confirming" | "pending">("idle")
  const [fundHash, setFundHash] = useState<string | null>(null)
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [treasuryReport, setTreasuryReport] = useState<TreasuryReport | null>(null)
  const [following, setFollowing] = useState(true)
  const [briefOpen, setBriefOpen] = useState(false)
  const briefChecked = useRef(false)
  const scrub = useScrub(chart)
  const { toasts, upsert: upsertToast, dismiss: dismissToast } = useToasts()
  // Short inline mark + transient toast share one source: the full detail lives
  // in the mark's popover, so nothing below the button ever resizes.
  const connectRawError =
    session.connectError ??
    (!session.token && session.signError && session.signError !== SIGN_PROMPT ? session.signError : null)
  boardRef.current = market.board
  openBuyInsRef.current = market.you?.openBuyIns ?? []
  viewSecondsRef.current = market.config.viewSeconds
  const handoff = market.handoff
  handoffRef.current = handoff

  useEffect(() => {
    if (market.unauthorized) expireRef.current()
  }, [market.unauthorized])

  useEffect(() => {
    if (!session.address) setWalletMenuOpen(false)
  }, [session.address])

  const followHash = market.you?.grantPending?.txHash || (funding ? grantTx : null)
  useEffect(() => {
    if (market.config.chainKey !== "near-testnet") return
    let cancel = false
    const tick = () => {
      void fetch("/api/health")
        .then((response) => response.json())
        .then((body: { treasury?: TreasuryReport | null }) => {
          if (!cancel) setTreasuryReport(body.treasury ?? null)
        })
        .catch(() => {
          if (!cancel) setTreasuryReport(null)
        })
    }
    tick()
    const id = window.setInterval(tick, 15_000)
    return () => {
      cancel = true
      window.clearInterval(id)
    }
  }, [market.config.chainKey])
  useEffect(() => {
    if (!followHash) return
    if (market.config.chainKey === "near-testnet") {
      setGrantSeen(MINT_CONFIRMATIONS)
      return
    }
    let cancel = false
    setGrantSeen(0)
    const tick = () => {
      void readGrantConfirmations(followHash, market.config.chainId).then((seen) => {
        if (!cancel) setGrantSeen((current) => Math.max(current, seen))
      })
    }
    tick()
    const id = window.setInterval(tick, 1_000)
    return () => {
      cancel = true
      window.clearInterval(id)
    }
  }, [followHash, market.config.chainId, market.config.chainKey])

  const grantWatch = useRef<{ grantAt: number | null } | null>(null)
  useEffect(() => {
    const current = market.you
    if (!current) {
      grantWatch.current = null
      return
    }
    if (current.grantPending) {
      grantWatch.current = { grantAt: current.grantAt }
      return
    }
    const watched = grantWatch.current
    if (!watched) return
    grantWatch.current = null
    setFunding(false)
    if (grantLanded(watched.grantAt, current.grantAt)) {
      setGrantTx(null)
      setFundError(null)
      setFundOpen(false)
      upsertToast({ id: "grant-ok", kind: "ok", text: text.grantedToast })
      return
    }
    setGrantTx(null)
    upsertToast({ id: "grant-error", kind: "error", text: text.grantMissed })
  }, [market.you, text, upsertToast])

  // A connect failure toasts once, then lives on as the ⓘ mark next to the
  // button. Retrying clears the session error, which re-arms the toast.
  const toastedConnectError = useRef<string | null>(null)
  useEffect(() => {
    if (!connectRawError) {
      toastedConnectError.current = null
      return
    }
    if (connectRawError === toastedConnectError.current) return
    toastedConnectError.current = connectRawError
    upsertToast({ id: "wallet-error", kind: "error", text: localize(lang, shortWalletFault(connectRawError)) })
  }, [connectRawError, lang, upsertToast])

  useEffect(() => {
    if (!walletMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (walletMenuRef.current && !walletMenuRef.current.contains(event.target as Node)) {
        setWalletMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWalletMenuOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [walletMenuOpen])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const next = mountChart(canvas, {
      getNow: () => Date.now() + market.offsetRef.current,
      getView: () => {
        const board = boardRef.current
        if (board && chartMarket(board, openBuyInsRef.current, Date.now() + market.offsetRef.current)) {
          return { follow: true, start: 0, end: 0 }
        }
        return viewRef.current
      },
      getClock: () => {
        const board = boardRef.current
        if (!board) return null
        const now = Date.now() + market.offsetRef.current
        const frame = followWindow(board, openBuyInsRef.current, now, (viewSecondsRef.current || 5) * 1000)
        return { blockStart: frame.start, blockEnd: frame.end }
      },
      getStrike: () => {
        const board = boardRef.current
        if (!board) return null
        const now = Date.now() + market.offsetRef.current
        const riding = chartMarket(board, openBuyInsRef.current, now)
        const strike = heldStrike(riding)
        if (!strike || !riding) return null
        return { ...strike, peg: true, at: riding.strikeAt, openAt: riding.buyInOpen }
      },
      getAim: () => {
        const board = boardRef.current
        if (!board) return null
        const now = Date.now() + market.offsetRef.current
        const held = heldMarket(board, openBuyInsRef.current, now)
        if (!held) return null
        return openBuyInsRef.current.find((bet) => bet.roundId === held.id)?.side ?? null
      },
      extendLive: () => handoffRef.current == null,
      getLocale: () => langRef.current,
      onHead: (text) => {
        market.priceRef.current = text
      },
    })
    chartRef.current = next
    setChart(next)
    market.bindChart(next)
    return () => {
      next.destroy()
      chartRef.current = null
      setChart(null)
      market.bindChart(null)
    }
  }, [market.bindChart, market.offsetRef])

  const balanceMark = useRef<HTMLParagraphElement>(null)
  const board = market.board
  const you = market.you
  const cached = session.token && session.address ? readCachedBalance(session.address) : null
  const shownMicros = visibleBalance(market.confirmed, you?.balanceMicros ?? null, cached?.balanceMicros ?? null)
  const openBuyIns = you?.openBuyIns ?? []
  const now = Date.now() + market.offsetRef.current
  void windowTick
  useEffect(() => {
    if (!board) return
    const left = board.windowEndsAt - (Date.now() + market.offsetRef.current)
    if (left <= 0) return
    const id = window.setTimeout(() => setWindowTick(board.windowEndsAt), left)
    return () => window.clearTimeout(id)
  }, [board, market.offsetRef])
  const rideChart = board ? chartMarket(board, openBuyIns, now) : null
  useEffect(() => {
    if (!rideChart) return
    viewRef.current = { follow: true, start: 0, end: 0 }
    setFollowing(true)
  }, [rideChart])
  useEffect(() => {
    const eligible =
      (market.config.tokenKind === "qm" || isTestnetChain(market.config.chainId)) &&
      market.config.grantMicros > 0 &&
      market.config.grantIntervalMs > 0
    if (briefChecked.current || !eligible) return
    briefChecked.current = true
    if (briefDue(readBriefAt(), Date.now())) setBriefOpen(true)
  }, [market.config.tokenKind, market.config.chainId, market.config.grantMicros, market.config.grantIntervalMs])
  const heldSpan = board ? heldMarket(board, openBuyIns, now) : null
  const focus = focusPool(board, openBuyIns, now)
  const total = (focus?.poolUpMicros ?? 0) + (focus?.poolDownMicros ?? 0)
  const held = openBuyIns.find((bet) => bet.roundId === focus?.id) ?? null
  const upQuote = focus ? quoteDollar("up", focus.poolUpMicros, focus.poolDownMicros, market.config.feeBps, lang) : "—"
  const downQuote = focus ? quoteDollar("down", focus.poolUpMicros, focus.poolDownMicros, market.config.feeBps, lang) : "—"
  const figures = useSideBook({
    roundId: focus?.id ?? null,
    upShare: moneyShare(focus?.poolUpMicros ?? 0, total),
    downShare: moneyShare(focus?.poolDownMicros ?? 0, total),
    upPool: focus?.poolUpMicros ?? 0,
    downPool: focus?.poolDownMicros ?? 0,
    upPlayers: focus?.playersUp ?? 0,
    downPlayers: focus?.playersDown ?? 0,
    upQuote,
    downQuote,
  })
  const betRoundId = figures.book.roundId
  const reconnecting = market.blocked
  const degraded = market.slow
  const canBet =
    market.confirmed &&
    !!you &&
    !heldSpan &&
    betRoundId !== null &&
    market.feed === "live" &&
    !market.pending &&
    !handoff &&
    !reconnecting
  const ticketWin = held ? payoutMicros(held.stakeMicros, held.side, focus?.poolUpMicros ?? 0, focus?.poolDownMicros ?? 0, market.config.feeBps) : 0
  const fundMicros = parseAmountMicros(fundAmount)
  const testnet = market.config.tokenKind === "qm" || isTestnetChain(market.config.chainId)
  const grantKnown = market.confirmed ? you !== null : cached !== null
  const grantAt = market.confirmed ? (you?.grantAt ?? null) : (cached?.grantAt ?? null)
  const grantWait = grantTiming(grantAt, now, market.config.grantIntervalMs)
  const grantPending = you?.grantPending ?? null
  const grantInFlight = funding || grantPending !== null
  const holdStake = session.signing || grantPending !== null
  const isNearChain = market.config.chainKey === "near-testnet"
  // Minting status lives in a toast with a clickable confirmation link, so the
  // stake column never resizes while a grant is in flight.
  useEffect(() => {
    const active = grantPending !== null || (testnet && funding)
    if (!active) {
      dismissToast("grant")
      return
    }
    const txHash = grantPending?.txHash || grantTx
    upsertToast({
      id: "grant",
      kind: "progress",
      text: txHash
        ? grantWaitStatus({ seen: grantSeen, needed: grantPending?.confirmations ?? grantNeeded }, lang, market.config.chainKey)
        : grantWaitStatus(undefined, lang, market.config.chainKey),
      txHash,
      txUrl: txHash ? grantTxUrl(market.config.chainId, txHash, market.config.chainKey) : null,
    })
  }, [
    grantPending,
    testnet,
    funding,
    grantTx,
    grantSeen,
    grantNeeded,
    lang,
    market.config.chainId,
    market.config.chainKey,
    upsertToast,
    dismissToast,
  ])
  const wrongChain =
    session.address !== null && session.chainId !== undefined && session.chainId !== market.config.chainId
  const walletTone = wrongChain || session.signing ? "warn" : "ok"
  const loginLabel =
    !session.address && session.connectMode === "deeplink"
      ? text.openInPhantom
      : isNearChain
        ? text.connectNear
        : text.connectPhantom

  async function onWithdraw() {
    if (withdrawing) return
    setWithdrawing(true)
    setWithdrawError(null)
    const message = await market.withdrawWallet(withdrawAmount)
    setWithdrawing(false)
    if (message) {
      setWithdrawError(message)
      return
    }
    setWithdrawError(null)
    setWithdrawAmount("")
    setWithdrawOpen(false)
  }

  function chip(percent: number) {
    if (!you) return
    setStake(microsToInput(Math.max(market.config.minStakeMicros, Math.floor((you.balanceMicros * percent) / 100))))
  }

  function openGrant() {
    setWalletMenuOpen(false)
    setFundError(null)
    if (market.blocked) {
      setFundError("Reconnecting to the market")
      return
    }
    setFundOpen(true)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (handoffRef.current || market.blocked) return
    const riding = boardRef.current
    if (riding && chartMarket(riding, openBuyInsRef.current, Date.now() + market.offsetRef.current)) return
    const current = chartRef.current?.getScale()
    if (!current || event.button !== 0) return
    scrub.clear()
    const originX = event.clientX
    const origin = { start: current.viewStart, end: current.viewEnd, width: current.plotWidth }
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (ev: PointerEvent) => {
      const span = origin.end - origin.start
      const shift = (-(ev.clientX - originX) / origin.width) * span
      viewRef.current = { follow: false, start: origin.start + shift, end: origin.end + shift }
      void market.loadTape(viewRef.current.start, viewRef.current.end)
      setFollowing(false)
    }
    const up = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark">
            <span className="logomark" aria-hidden="true">😭</span>
            Quick Market
          </span>
          {(reconnecting || degraded) && (
            <LinkQualityBadge link={market.link} blocked={reconnecting} />
          )}
        </div>
        <div className="clock-cluster" data-move={heldSpan?.strike ? "1" : "0"}>
          <PriceReadout
            priceRef={market.priceRef}
            strike={heldSpan?.strike ?? null}
            pair={quotePair(market.ticker.venue)}
            pairTitle={market.ticker.label || sourceLabel(market.ticker.venue, lang)}
            venue={market.ticker.venue}
          />
          <div className="clock-block">
            <span className="clock-label">{handoff ? text.opens : heldSpan ? text.settles : text.buyIn}</span>
            {handoff?.resumeAt ? (
              <Countdown endsAt={handoff.resumeAt} offsetRef={market.offsetRef} />
            ) : board && !handoff ? (
              <Countdown endsAt={heldSpan ? heldSpan.settlesAt : board.windowEndsAt} offsetRef={market.offsetRef} />
            ) : (
              <span className="clock-line">
                <strong className="clock">—</strong>
              </span>
            )}
          </div>
        </div>
      </header>
      {treasuryReport && !treasuryReport.ok && (
        <p className="note warn">{reportLines(treasuryReport, text.nearReport).join(" · ")}</p>
      )}
      {session.chainError && <p className="note bad">{localize(lang, session.chainError)}</p>}
      {session.pageChain && market.config.treasury && market.config.chainId !== session.pageChain.id && (
        <p className="note bad">{text.pageChain(session.pageChain.name, market.config.chainName)}</p>
      )}

      <section
        className="chart-wrap"
        data-loading={handoff || reconnecting ? "1" : undefined}
        aria-busy={handoff || reconnecting ? true : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          if (handoffRef.current || reconnecting) return
          scrub.move(event)
        }}
        onPointerLeave={scrub.clear}
      >
        <canvas ref={canvasRef} />
        {chart && !handoff && !reconnecting && (
          <ChartOverlay
            chart={chart}
            board={board}
            openBuyIns={openBuyIns}
            feeBps={market.config.feeBps}
            hover={scrub.hover}
            offsetRef={market.offsetRef}
          />
        )}
        {(handoff || reconnecting) && (
          <div className="chart-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        )}
        {handoff && (
          <p className="handoff-banner">
            {handoff.to && <span className="handoff-kicker">{text.switching}</span>}
            <span>{handoffBanner(handoff.from, handoff.to, lang)}</span>
          </p>
        )}
        {reconnecting && !handoff && (
          <p className="reconnect-banner" role="status">
            <span className="wait-spin" aria-hidden="true" />
            <span className="reconnect-title">{text.reconnectingMarket}</span>
            <span className="reconnect-sub">
              {text.reconnectingHint} {text.roundTrip} {formatLag(market.link.rttMs)}
            </span>
          </p>
        )}
        {market.feed === "stale" && !handoff && !reconnecting && <p className="feed-flag">{text.priceDelayed}</p>}
        {degraded && !reconnecting && !handoff && (
          <p className="feed-flag" data-tone="slow">
            {text.slow} · ↑ {formatLag(market.link.upMs)} ↓ {formatLag(market.link.downMs)}
          </p>
        )}
        {!following && !rideChart && !reconnecting && (
          <button
            type="button"
            className="now-jump"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              viewRef.current = { follow: true, start: 0, end: 0 }
              setFollowing(true)
            }}
          >
            {text.now}
          </button>
        )}
      </section>

      <section className="trade">
        <SideCard
          side="up"
          share={figures.book.upShare}
          pool={figures.book.upPool}
          quote={figures.book.upQuote}
          orders={figures.book.upPlayers}
          fade={figures.fade}
          fadeKey={figures.gen}
          disabled={!canBet}
          onBet={() => {
            if (betRoundId === null) return
            void market.place("up", stake, betRoundId)
          }}
        />
        <div className="stake">
          <div className="balance-label">
            <TokenBadge kind={testnet ? "qm" : "circle"} chainKey={market.config.chainKey} />
            {!session.token || !session.address ? (
              <span className="who" ref={session.address ? walletMenuRef : undefined}>
                {session.address && (
                  <>
                    <button
                      type="button"
                      className="wallet-pill"
                      data-open={walletMenuOpen ? "1" : "0"}
                      title={session.address}
                      aria-label={text.walletMenu}
                      aria-expanded={walletMenuOpen}
                      aria-haspopup="menu"
                      onClick={() => setWalletMenuOpen((open) => !open)}
                    >
                      <span className="wallet-dot" data-tone="warn" aria-hidden="true" />
                      <span className="wallet-name">{walletDisplayLabel(session.address, session.label)}</span>
                      <span className="wallet-caret" aria-hidden="true">▾</span>
                    </button>
                    {walletMenuOpen && (
                      <div className="wallet-menu" role="menu">
                        {session.label && <p className="wallet-menu-label">{session.label}</p>}
                        <p className="wallet-menu-addr" title={session.address}>
                          {session.address}
                        </p>
                        <div className="wallet-menu-actions">
                          <button
                            type="button"
                            onClick={() => {
                              setWalletMenuOpen(false)
                              session.disconnect()
                            }}
                          >
                            {text.disconnect}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="primary connect-pill"
                  data-busy={session.signing ? "1" : "0"}
                  title={session.chainError ?? undefined}
                  onClick={session.login}
                  disabled={session.signing || session.chainError !== null}
                >
                  {session.signing && session.loginPhase ? (
                    <>
                      <span className="wait-spin" aria-hidden="true" />
                      <span
                        key={session.loginPhase}
                        className="connect-label"
                        role="status"
                        title={loginStatus(session.loginPhase, testnet, lang, market.config.chainKey)}
                      >
                        {loginStatus(session.loginPhase, testnet, lang, market.config.chainKey)}
                      </span>
                    </>
                  ) : (
                    <>
                      {isNearChain ? (
                        <NearLogo className="logo-mark" />
                      ) : (
                        <PhantomLogo className="logo-mark" />
                      )}
                      <span className="connect-label">{loginLabel}</span>
                    </>
                  )}
                </button>
                {connectRawError && (
                  <ErrorDot short={shortWalletFault(connectRawError)} detail={connectRawError} />
                )}
              </span>
            ) : (
              <span className="who" ref={walletMenuRef}>
                <button
                  type="button"
                  className="wallet-pill"
                  data-open={walletMenuOpen ? "1" : "0"}
                  title={session.address}
                  aria-label={text.walletMenu}
                  aria-expanded={walletMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setWalletMenuOpen((open) => !open)}
                >
                  <span className="wallet-dot" data-tone={walletTone} aria-hidden="true" />
                  <span className="wallet-name">{walletDisplayLabel(session.address, session.label)}</span>
                  <span className="wallet-caret" aria-hidden="true">▾</span>
                  <span className="addr-tip" role="tooltip">
                    {session.address}
                  </span>
                </button>
                {session.connectError && (
                  <ErrorDot short={shortWalletFault(session.connectError)} detail={session.connectError} />
                )}
                {walletMenuOpen && (
                  <div className="wallet-menu" role="menu">
                    {session.label && <p className="wallet-menu-label">{session.label}</p>}
                    <p className="wallet-menu-addr" title={session.address}>
                      {session.address}
                    </p>
                    <div className="wallet-menu-net">
                      <span className="net-badge" data-testnet={isTestnetChain(market.config.chainId, market.config.chainKey) ? "1" : "0"}>
                        <ChainLogo chainKey={market.config.chainKey} className="chain-mark" />
                        {session.signing ? text.pleaseWait : chainMenuLabel(market.config.chainId, market.config.chainName, lang, market.config.chainKey)}
                      </span>
                      {wrongChain && market.config.chainKey !== "near-testnet" && (
                        <button type="button" className="plain net-action" onClick={session.switchChain}>
                          {text.switchNetwork}
                        </button>
                      )}
                    </div>
                    <div className="wallet-menu-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setWalletMenuOpen(false)
                          setWithdrawError(null)
                          if (market.blocked) {
                            setWithdrawError("Reconnecting to the market")
                            setWithdrawOpen(true)
                            return
                          }
                          setWithdrawOpen(true)
                        }}
                        disabled={!you}
                        title={reconnecting ? text.reconnectingMarket : undefined}
                      >
                        {text.withdraw}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setWalletMenuOpen(false)
                          session.disconnect()
                        }}
                      >
                        {text.disconnect}
                      </button>
                    </div>
                  </div>
                )}
              </span>
            )}
          </div>
          <BalanceFigure micros={shownMicros} markRef={balanceMark} />
          {!holdStake && testnet && market.config.grantIntervalMs > 0 && grantKnown &&
            (grantWait.due ? (
              <button
                type="button"
                className="grant-status"
                onClick={openGrant}
                disabled={!session.token || grantInFlight || reconnecting}
                title={reconnecting ? text.reconnectingMarket : undefined}
              >
                {grantStatusLabel(grantWait, market.config.grantMicros, lang)}
              </button>
            ) : (
              <p className="grant-status">{grantStatusLabel(grantWait, market.config.grantMicros, lang)}</p>
            ))}
          {reconnecting && (
            <p className="note warn" role="status">
              {text.reconnectingMarket} · {text.reconnectingHint}
            </p>
          )}
          {held && (
            <div className="ticket">
              <p className={held.side}>{held.side === "up" ? `▲ ${text.up}` : `▼ ${text.down}`}</p>
              <p>
                {text.amount} {formatMoney(held.stakeMicros)}
              </p>
              <p>
                {text.gets} {formatMoney(ticketWin)}
              </p>
            </div>
          )}
          {!holdStake && (
            <>
              <label className="stake-field">
                <span>{text.amount}</span>
                <input
                  inputMode="decimal"
                  value={stake}
                  onChange={(event) => setStake(event.target.value)}
                  disabled={!you || reconnecting}
                />
              </label>
              <div className="chips">
                <button type="button" onClick={() => chip(25)} disabled={!you || reconnecting}>
                  25%
                </button>
                <button type="button" onClick={() => chip(50)} disabled={!you || reconnecting}>
                  50%
                </button>
                <button type="button" onClick={() => chip(100)} disabled={!you || reconnecting}>
                  100%
                </button>
              </div>
            </>
          )}
          {fundError && !fundOpen && <p className="note bad">{localize(lang, fundError)}</p>}
          {market.error && <p className="note bad">{localize(lang, market.error)}</p>}
        </div>
        <SideCard
          side="down"
          share={figures.book.downShare}
          pool={figures.book.downPool}
          quote={figures.book.downQuote}
          orders={figures.book.downPlayers}
          fade={figures.fade}
          fadeKey={figures.gen}
          disabled={!canBet}
          onBet={() => {
            if (betRoundId === null) return
            void market.place("down", stake, betRoundId)
          }}
        />
      </section>
      {fundOpen && testnet && (
        <GrantOverlay
          chainId={market.config.chainId}
          chainKey={market.config.chainKey}
          chainName={market.config.chainName}
          grantMicros={market.config.grantMicros}
          grantIntervalMs={market.config.grantIntervalMs}
          grantAt={grantAt}
          now={now}
          granting={funding}
          blocked={reconnecting}
          error={fundError}
          onClose={() => {
            setFundOpen(false)
            if (!funding) {
              setGrantTx(null)
              setGrantSeen(0)
              setFundError(null)
            }
          }}
          onGrant={() => {
            if (funding) return
            if (market.blocked) {
              setFundError("Reconnecting to the market")
              return
            }
            const before = grantAt
            setFunding(true)
            setFundOpen(false)
            setFundError(null)
            setGrantTx(null)
            setGrantSeen(0)
            setGrantNeeded(MINT_CONFIRMATIONS)
            const grantTxUrlFor = (txHash: string | null) =>
              txHash ? grantTxUrl(market.config.chainId, txHash, market.config.chainKey) : null
            void (async () => {
              const result = await market.claimGrant()
              if (result.txHash) setGrantTx(result.txHash)
              if (result.ok) setGrantNeeded(result.confirmations)
              const follow = async () => {
                const landed = await market.waitForGrant(before)
                setFunding(false)
                if (landed) {
                  setGrantTx(null)
                  setFundOpen(false)
                  upsertToast({
                    id: "grant-ok",
                    kind: "ok",
                    text: text.grantedToast,
                    txHash: result.txHash,
                    txUrl: grantTxUrlFor(result.txHash),
                  })
                  return true
                }
                return false
              }
              if (!result.ok) {
                if (result.dropped && (await follow())) return
                setFunding(false)
                upsertToast({ id: "grant-error", kind: "error", text: localize(lang, result.message) })
                return
              }
              if (result.granted) {
                setFunding(false)
                setGrantTx(null)
                setFundOpen(false)
                upsertToast({
                  id: "grant-ok",
                  kind: "ok",
                  text: text.grantedToast,
                  txHash: result.txHash,
                  txUrl: grantTxUrlFor(result.txHash),
                })
                return
              }
              if (!result.pending) {
                setFunding(false)
                return
              }
              if (await follow()) return
              setFunding(false)
              upsertToast({ id: "grant-error", kind: "error", text: text.grantMissed })
            })()
          }}
        />
      )}
      {fundOpen && !testnet && (
        <FundOverlay
          address={session.address}
          label={session.label}
          treasury={market.config.treasury}
          chainId={market.config.chainId}
          chainName={market.config.chainName}
          amount={fundAmount}
          disabled={!session.token || funding || reconnecting}
          customDisabled={!session.token || funding || fundMicros === null || reconnecting}
          blocked={reconnecting}
          error={fundError}
          phase={fundPhase}
          hash={fundHash}
          onAmount={setFundAmount}
          onClose={() => setFundOpen(false)}
          onFund={(amount) => {
            if (market.blocked) {
              setFundError("Reconnecting to the market")
              return
            }
            const micros = parseAmountMicros(amount)
            if (micros === null) return
            const target = (you?.balanceMicros ?? 0) + micros
            setFunding(true)
            setFundPhase("phantom")
            setFundHash(null)
            setFundError(null)
            void session.deposit(amount, market.config.treasury, market.config.usdc, market.config.chainId).then(async (result) => {
              if (!result.ok) {
                setFundError(result.message)
                setFunding(false)
                setFundPhase("idle")
                return
              }
              setFundHash(result.hash)
              setFundPhase(result.pending ? "pending" : "confirming")
              try {
                const updated = await market.waitForBalance(target)
                setFunding(false)
                setFundPhase("idle")
                if (!updated) {
                  setFundError(
                    result.pending
                      ? `Transfer sent. Waiting for the ledger. ${briefTx(result.hash)}`
                      : "Deposit sent. It will show after confirmation.",
                  )
                } else {
                  setFundHash(null)
                  setFundOpen(false)
                }
              } catch {
                setFunding(false)
                setFundPhase("idle")
                setFundError(
                  `Transfer sent. The ${market.config.tokenLabel} is in the treasury and will be credited when the server is back.`,
                )
              }
            })
          }}
        />
      )}
      {withdrawOpen && (
        <WithdrawOverlay
          testnet={testnet}
          address={session.address}
          label={session.label}
          balanceMicros={you?.balanceMicros ?? 0}
          chainId={market.config.chainId}
          chainKey={market.config.chainKey}
          chainName={market.config.chainName}
          amount={withdrawAmount}
          pending={withdrawing}
          blocked={reconnecting}
          error={withdrawError}
          onAmount={(value) => {
            setWithdrawAmount(value)
            setWithdrawError(null)
          }}
          onMax={() => {
            if (!you) return
            setWithdrawAmount(microsToInput(you.balanceMicros))
            setWithdrawError(null)
          }}
          onClose={() => setWithdrawOpen(false)}
          onSubmit={() => void onWithdraw()}
        />
      )}

      <History
        token={session.token}
        version={market.historyVersion}
        windowMs={market.config.windowSeconds * 1000}
        blocked={reconnecting}
      />
      {(market.notices.length > 0 || market.lateNotices.length > 0) && (
        <PricePops anchorRef={balanceMark}>
          {market.notices.map((notice) => (
            <ResultPop key={notice.roundId} notice={notice} onDone={() => market.dismissNotice(notice.roundId)} />
          ))}
          {market.lateNotices.map((id) => (
            <LatePop key={id} onDone={() => market.dismissLate(id)} />
          ))}
        </PricePops>
      )}

      {briefOpen && (
        <TestnetBrief
          chainName={market.config.chainName}
          grantMicros={market.config.grantMicros}
          grantIntervalMs={market.config.grantIntervalMs}
          onDismiss={() => {
            writeBriefAt(Date.now())
            setBriefOpen(false)
          }}
        />
      )}

      <ToastStack toasts={toasts} onClose={dismissToast} />

      <footer className="footer">
        <div className="footer-bar">
          <div className="rules">
            <p className="periods">{text.periods(market.config.windowSeconds, market.config.marketSeconds)}</p>
            <p>{text.ruleFinish}</p>
            <p>{text.ruleVoid}</p>
            <p>{text.ruleDrop}</p>
            <p>{text.feeLine((market.config.feeBps / 100).toFixed(2), market.ticker.label || sourceLabel(market.ticker.venue, lang))}</p>
          </div>
          <ConnectionStatus link={market.link} />
        </div>
        <LanguageSelect />
      </footer>
    </div>
  )
}

function LinkQualityBadge({ link, blocked }: { link: LinkStatus; blocked: boolean }) {
  const { lang, text } = useI18n()
  const label =
    link.tone === "down" || blocked
      ? text.reconnecting
      : link.tone === "slow"
        ? text.slow
        : text.live
  return (
    <span
      className="link-quality"
      data-tone={blocked ? "down" : link.tone}
      role="status"
      title={`${text.lagUp} ${formatLag(link.upMs)} · ${text.lagDown} ${formatLag(link.downMs)} · ${text.roundTrip} ${formatLag(link.rttMs)}`}
      aria-label={lagButtonName(label, link.rttMs, lang)}
    >
      <span className="connection-dot" data-tone={blocked ? "down" : link.tone} aria-hidden="true" />
      <span className="link-quality-label">{label}</span>
      <span className="link-quality-ping">
        ↑ {formatLag(link.upMs)} ↓ {formatLag(link.downMs)}
      </span>
      {blocked && <span className="wait-spin" aria-hidden="true" />}
    </span>
  )
}

function ConnectionStatus({ link }: { link: LinkStatus }) {
  const { lang, text } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div className="connection" ref={ref}>
      <button
        type="button"
        className="plain connection-button"
        data-open={open ? "1" : "0"}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={lagButtonName(link.label, link.rttMs, lang)}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="connection-dot" data-tone={link.tone} />
      </button>
      {open && (
        <div className="connection-pop" role="dialog" aria-label={text.connection}>
          <p className="connection-label">{link.tone === "live" ? text.live : link.tone === "slow" ? text.slow : text.reconnecting}</p>
          <p>
            <span>{text.lagUp}</span>
            <span>{formatLag(link.upMs)}</span>
          </p>
          <p>
            <span>{text.lagDown}</span>
            <span>{formatLag(link.downMs)}</span>
          </p>
          <p>
            <span>{text.roundTrip}</span>
            <span>{formatLag(link.rttMs)}</span>
          </p>
        </div>
      )}
    </div>
  )
}

function ChartOverlay({
  chart,
  board,
  openBuyIns,
  feeBps,
  hover,
  offsetRef,
}: {
  chart: TapeChart
  board: Board | null
  openBuyIns: OpenBuyIn[]
  feeBps: number
  hover: { t: number } | null
  offsetRef?: RefObject<number>
}) {
  const current = useSyncExternalStore(chart.subscribe, chart.getScale, chart.getScale)
  if (!current || !board) return null
  const span = Math.max(1, current.viewEnd - current.viewStart)
  const xAt = (t: number) => current.plotLeft + ((t - current.viewStart) / span) * current.plotWidth
  const now = Date.now() + (offsetRef?.current ?? 0)
  const riding = chartMarket(board, openBuyIns, now)
  const peg = heldStrike(riding)
  const gutter = current.width - current.plotLeft - current.plotWidth

  return (
    <div className="chart-overlay">
      {peg && (
        <PegPrice
          text={peg.text}
          top={pegTop(current, peg.price)}
          right={gutter + 16}
        />
      )}
      {openBuyIns.map((bet) => {
        const band = board.bands.find((row) => row.id === bet.roundId) ?? (board.join?.id === bet.roundId ? board.join : null)
        if (!band) return null
        const pinsRight = riding?.id === bet.roundId
        return (
          <BetChip
            key={bet.roundId}
            bet={bet}
            band={band}
            left={pinsRight ? undefined : Math.max(current.plotLeft, xAt(band.strikeAt)) + 8}
            right={pinsRight ? gutter + 8 : undefined}
            top={current.plotTop}
            feeBps={feeBps}
          />
        )
      })}
      {current.ticks.map((tick) => (
        <span key={`${tick.price}`} className="ytick" style={{ top: tick.y, right: 8 }}>
          {tick.label}
        </span>
      ))}
      {hover && <Scrub scale={current} xAt={xAt} hover={hover} sample={chart.sample(hover.t)} bands={board.bands} />}
    </div>
  )
}

function Scrub({
  scale,
  xAt,
  hover,
  sample,
  bands,
}: {
  scale: ChartScale
  xAt: (t: number) => number
  hover: { t: number }
  sample: TapeSample | null
  bands: Band[]
}) {
  const { lang, text } = useI18n()
  if (!sample) return null
  const x = xAt(hover.t)
  if (x < scale.plotLeft || x > scale.plotLeft + scale.plotWidth) return null
  const market = bands.find((band) => band.strike !== null && hover.t >= band.strikeAt && hover.t < band.settlesAt) ?? null
  const strike = market?.strike != null ? Number(market.strike) : null
  const fromOpen = strike == null ? null : sample.price - strike
  const side = fromOpen == null ? null : fromOpen > 0 ? "up" : fromOpen < 0 ? "down" : "flat"
  const cardLeft = x > scale.plotLeft + scale.plotWidth - 150 ? x - 140 : x + 8
  return (
    <>
      <div className="scrub-line" style={{ left: x, top: scale.plotTop, height: scale.plotHeight }} />
      <p className="scrub" style={{ left: cardLeft, top: scale.plotTop + 8 }}>
        <span>{formatClock(hover.t, lang)}</span>
        <strong>{formatPrice(String(sample.price))}</strong>
        {sample.previous != null && (
          <span>
            {formatSigned(sample.price - sample.previous)} {text.fromLast}
          </span>
        )}
        {fromOpen != null && side && (
          <span className={side === "flat" ? "push" : side}>
            {side === "flat" ? text.pushMark : `${formatSigned(fromOpen)} ${side === "up" ? text.up : text.down}`}
          </span>
        )}
      </p>
    </>
  )
}

function pegTop(scale: ChartScale, price: number): number {
  const y = priceY(price, scale)
  return Math.min(scale.plotTop + scale.plotHeight - 4, Math.max(scale.plotTop + 4, y))
}

function PegPrice({ text, top, right }: { text: string; top: number; right: number }) {
  const { text: copyText } = useI18n()
  const [flash, setFlash] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduce) {
      setFlash(false)
      return
    }
    setFlash(true)
    const id = window.setTimeout(() => setFlash(false), 900)
    return () => window.clearTimeout(id)
  }, [text])
  return (
    <p className={flash ? "peg flash" : "peg"} style={{ top, right }} aria-label={copyText.lockedPrice}>
      <span>{copyText.locked}</span>
      <strong>{formatPrice(text)}</strong>
    </p>
  )
}

function BetChip({
  bet,
  band,
  left,
  right,
  top,
  feeBps,
}: {
  bet: OpenBuyIn
  band: Band
  left?: number
  right?: number
  top: number
  feeBps: number
}) {
  const { text } = useI18n()
  const payout = payoutMicros(bet.stakeMicros, bet.side, band.poolUpMicros, band.poolDownMicros, feeBps)
  return (
    <p className={`chip ${bet.side}`} style={{ left, right, top: top + 52 }}>
      <strong>
        {bet.side === "up" ? `▲ ${text.up}` : `▼ ${text.down}`} {formatMoney(bet.stakeMicros)}
      </strong>
      <span>
        {text.gets} {formatMoney(payout)}
      </span>
    </p>
  )
}

function BalanceFigure({ micros, markRef }: { micros: number | null; markRef: RefObject<HTMLParagraphElement | null> }) {
  const [shown, setShown] = useState<number | null>(micros)
  const [dir, setDir] = useState<"" | "debit">("")
  const drawn = useRef<number | null>(micros)

  useEffect(() => {
    let frame = 0
    let settle = 0
    const from = drawn.current
    const stop = () => {
      if (frame) cancelAnimationFrame(frame)
      if (settle) window.clearTimeout(settle)
    }
    if (micros == null || from == null || from === micros || prefersReducedMotion()) {
      drawn.current = micros
      setShown(micros)
      setDir("")
      return stop
    }
    const down = micros < from
    setDir(down ? "debit" : "")
    const start = performance.now()
    const tick = (now: number) => {
      const next = balanceStep(from, micros, (now - start) / BALANCE_MS)
      drawn.current = next
      setShown(next)
      if ((now - start) < BALANCE_MS) {
        frame = requestAnimationFrame(tick)
        return
      }
      drawn.current = micros
      setShown(micros)
      if (down) settle = window.setTimeout(() => setDir(""), 200)
    }
    frame = requestAnimationFrame(tick)
    return stop
  }, [micros])

  return (
    <p ref={markRef} className="balance" data-dir={dir}>
      {shown == null ? "$—" : formatMoney(shown)}
    </p>
  )
}

function LockMark({ locked }: { locked: boolean }) {
  const { text } = useI18n()
  return (
    <span className="lock" data-state={locked ? "locked" : "open"} aria-label={locked ? text.priceLocked : text.priceLocking}>
      <span className="lock-spin" aria-hidden="true" />
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect
          x="5"
          y="11"
          width="14"
          height="9"
          rx="2"
          fill={locked ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={locked ? 0 : 1.8}
        />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  )
}

function moveWord(side: "up" | "down" | "push", lang: Lang): string {
  const text = copy(lang)
  if (side === "up") return text.up
  if (side === "down") return text.down
  return text.push
}

function PriceReadout({
  priceRef,
  strike,
  pair,
  pairTitle,
  venue,
}: {
  priceRef: RefObject<string | null>
  strike: string | null
  pair: string
  pairTitle: string
  venue: string
}) {
  const { lang } = useI18n()
  const priceEl = useRef<HTMLSpanElement>(null)
  const deltaEl = useRef<HTMLSpanElement>(null)
  const wordEl = useRef<HTMLSpanElement>(null)
  const moveEl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const price = priceRef.current
      if (priceEl.current) priceEl.current.textContent = price ? formatPrice(price) : "—"
      const delta = price && strike ? formatDollarMove(price, strike) : null
      if (delta && deltaEl.current && wordEl.current && moveEl.current) {
        deltaEl.current.textContent = delta.text
        wordEl.current.textContent = moveWord(delta.side, lang)
        moveEl.current.dataset.side = delta.side
      }
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [priceRef, strike, lang])
  return (
    <>
      <div className="price-block">
        <span className="pair-row">
          <span className="pair-badge" title={pairTitle}>
            {pair}
          </span>
          <FeedBadge source={venue} />
        </span>
        <span className="price-line">
          <LockMark locked={!!strike} />
          <span ref={priceEl} className="price">
            —
          </span>
        </span>
      </div>
      {strike && (
        <div ref={moveEl} className="move">
          <span ref={wordEl} className="move-label" />
          <span ref={deltaEl} className="delta" />
        </div>
      )}
    </>
  )
}

function TokenBadge({ kind, chainKey }: { kind: "circle" | "qm"; chainKey?: string }) {
  const { text } = useI18n()
  const near = chainKey === "near-testnet"
  const title = kind === "circle" ? text.circleTitle : near ? text.nearTitle : text.qmTitle
  const label = kind === "circle" ? "USDC" : near ? text.nearBadge : "QM USDC"
  return (
    <span className="token-badge" data-kind={kind} title={title}>
      {kind === "circle" ? <CircleMark /> : <QmMark />}
      <span>{label}</span>
    </span>
  )
}

function CircleMark() {
  return (
    <svg className="token-mark" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill="#2775CA" />
      <path
        fill="#fff"
        d="M8.55 3.15v.85c.92.15 1.58.68 1.58 1.55 0 .95-.72 1.42-1.82 1.68l-.18.04v2.05c.4-.08.82-.28 1.1-.58l.58.62c-.44.48-1.1.78-1.76.9v.86H7.15v-.64c-1.08-.18-1.82-.8-1.82-1.72 0-1 .78-1.48 1.82-1.7V5.05c-.36.1-.7.28-.9.55l-.56-.6c.4-.44 1.02-.72 1.46-.86V3.15h1.4zm-.2 2.2v1.55c.48-.12.76-.35.76-.72 0-.34-.24-.6-.76-.83zm-.82 3.75c0 .38.26.64.82.76v-1.55c-.52.12-.82.36-.82.79z"
      />
    </svg>
  )
}

function QmMark() {
  return (
    <svg className="token-mark" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill="var(--warn)" />
      <text
        x="8"
        y="8.55"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#1a1404"
        fontSize="6.2"
        fontWeight="800"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        QM
      </text>
    </svg>
  )
}

/** Persistent inline mark for a connect failure. The error toast times out;
 * this dot stays next to the button with the full detail in its popover. */
function ErrorDot({ short, detail }: { short: string; detail: string }) {
  const { lang, text } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])
  return (
    <span className="error-dot" ref={ref} data-open={open ? "1" : "0"}>
      <button
        type="button"
        className="plain error-dot-btn"
        title={localize(lang, short)}
        aria-label={text.errorDetails}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        ⓘ
      </button>
      {open && (
        <div className="error-pop" role="dialog" aria-label={text.errorDetails}>
          <p>{localize(lang, detail)}</p>
        </div>
      )}
    </span>
  )
}

function AddressWithHover({ address, label }: { address: string; label?: string | null }) {
  return (
    <span className="addr-hover" title={address}>
      <span>{walletDisplayLabel(address, label)}</span>
      <span className="addr-tip" role="tooltip">
        {address}
      </span>
    </span>
  )
}

function briefTx(hash: string): string {
  return hash.length < 18 ? hash : `${hash.slice(0, 10)}…${hash.slice(-4)}`
}

function FundOverlay({
  address,
  label,
  treasury,
  chainId,
  chainName,
  amount,
  disabled,
  customDisabled,
  blocked,
  error,
  phase,
  hash,
  onAmount,
  onClose,
  onFund,
}: {
  address: string | null
  label: string | null
  treasury: string
  chainId: number
  chainName: string
  amount: string
  disabled: boolean
  customDisabled: boolean
  blocked: boolean
  error: string | null
  phase: "idle" | "phantom" | "confirming" | "pending"
  hash: string | null
  onAmount: (amount: string) => void
  onClose: () => void
  onFund: (amount: string) => void
}) {
  const { lang, text } = useI18n()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label={text.depositUsdc} onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>{text.deposit}</h2>
            <TokenBadge kind="circle" />
            <span className="net-badge" data-testnet="0">
              <ChainLogo chainKey="base" className="chain-mark" />
              {chainBadgeText(chainId, chainName, lang)}
            </span>
          </div>
          <button type="button" className="overlay-close" aria-label={text.close} onClick={onClose}>
            {"×"}
          </button>
        </header>
        <dl className="overlay-meta">
          <div>
            <dt>{text.network}</dt>
            <dd>{chainNetworkLabel(chainId, chainName, lang)}</dd>
          </div>
          <div>
            <dt>{text.fromTo}</dt>
            <dd className="route-line">
              {address ? <AddressWithHover address={address} label={label} /> : <span>{text.wallet}</span>}
              <span className="route-arrow" aria-hidden="true">
                →
              </span>
              {treasury ? <AddressWithHover address={treasury} /> : <span>{text.treasury}</span>}
            </dd>
          </div>
        </dl>
        <div className="funds">
          <button type="button" onClick={() => onFund("10")} disabled={disabled}>
            +$10
          </button>
          <button type="button" onClick={() => onFund("1000")} disabled={disabled}>
            +$1,000
          </button>
        </div>
        <div className="fund-custom" data-busy={phase === "idle" ? "0" : "1"}>
          <input
            aria-label={text.fundAmount}
            inputMode="decimal"
            placeholder={text.customAmount}
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
            disabled={disabled}
          />
          <button type="button" className="primary" onClick={() => onFund(amount)} disabled={customDisabled}>
            {phase === "phantom" ? text.confirmPhantom : phase === "confirming" || phase === "pending" ? text.waitingConfirmations : text.deposit}
          </button>
        </div>
        {phase === "phantom" && <p className="note pending-note">{text.confirmPhantom}</p>}
        {phase === "confirming" && <p className="note pending-note">{text.waitingConfirmations}</p>}
        {phase === "pending" && (
          <p className="note pending-note" title={hash ?? undefined}>
            {text.ledgerWait(hash ? briefTx(hash) : "")}
          </p>
        )}
        {blocked && (
          <p className="note warn" role="status">
            {text.reconnectingMarket} · {text.reconnectingHint}
          </p>
        )}
        {error && <p className="note bad">{localize(lang, error)}</p>}
      </div>
    </div>
  )
}

function GrantOverlay({
  chainId,
  chainKey,
  chainName,
  grantMicros,
  grantIntervalMs,
  grantAt,
  now,
  granting,
  blocked,
  error,
  onClose,
  onGrant,
}: {
  chainId: number
  chainKey: string
  chainName: string
  grantMicros: number
  grantIntervalMs: number
  grantAt: number | null
  now: number
  granting: boolean
  blocked: boolean
  error: string | null
  onClose: () => void
  onGrant: () => void
}) {
  const { lang, text } = useI18n()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  const timing = grantTiming(grantAt, now, grantIntervalMs)
  const near = chainKey === "near-testnet"
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label={near ? text.grantNear : text.grantAria} onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>{text.grant}</h2>
            <TokenBadge kind="qm" chainKey={chainKey} />
            <span className="net-badge" data-testnet="1">
              <ChainLogo chainKey={chainKey} className="chain-mark" />
              {chainBadgeText(chainId, chainName, lang, chainKey as "base" | "base-sepolia" | "near-testnet")}
            </span>
          </div>
          <button type="button" className="overlay-close" aria-label={text.close} onClick={onClose}>
            {"×"}
          </button>
        </header>
        <p className="note grant-copy">{grantSentence(grantMicros, grantIntervalMs, lang, chainKey as "base" | "base-sepolia" | "near-testnet")}</p>
        <dl className="overlay-meta">
          <div>
            <dt>{text.amount}</dt>
            <dd>{formatGrantDollars(grantMicros)}</dd>
          </div>
          <div>
            <dt>{text.next}</dt>
            <dd>{grantNextLabel(timing, lang)}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="primary grant-submit"
          onClick={onGrant}
          disabled={granting || !timing.due || blocked}
          title={blocked ? text.reconnectingMarket : undefined}
        >
          {granting ? text.granting : grantButtonLabel(timing, grantMicros, lang)}
        </button>
        {blocked && (
          <p className="note warn" role="status">
            {text.reconnectingMarket} · {text.reconnectingHint}
          </p>
        )}
        {error && <p className="note bad">{localize(lang, error)}</p>}
      </div>
    </div>
  )
}

function WithdrawOverlay({
  testnet,
  address,
  label,
  balanceMicros,
  chainId,
  chainKey,
  chainName,
  amount,
  pending,
  blocked,
  error,
  onAmount,
  onMax,
  onClose,
  onSubmit,
}: {
  testnet: boolean
  address: string | null
  label: string | null
  balanceMicros: number
  chainId: number
  chainKey: string
  chainName: string
  amount: string
  pending: boolean
  blocked: boolean
  error: string | null
  onAmount: (value: string) => void
  onMax: () => void
  onClose: () => void
  onSubmit: () => void
}) {
  const { lang, text } = useI18n()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  const parsed = parseAmountMicros(amount)
  const submitDisabled = pending || blocked || parsed === null || parsed > balanceMicros
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label={chainKey === "near-testnet" ? text.withdrawNear : testnet ? text.withdrawQm : text.withdrawUsdc} onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>{text.withdraw}</h2>
            <TokenBadge kind={testnet ? "qm" : "circle"} chainKey={chainKey} />
            <span className="net-badge" data-testnet={testnet ? "1" : "0"}>
              <ChainLogo chainKey={chainKey} className="chain-mark" />
              {chainBadgeText(chainId, chainName, lang, chainKey as "base" | "base-sepolia" | "near-testnet")}
            </span>
          </div>
          <button type="button" className="overlay-close" aria-label={text.close} onClick={onClose}>
            {"×"}
          </button>
        </header>
        <dl className="overlay-meta">
          <div>
            <dt>{text.toWallet}</dt>
            <dd>{address ? <AddressWithHover address={address} label={label} /> : "—"}</dd>
          </div>
          <div>
            <dt>{text.spendable}</dt>
            <dd>{formatMoney(balanceMicros)}</dd>
          </div>
        </dl>
        <div className="fund-custom">
          <div className="input-with-max">
            <input
              aria-label={text.withdrawAmount}
              inputMode="decimal"
              placeholder={text.amount}
              value={amount}
              onChange={(event) => onAmount(event.target.value)}
              disabled={pending || blocked}
            />
            <button type="button" className="max-btn" onClick={onMax} disabled={pending || blocked || balanceMicros <= 0}>
              {text.max}
            </button>
          </div>
          <button type="button" className="primary" onClick={onSubmit} disabled={submitDisabled}>
            {pending ? text.withdrawing : text.withdraw}
          </button>
        </div>
        {chainKey === "near-testnet" ? <p className="note">{text.paysNear}</p> : testnet ? <p className="note">{text.paysQm}</p> : null}
        {blocked && (
          <p className="note warn" role="status">
            {text.reconnectingMarket} · {text.reconnectingHint}
          </p>
        )}
        {error && <p className="note bad">{localize(lang, error)}</p>}
      </div>
    </div>
  )
}

function Countdown({ endsAt, offsetRef }: { endsAt: number; offsetRef: RefObject<number> }) {
  const { text } = useI18n()
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const left = Math.max(0, endsAt - (Date.now() + offsetRef.current))
      const secs = left / 1000
      const node = ref.current
      if (node) {
        node.textContent = secs.toFixed(1)
        const block = node.closest(".clock-block")
        if (block instanceof HTMLElement) block.dataset.urgent = secs < 1.5 ? "1" : "0"
      }
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [endsAt, offsetRef])
  return (
    <span className="clock-line">
      <strong ref={ref} className="clock">
        0.0
      </strong>
      <span className="clock-unit">{text.secondUnit}</span>
    </span>
  )
}

function SideCard(props: {
  side: Side
  share: string
  pool: number
  quote: string
  orders: number
  fade: boolean
  fadeKey: number
  disabled: boolean
  onBet: () => void
}) {
  const { text } = useI18n()
  const up = props.side === "up"
  return (
    <article className={up ? "side up" : "side down"}>
      <p className="side-name">{up ? `▲ ${text.up}` : `▼ ${text.down}`}</p>
      <div className="side-figures" data-fade={props.fade ? "1" : "0"} key={props.fadeKey}>
        <p className="share">{props.share}</p>
        <p className="pool">
          {formatMoney(props.pool)} · {props.orders} {props.orders === 1 ? text.order : text.orders}
        </p>
        <p className="to-win">{props.quote}</p>
      </div>
      <button type="button" disabled={props.disabled} onClick={props.onBet}>
        <span className="arrow" aria-hidden="true">{up ? "▲" : "▼"}</span>
        <span>{up ? text.buyUp : text.buyDown}</span>
      </button>
    </article>
  )
}

function History({
  token,
  version,
  windowMs,
  blocked,
}: {
  token: string | null
  version: number
  windowMs: number
  blocked: boolean
}) {
  const { lang, text } = useI18n()
  const [mine, setMine] = useState(false)
  const [publicRows, setPublicRows] = useState<HistoryRound[]>([])
  const [mineRows, setMineRows] = useState<HistoryRound[]>([])
  const [replay, setReplay] = useState<HistoryRound | null>(null)
  const rows = mine ? mineRows : publicRows

  useEffect(() => {
    let cancel = false
    fetch("/api/rounds?limit=10")
      .then((response) => response.json())
      .then((body) => {
        if (!cancel) setPublicRows(body.rounds ?? [])
      })
      .catch(() => {})
    return () => {
      cancel = true
    }
  }, [version])

  useEffect(() => {
    if (!mine || !token) return
    let cancel = false
    fetch("/api/rounds?limit=10&mine=1", { headers: { authorization: `Bearer ${token}` } })
      .then((response) => response.json())
      .then((body) => {
        if (!cancel) setMineRows(body.rounds ?? [])
      })
      .catch(() => {})
    return () => {
      cancel = true
    }
  }, [token, mine, version])

  const marks = publicRows.slice(0, 3).flatMap((row) => {
    const mark = historyMark(row, text)
    return mark ? [{ id: row.id, ...mark }] : []
  })

  return (
    <details className="history">
      <summary>
        <h2>
          {text.previousMarkets}
          <span className="history-count">{text.lastTen}</span>
        </h2>
        {marks.length > 0 && (
          <span className="history-marks">
            {marks.map((mark) => (
              <span key={mark.id} className={mark.tone} role="img" aria-label={mark.name}>
                {mark.glyph}
              </span>
            ))}
          </span>
        )}
      </summary>
      <div className="filters" onClick={(event) => event.stopPropagation()}>
        <button type="button" className={!mine ? "on" : ""} onClick={() => setMine(false)}>
          {text.all}
        </button>
        <button type="button" className={mine ? "on" : ""} onClick={() => setMine(true)} disabled={!token || blocked}>
          {text.myTrades}
        </button>
      </div>
      {blocked && (
        <p className="note warn" role="status">
          {text.reconnectingMarket} · {text.reconnectingHint}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="empty">{text.noRounds}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{text.time}</th>
              <th>{text.result}</th>
              <th>{text.open}</th>
              <th>{text.closePrice}</th>
              <th>{text.up}</th>
              <th>{text.down}</th>
              <th>{text.feed}</th>
              {mine && (
                <>
                  <th>{text.bought}</th>
                  <th>{text.back}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => {
                  if (blocked) return
                  setReplay(row)
                }}
                className={replay?.id === row.id ? "open" : ""}
                data-disabled={blocked ? "1" : undefined}
                title={blocked ? text.reconnectingMarket : undefined}
              >
                <td>{formatClock(row.startsAt, lang)}</td>
                <td className={resultTone(row)}>{resultText(row, text)}</td>
                <td>{row.strike ? formatPrice(row.strike) : "—"}</td>
                <td>{row.settle ? formatPrice(row.settle) : "—"}</td>
                <td>{formatMoney(row.poolUpMicros)}</td>
                <td>{formatMoney(row.poolDownMicros)}</td>
                <td>
                  <FeedBadge source={row.source} />
                </td>
                {mine && (
                  <>
                    <td className={row.mySide ?? ""}>{boughtText(row.mySide, row.myStakeMicros)}</td>
                    <td>
                      {row.myStakeMicros !== undefined && row.myPayoutMicros != null ? (
                        <BackAmount stake={row.myStakeMicros} payout={row.myPayoutMicros} />
                      ) : (
                        "—"
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {replay && <Replay row={replay} windowMs={windowMs} onClose={() => setReplay(null)} />}
    </details>
  )
}

type RoundBet = TrayRow & { payoutMicros: number | null }

function PoolRows({ rows, payout }: { rows: TrayRow[]; payout?: (row: TrayRow) => number | null }) {
  const { text } = useI18n()
  return (
    <>
      {rows.map((row) => {
        const paid = payout?.(row)
        if (!payout) {
          return (
            <li key={row.address}>
              <span className="addr">{shortAddress(row.address)}</span>
              <span className={row.side}>{row.side === "up" ? `▲ ${text.up}` : `▼ ${text.down}`}</span>
              <span className="amt">{formatMoney(row.stakeMicros)}</span>
            </li>
          )
        }
        return (
          <li key={row.address}>
            <span className="addr">{shortAddress(row.address)}</span>
            <span className={row.side}>{boughtText(row.side, row.stakeMicros)}</span>
            <span className="amt">{paid == null ? "—" : <BackAmount stake={row.stakeMicros} payout={paid} />}</span>
          </li>
        )
      })}
    </>
  )
}

function Replay({ row, windowMs, onClose }: { row: HistoryRound; windowMs: number; onClose: () => void }) {
  const { lang, text } = useI18n()
  const langRef = useRef(lang)
  langRef.current = lang
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [chart, setChart] = useState<TapeChart | null>(null)
  const [buyIns, setBuyIns] = useState<RoundBet[] | null>(null)
  const [failed, setFailed] = useState(false)
  const scrub = useScrub(chart)
  const viewRef = useRef({ follow: false, start: row.startsAt - windowMs, end: row.endsAt })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  useEffect(() => {
    let cancel = false
    let spawned: TapeChart | null = null
    fetch(`/api/rounds/${row.id}`)
      .then((response) => {
        if (!response.ok) throw new Error("missing")
        return response.json()
      })
      .then((body) => {
        if (cancel) return
        const tape = (body.tape ?? []) as { t: number; price: string }[]
        const canvas = canvasRef.current
        if (!canvas) return
        const buyInOpen = row.startsAt - windowMs
        viewRef.current = { follow: false, start: buyInOpen, end: row.endsAt }
        spawned = mountChart(canvas, {
          getNow: () => row.endsAt + 1,
          getView: () => viewRef.current,
          getClock: () => null,
          getStrike: () => {
            const strike = heldStrike({ strike: row.strike })
            if (!strike) return null
            return { ...strike, at: row.startsAt, openAt: row.startsAt - windowMs }
          },
          extendLive: () => false,
          getLocale: () => langRef.current,
        })
        spawned.reset(tape.map((point) => ({ t: point.t, price: Number(point.price), text: point.price })))
        setChart(spawned)
        setBuyIns(body.buyIns ?? [])
      })
      .catch(() => {
        if (!cancel) setFailed(true)
      })
    return () => {
      cancel = true
      spawned?.destroy()
    }
  }, [row, windowMs])

  const board: Board = {
    blockStart: row.startsAt - windowMs,
    blockEnd: row.endsAt,
    windowEndsAt: row.startsAt,
    phase: "market",
    join: null,
    live: null,
    bands: [
      {
        id: row.id,
        buyInOpen: row.startsAt - windowMs,
        strikeAt: row.startsAt,
        settlesAt: row.endsAt,
        strike: row.strike,
        status: row.status,
        poolUpMicros: row.poolUpMicros,
        poolDownMicros: row.poolDownMicros,
        playersUp: 0,
        playersDown: 0,
      },
    ],
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={text.replay}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <div className="replay-title">
              <h2>{formatClock(row.startsAt, lang)}</h2>
              <FeedBadge source={row.source} />
            </div>
            <p>
              {resultText(row, text)}
              {row.strike && row.settle ? ` · ${formatPrice(row.strike)} → ${formatPrice(row.settle)}` : ""}
              {` · ${text.up} ${formatMoney(row.poolUpMicros)} · ${text.down} ${formatMoney(row.poolDownMicros)}`}
            </p>
          </div>
          <button type="button" onClick={onClose}>
            {text.close}
          </button>
        </header>
        <section className="chart-wrap still" onPointerMove={scrub.move} onPointerLeave={scrub.clear}>
          <canvas ref={canvasRef} />
          {chart && <ChartOverlay chart={chart} board={board} openBuyIns={[]} feeBps={0} hover={scrub.hover} />}
        </section>
        {failed && <p className="empty">{text.replayMiss}</p>}
        {buyIns && buyIns.length === 0 && <p className="empty">{text.emptyPool}</p>}
        {buyIns && buyIns.length > 0 && (
          <div className="detail">
            <ul>
              <PoolRows rows={buyIns} payout={(entry) => (entry as RoundBet).payoutMicros ?? null} />
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

/** Matches the pop-out duration in styles.css. */
const POP_LEAVE_MS = 240

function domRect(node: HTMLElement): PopRect {
  const rect = node.getBoundingClientRect()
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  }
}

function PricePops({
  anchorRef,
  children,
}: {
  anchorRef: RefObject<HTMLParagraphElement | null>
  children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [places, setPlaces] = useState<PlacedPop[] | null>(null)
  const items = Children.toArray(children)
  useLayoutEffect(() => {
    let frame = 0
    const measure = () => {
      const balance = anchorRef.current
      const root = rootRef.current
      if (!balance || !root || balance.getBoundingClientRect().width === 0) return
      const nodes = [...root.querySelectorAll<HTMLElement>(".price-pop")]
      if (nodes.length === 0) return
      const view = window.visualViewport
      const next = placePricePops(
        domRect(balance),
        nodes.map((node) => ({ width: node.offsetWidth, height: node.offsetHeight })),
        { width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight },
      )
      setPlaces((current) => (samePlaces(current, next) ? current : next))
    }
    const kick = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    kick()
    const observer = new ResizeObserver(kick)
    let node: HTMLElement | null = anchorRef.current
    for (let depth = 0; depth < 4 && node; depth += 1) {
      observer.observe(node)
      node = node.parentElement
    }
    for (const node of rootRef.current?.querySelectorAll<HTMLElement>(".price-pop") ?? []) observer.observe(node)
    window.addEventListener("resize", kick)
    window.addEventListener("scroll", kick, true)
    const view = window.visualViewport
    view?.addEventListener("resize", kick)
    view?.addEventListener("scroll", kick)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", kick)
      window.removeEventListener("scroll", kick, true)
      view?.removeEventListener("resize", kick)
      view?.removeEventListener("scroll", kick)
    }
  }, [items.length, anchorRef])
  return (
    <div ref={rootRef} className="price-pops">
      {items.map((child, index) => {
        const place = places?.[index]
        const key = isValidElement(child) ? child.key : index
        return (
          <div
            key={key}
            className="price-pop-slot"
            data-ready={place ? "1" : "0"}
            data-side={place?.side ?? "below"}
            style={place ? { left: place.left, top: place.top } : undefined}
          >
            {child}
          </div>
        )
      })}
    </div>
  )
}

function samePlaces(current: PlacedPop[] | null, next: PlacedPop[]): boolean {
  if (!current || current.length !== next.length) return false
  return current.every((place, index) => {
    const other = next[index]
    return !!other && place.side === other.side && Math.round(place.left) === Math.round(other.left) && Math.round(place.top) === Math.round(other.top)
  })
}

function useToastLeave(waitMs: number, startedAt: number, onDone: () => void) {
  const [leaving, setLeaving] = useState(false)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const closed = useRef(false)
  const closeRef = useRef(() => {})
  closeRef.current = () => {
    if (closed.current) return
    closed.current = true
    if (prefersReducedMotion()) {
      requestAnimationFrame(() => doneRef.current())
      return
    }
    setLeaving(true)
  }

  useEffect(() => {
    const left = Math.max(0, waitMs - (Date.now() - startedAt))
    const id = window.setTimeout(() => closeRef.current(), left)
    return () => window.clearTimeout(id)
  }, [waitMs, startedAt])

  useEffect(() => {
    if (!leaving) return
    const id = window.setTimeout(() => doneRef.current(), POP_LEAVE_MS)
    return () => window.clearTimeout(id)
  }, [leaving])

  return { leaving, close: () => closeRef.current() }
}

function LatePop({ onDone }: { onDone: () => void }) {
  const { text } = useI18n()
  const started = useRef(Date.now()).current
  const { leaving, close } = useToastLeave(RESULT_MS, started, onDone)
  return (
    <button type="button" className={leaving ? "price-pop late leaving" : "price-pop late"} onClick={close}>
      {text.lateBuyIn}
    </button>
  )
}

function popClass(notice: MarketNotice): string {
  if (notice.kind === "settling") return "settling"
  if (notice.tone === "debit") return "debit"
  if (notice.signed) return "credit"
  if (notice.tone === "void") return "void"
  return "push"
}

function ResultPop({ notice, onDone }: { notice: MarketNotice; onDone: () => void }) {
  const { text } = useI18n()
  const kind = notice.kind
  const started = notice.kind === "settling" ? notice.openedAt : notice.shownAt
  const wait = kind === "settling" ? SETTLING_MS : RESULT_MS
  const { leaving, close } = useToastLeave(wait, started, onDone)
  const tone = popClass(notice)
  const figure = notice.kind === "result" ? pricePopText(notice.tone, notice.amountMicros, notice.signed) : null
  const label =
    notice.kind === "settling"
      ? text.settling
      : notice.tone === "credit"
        ? text.credited
        : notice.tone === "debit"
          ? text.deducted
          : notice.tone === "void"
            ? text.void
            : text.push
  return (
    <button
      type="button"
      className={leaving ? `price-pop ${tone} leaving` : `price-pop ${tone}`}
      aria-label={figure ? `${label} ${figure}` : label}
      onClick={close}
    >
      <span key={notice.kind === "settling" ? "settling" : tone} className="price-pop-figure">
        {figure ?? text.settling}
      </span>
    </button>
  )
}

function useScrub(chart: TapeChart | null) {
  const [hover, setHover] = useState<{ t: number } | null>(null)
  function move(event: ReactPointerEvent<HTMLElement>) {
    if (!chart || event.buttons !== 0) return
    const current = chart.getScale()
    if (!current) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    if (x < current.plotLeft || x > current.plotLeft + current.plotWidth) {
      setHover(null)
      return
    }
    const span = Math.max(1, current.viewEnd - current.viewStart)
    setHover({ t: current.viewStart + ((x - current.plotLeft) / current.plotWidth) * span })
  }
  function clear() {
    setHover(null)
  }
  return { hover, move, clear }
}

function historyMark(row: HistoryRound, text: Copy): { glyph: string; tone: string; name: string } | null {
  if (row.status === "void" || row.resolution === "void") return { glyph: "∅", tone: "void", name: text.void }
  if (row.winningSide === "push") return { glyph: "=", tone: "push", name: text.push }
  if (row.winningSide === "up") return { glyph: "▲", tone: "up", name: text.up }
  if (row.winningSide === "down") return { glyph: "▼", tone: "down", name: text.down }
  return null
}

function resultTone(row: HistoryRound): string {
  if (row.status === "void" || row.resolution === "void") return "void"
  if (row.winningSide === "push") return "push"
  if (row.winningSide === "up" || row.winningSide === "down") return row.winningSide
  return ""
}

function resultText(row: HistoryRound, text: Copy): string {
  if (row.status === "void" || row.resolution === "void") return text.void
  if (row.winningSide === "push") return text.pushMark
  if (row.winningSide === "up") return `▲ ${text.up}`
  if (row.winningSide === "down") return `▼ ${text.down}`
  return "—"
}

function boughtText(side: Side | undefined, stake: number | undefined): string {
  if (side !== "up" && side !== "down") return "—"
  if (stake === undefined) return side === "up" ? "▲" : "▼"
  return `${side === "up" ? "▲" : "▼"} ${formatMoney(stake)}`
}

function BackAmount({ stake, payout }: { stake: number; payout: number }) {
  const figures = formatReturn(stake, payout)
  return (
    <span className={figures.tone}>
      {figures.back}
      {figures.profit && <span className="profit"> ({figures.profit})</span>}
    </span>
  )
}


