import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { LATE_BUY_IN_ERROR } from "../../shared/buyIn"
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
  formatPriceDelta,
  formatSigned,
  formatGrantDollars,
  formatGrantTimer,
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
import type { Band, Board, HistoryRound, OpenBuyIn, SettledMessage, Side, TrayRow } from "./types"
import { readCachedBalance, visibleBalance } from "./balanceCache"
import { readGrantConfirmations } from "./grantChain"
import { grantLanded, grantTxUrl } from "./grantWatch"
import { formatLag, lagButtonName, type LinkStatus } from "./lag"
import { useMarket } from "./useMarket"
import { FeedBadge } from "./venues"
import { useSideBook } from "./useSideBook"
import { grantWaitStatus, loginStatus, loginSteps, loginStepState, SIGN_PROMPT } from "./phantomConnect"
import { useSession } from "./wallet"

export function App() {
  const session = useSession()
  const market = useMarket(session.token, session.signedYou)
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
  const [following, setFollowing] = useState(true)
  const scrub = useScrub(chart)
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
    if (!followHash) return
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
  }, [followHash, market.config.chainId])

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
      return
    }
    setGrantTx(null)
    setFundError("The grant did not land. Try again.")
  }, [market.you])

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
      getView: () => viewRef.current,
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
  const heldSpan = board ? heldMarket(board, openBuyIns, now) : null
  const focus = focusPool(board, openBuyIns, now)
  const total = (focus?.poolUpMicros ?? 0) + (focus?.poolDownMicros ?? 0)
  const held = openBuyIns.find((bet) => bet.roundId === focus?.id) ?? null
  const upQuote = focus ? quoteDollar("up", focus.poolUpMicros, focus.poolDownMicros, market.config.feeBps) : "—"
  const downQuote = focus ? quoteDollar("down", focus.poolUpMicros, focus.poolDownMicros, market.config.feeBps) : "—"
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
  const canBet =
    market.confirmed &&
    !!you &&
    !heldSpan &&
    betRoundId !== null &&
    market.feed === "live" &&
    !market.pending &&
    !handoff
  const ticketWin = held ? payoutMicros(held.stakeMicros, held.side, focus?.poolUpMicros ?? 0, focus?.poolDownMicros ?? 0, market.config.feeBps) : 0
  const fundMicros = parseAmountMicros(fundAmount)
  const testnet = market.config.tokenKind === "qm" || isTestnetChain(market.config.chainId)
  const grantKnown = market.confirmed ? you !== null : cached !== null
  const grantAt = market.confirmed ? (you?.grantAt ?? null) : (cached?.grantAt ?? null)
  const grantWait = grantTiming(grantAt, now, market.config.grantIntervalMs)
  const grantPending = you?.grantPending ?? null
  const grantInFlight = funding || grantPending !== null
  const holdStake = session.signing || grantPending !== null
  const grantReady = grantKnown && testnet && market.config.grantIntervalMs > 0 && grantWait.due && !grantInFlight
  const wrongChain =
    session.address !== null && session.chainId !== undefined && session.chainId !== market.config.chainId
  const walletTone = wrongChain || session.signing ? "warn" : "ok"
  const loginLabel = session.signing
    ? "Please wait"
    : !session.address && session.connectMode === "deeplink"
      ? "Open in Phantom"
      : "Sign in"

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
    setFundOpen(true)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (handoffRef.current) return
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
        </div>
        <div className="clock-cluster" data-move={heldSpan?.strike ? "1" : "0"}>
          <PriceReadout
            priceRef={market.priceRef}
            strike={heldSpan?.strike ?? null}
            pair={quotePair(market.ticker.venue)}
            pairTitle={market.ticker.label || sourceLabel(market.ticker.venue)}
            venue={market.ticker.venue}
          />
          <div className="clock-block">
            <span className="clock-label">{handoff ? "Opens" : heldSpan ? "Settles" : "Buy-in"}</span>
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
      {session.chainError && <p className="note bad">{session.chainError}</p>}
      {session.pageChain && market.config.treasury && market.config.chainId !== session.pageChain.id && (
        <p className="note bad">
          This page is on {session.pageChain.name} and the server is on {market.config.chainName}.
        </p>
      )}

      <section
        className="chart-wrap"
        data-loading={handoff ? "1" : undefined}
        aria-busy={handoff ? true : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          if (handoffRef.current) return
          scrub.move(event)
        }}
        onPointerLeave={scrub.clear}
      >
        <canvas ref={canvasRef} />
        {chart && !handoff && (
          <ChartOverlay
            chart={chart}
            board={board}
            openBuyIns={openBuyIns}
            feeBps={market.config.feeBps}
            hover={scrub.hover}
            offsetRef={market.offsetRef}
          />
        )}
        {handoff && (
          <div className="chart-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        )}
        {handoff && (
          <p className="handoff-banner">
            {handoff.to && <span className="handoff-kicker">Switching price source</span>}
            <span>{handoffBanner(handoff.from, handoff.to)}</span>
          </p>
        )}
        {market.feed === "stale" && !handoff && <p className="feed-flag">Price delayed</p>}
        {!following && (
          <button
            type="button"
            className="now-jump"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              viewRef.current = { follow: true, start: 0, end: 0 }
              setFollowing(true)
            }}
          >
            Now
          </button>
        )}
      </section>

      <section className="trade">
        <SideCard
          side="up"
          share={figures.book.upShare}
          pool={figures.book.upPool}
          quote={figures.book.upQuote}
          players={figures.book.upPlayers}
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
            <TokenBadge kind={testnet ? "qm" : "circle"} />
            {!session.token || !session.address ? (
              <span className="who" ref={session.address ? walletMenuRef : undefined}>
                {session.address && (
                  <>
                    <button
                      type="button"
                      className="wallet-pill"
                      data-open={walletMenuOpen ? "1" : "0"}
                      title={session.address}
                      aria-label="Wallet menu"
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
                            Disconnect
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="primary connect-pill"
                  title={session.chainError ?? undefined}
                  onClick={session.login}
                  disabled={session.signing || session.chainError !== null}
                >
                  {loginLabel}
                </button>
              </span>
            ) : (
              <span className="who" ref={walletMenuRef}>
                <button
                  type="button"
                  className="wallet-pill"
                  data-open={walletMenuOpen ? "1" : "0"}
                  title={session.address}
                  aria-label="Wallet menu"
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
                <button
                  type="button"
                  className="fund-plus"
                  data-grant={grantReady ? "due" : "wait"}
                  aria-label={grantReady ? "Grant ready" : testnet ? "Grant QM USDC" : "Deposit USDC"}
                  title={grantReady ? "Grant ready" : testnet ? "Grant" : "Deposit"}
                  onClick={openGrant}
                  disabled={!session.token || grantInFlight}
                >
                  {"+"}
                </button>
                {walletMenuOpen && (
                  <div className="wallet-menu" role="menu">
                    {session.label && <p className="wallet-menu-label">{session.label}</p>}
                    <p className="wallet-menu-addr" title={session.address}>
                      {session.address}
                    </p>
                    <div className="wallet-menu-net">
                      <TokenBadge kind={testnet ? "qm" : "circle"} />
                      <span className="net-badge" data-testnet={isTestnetChain(market.config.chainId) ? "1" : "0"}>
                        {session.signing ? "Please wait" : chainMenuLabel(market.config.chainId, market.config.chainName)}
                      </span>
                      {wrongChain && (
                        <button type="button" className="plain net-action" onClick={session.switchChain}>
                          Switch network
                        </button>
                      )}
                    </div>
                    <div className="wallet-menu-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setWalletMenuOpen(false)
                          setWithdrawError(null)
                          setWithdrawOpen(true)
                        }}
                        disabled={!you}
                      >
                        Withdraw
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setWalletMenuOpen(false)
                          session.disconnect()
                        }}
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}
              </span>
            )}
          </div>
          {session.signing && session.loginPhase && !grantPending && (
            <WaitNote text={loginStatus(session.loginPhase, testnet)} steps={loginSteps(testnet)} phase={session.loginPhase} />
          )}
          {grantPending && (
            <GrantFollow
              startedAt={grantPending.startedAt}
              txHash={grantPending.txHash}
              seen={grantSeen}
              needed={grantPending.confirmations}
              chainId={market.config.chainId}
              now={now}
            />
          )}
          {session.connectError && <p className="note bad connect-error">{session.connectError}</p>}
          {!session.token && session.signError && session.signError !== SIGN_PROMPT && (
            <p className="note bad connect-error">{session.signError}</p>
          )}
          {!holdStake && <BalanceFigure micros={shownMicros} />}
          {!holdStake && testnet && market.config.grantIntervalMs > 0 && grantKnown &&
            (grantWait.due ? (
              <button type="button" className="grant-status" onClick={openGrant} disabled={!session.token || grantInFlight}>
                {grantStatusLabel(grantWait, market.config.grantMicros)}
              </button>
            ) : (
              <p className="grant-status">{grantStatusLabel(grantWait, market.config.grantMicros)}</p>
            ))}
          {held && (
            <div className="ticket">
              <p className={held.side}>{held.side === "up" ? "▲ Up" : "▼ Down"}</p>
              <p>Amount {formatMoney(held.stakeMicros)}</p>
              <p>Gets {formatMoney(ticketWin)}</p>
            </div>
          )}
          {!holdStake && (
            <>
              <label className="stake-field">
                <span>Amount</span>
                <input
                  inputMode="decimal"
                  value={stake}
                  onChange={(event) => setStake(event.target.value)}
                  disabled={!you}
                />
              </label>
              <div className="chips">
                <button type="button" onClick={() => chip(25)} disabled={!you}>
                  25%
                </button>
                <button type="button" onClick={() => chip(50)} disabled={!you}>
                  50%
                </button>
                <button type="button" onClick={() => chip(100)} disabled={!you}>
                  100%
                </button>
              </div>
            </>
          )}
          {fundError && !fundOpen && <p className="note bad">{fundError}</p>}
          {market.error && <p className="note bad">{market.error}</p>}
        </div>
        <SideCard
          side="down"
          share={figures.book.downShare}
          pool={figures.book.downPool}
          quote={figures.book.downQuote}
          players={figures.book.downPlayers}
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
          chainName={market.config.chainName}
          grantMicros={market.config.grantMicros}
          grantIntervalMs={market.config.grantIntervalMs}
          grantAt={grantAt}
          now={now}
          granting={funding}
          txHash={grantTx}
          confirmationsSeen={grantSeen}
          confirmationsNeeded={grantNeeded}
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
            const before = grantAt
            setFunding(true)
            setFundError(null)
            setGrantTx(null)
            setGrantSeen(0)
            setGrantNeeded(MINT_CONFIRMATIONS)
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
                  return true
                }
                return false
              }
              if (!result.ok) {
                if (result.dropped && (await follow())) return
                setFunding(false)
                setFundError(result.message)
                return
              }
              if (result.granted) {
                setFunding(false)
                setGrantTx(null)
                setFundOpen(false)
                return
              }
              if (!result.pending) {
                setFunding(false)
                return
              }
              if (await follow()) return
              setFunding(false)
              setFundError("The grant did not land. Try again.")
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
          disabled={!session.token || funding}
          customDisabled={!session.token || funding || fundMicros === null}
          error={fundError}
          phase={fundPhase}
          hash={fundHash}
          onAmount={setFundAmount}
          onClose={() => setFundOpen(false)}
          onFund={(amount) => {
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
          chainName={market.config.chainName}
          amount={withdrawAmount}
          pending={withdrawing}
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

      <History token={session.token} version={market.historyVersion} windowMs={market.config.windowSeconds * 1000} />
      {(market.notices.length > 0 || market.lateNotices.length > 0) && (
        <div className="toasts">
          {market.notices.map((event) => (
            <ResultToast
              key={event.roundId}
              event={event}
              address={market.address}
              onDone={() => market.dismissNotice(event.roundId)}
            />
          ))}
          {market.lateNotices.map((id) => (
            <LateToast key={id} onDone={() => market.dismissLate(id)} />
          ))}
        </div>
      )}

      <footer className="footer">
        <div className="rules">
          <p className="periods">
            Buy-in {market.config.windowSeconds}s · Market {market.config.marketSeconds}s
          </p>
          <p>Up finishes above the open. Down finishes below. Push is a tie, and stakes return.</p>
          <p>If a market never gets a price, it is void and stakes return.</p>
          <p>If the price feed drops during a market, that market is void and stakes return. The next feed is shown before buy-in opens.</p>
          <p>
            {(market.config.feeBps / 100).toFixed(2)}% fee on a paid pool. Price from {market.ticker.label || sourceLabel(market.ticker.venue)}.
          </p>
        </div>
        <ConnectionStatus link={market.link} />
      </footer>
    </div>
  )
}

function ConnectionStatus({ link }: { link: LinkStatus }) {
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
        aria-label={lagButtonName(link.label, link.rttMs)}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="connection-dot" data-tone={link.tone} />
      </button>
      {open && (
        <div className="connection-pop" role="dialog" aria-label="Connection">
          <p className="connection-label">{link.label}</p>
          <p>
            <span>Up</span>
            <span>{formatLag(link.upMs)}</span>
          </p>
          <p>
            <span>Down</span>
            <span>{formatLag(link.downMs)}</span>
          </p>
          <p>
            <span>Round trip</span>
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
        <span>{formatClock(hover.t)}</span>
        <strong>{formatPrice(String(sample.price))}</strong>
        {sample.previous != null && <span>{formatSigned(sample.price - sample.previous)} from last</span>}
        {fromOpen != null && side && (
          <span className={side === "flat" ? "push" : side}>
            {side === "flat" ? "= Push" : `${formatSigned(fromOpen)} ${side === "up" ? "Up" : "Down"}`}
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
    <p className={flash ? "peg flash" : "peg"} style={{ top, right }} aria-label="Locked price">
      <span>Locked</span>
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
  const payout = payoutMicros(bet.stakeMicros, bet.side, band.poolUpMicros, band.poolDownMicros, feeBps)
  return (
    <p className={`chip ${bet.side}`} style={{ left, right, top: top + 52 }}>
      <strong>
        {bet.side === "up" ? "▲ Up" : "▼ Down"} {formatMoney(bet.stakeMicros)}
      </strong>
      <span>Gets {formatMoney(payout)}</span>
    </p>
  )
}

function BalanceFigure({ micros }: { micros: number | null }) {
  const [dir, setDir] = useState<"" | "credit" | "debit">("")
  const prevRef = useRef<number | null>(micros)

  useEffect(() => {
    const previous = prevRef.current
    prevRef.current = micros
    if (micros == null || previous == null || previous === micros) {
      if (micros == null) setDir("")
      return
    }
    setDir(micros > previous ? "credit" : "debit")
    const clearDir = window.setTimeout(() => setDir(""), 730)
    return () => window.clearTimeout(clearDir)
  }, [micros])

  return (
    <p className="balance" data-dir={dir}>
      {micros == null ? "$—" : formatMoney(micros)}
    </p>
  )
}

function LockMark({ locked }: { locked: boolean }) {
  return (
    <span className="lock" data-state={locked ? "locked" : "open"} aria-label={locked ? "Price locked" : "Price locking"}>
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

function moveWord(side: "up" | "down" | "push"): string {
  if (side === "up") return "Up"
  if (side === "down") return "Down"
  return "Push"
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
        wordEl.current.textContent = moveWord(delta.side)
        moveEl.current.dataset.side = delta.side
      }
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [priceRef, strike])
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

function TokenBadge({ kind }: { kind: "circle" | "qm" }) {
  const title =
    kind === "circle"
      ? "Circle USDC on Base"
      : "Quick Market USDC on Base Sepolia. Play money, not Circle USDC."
  return (
    <span className="token-badge" data-kind={kind} title={title}>
      {kind === "circle" ? <CircleMark /> : <QmMark />}
      <span>{kind === "circle" ? "USDC" : "QM USDC"}</span>
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
  error: string | null
  phase: "idle" | "phantom" | "confirming" | "pending"
  hash: string | null
  onAmount: (amount: string) => void
  onClose: () => void
  onFund: (amount: string) => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label="Deposit USDC" onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>Deposit</h2>
            <TokenBadge kind="circle" />
            <span className="net-badge" data-testnet="0">
              {chainBadgeText(chainId, chainName)}
            </span>
          </div>
          <button type="button" className="overlay-close" aria-label="Close" onClick={onClose}>
            {"×"}
          </button>
        </header>
        <dl className="overlay-meta">
          <div>
            <dt>Network</dt>
            <dd>{chainNetworkLabel(chainId, chainName)}</dd>
          </div>
          <div>
            <dt>From → To</dt>
            <dd className="route-line">
              {address ? <AddressWithHover address={address} label={label} /> : <span>Wallet</span>}
              <span className="route-arrow" aria-hidden="true">
                →
              </span>
              {treasury ? <AddressWithHover address={treasury} /> : <span>Treasury</span>}
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
            aria-label="Fund amount"
            inputMode="decimal"
            placeholder="Custom amount"
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
            disabled={disabled}
          />
          <button type="button" className="primary" onClick={() => onFund(amount)} disabled={customDisabled}>
            {phase === "phantom" ? "Confirm in Phantom…" : phase === "confirming" || phase === "pending" ? "Waiting for 3 confirmations…" : "Deposit"}
          </button>
        </div>
        {phase === "phantom" && <p className="note pending-note">Confirm in Phantom…</p>}
        {phase === "confirming" && <p className="note pending-note">Waiting for 3 confirmations…</p>}
        {phase === "pending" && (
          <p className="note pending-note" title={hash ?? undefined}>
            Transfer sent. Waiting for the ledger.{hash ? ` ${briefTx(hash)}` : ""}
          </p>
        )}
        {error && <p className="note bad">{error}</p>}
      </div>
    </div>
  )
}

function GrantOverlay({
  chainId,
  chainName,
  grantMicros,
  grantIntervalMs,
  grantAt,
  now,
  granting,
  txHash,
  confirmationsSeen,
  confirmationsNeeded,
  error,
  onClose,
  onGrant,
}: {
  chainId: number
  chainName: string
  grantMicros: number
  grantIntervalMs: number
  grantAt: number | null
  now: number
  granting: boolean
  txHash: string | null
  confirmationsSeen: number
  confirmationsNeeded: number
  error: string | null
  onClose: () => void
  onGrant: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (!granting) return
    const started = Date.now()
    setElapsedMs(0)
    const id = window.setInterval(() => setElapsedMs(Date.now() - started), 200)
    return () => window.clearInterval(id)
  }, [granting])
  const timing = grantTiming(grantAt, now, grantIntervalMs)
  const txUrl = txHash ? grantTxUrl(chainId, txHash) : null
  const waiting = granting
    ? grantWaitStatus(txHash ? { seen: confirmationsSeen, needed: confirmationsNeeded } : undefined)
    : null
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label="Grant QM USDC" onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>Grant</h2>
            <TokenBadge kind="qm" />
            <span className="net-badge" data-testnet="1">
              {chainBadgeText(chainId, chainName)}
            </span>
          </div>
          <button type="button" className="overlay-close" aria-label="Close" onClick={onClose}>
            {"×"}
          </button>
        </header>
        <p className="note grant-copy">{grantSentence(grantMicros, grantIntervalMs)}</p>
        <dl className="overlay-meta">
          <div>
            <dt>Amount</dt>
            <dd>{formatGrantDollars(grantMicros)}</dd>
          </div>
          <div>
            <dt>Next</dt>
            <dd>{grantNextLabel(timing)}</dd>
          </div>
        </dl>
        <button type="button" className="primary grant-submit" onClick={onGrant} disabled={granting || !timing.due}>
          {granting ? "Granting…" : grantButtonLabel(timing, grantMicros)}
        </button>
        {(waiting || txHash) && (
          <div className="grant-progress">
            {waiting && <WaitNote text={waiting} />}
            {granting && <p className="grant-timer">{formatGrantTimer(elapsedMs)}</p>}
            {txHash &&
              (txUrl ? (
                <a className="grant-tx" href={txUrl} target="_blank" rel="noreferrer">
                  {txHash}
                </a>
              ) : (
                <p className="grant-tx">{txHash}</p>
              ))}
          </div>
        )}
        {error && <p className="note bad">{error}</p>}
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
  chainName,
  amount,
  pending,
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
  chainName: string
  amount: string
  pending: boolean
  error: string | null
  onAmount: (value: string) => void
  onMax: () => void
  onClose: () => void
  onSubmit: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  const parsed = parseAmountMicros(amount)
  const submitDisabled = pending || parsed === null || parsed > balanceMicros
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label={testnet ? "Withdraw QM USDC" : "Withdraw USDC"} onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>Withdraw</h2>
            <TokenBadge kind={testnet ? "qm" : "circle"} />
            <span className="net-badge" data-testnet={testnet ? "1" : "0"}>
              {chainBadgeText(chainId, chainName)}
            </span>
          </div>
          <button type="button" className="overlay-close" aria-label="Close" onClick={onClose}>
            {"×"}
          </button>
        </header>
        <dl className="overlay-meta">
          <div>
            <dt>To wallet</dt>
            <dd>{address ? <AddressWithHover address={address} label={label} /> : "—"}</dd>
          </div>
          <div>
            <dt>Spendable</dt>
            <dd>{formatMoney(balanceMicros)}</dd>
          </div>
        </dl>
        <div className="fund-custom">
          <div className="input-with-max">
            <input
              aria-label="Withdraw amount"
              inputMode="decimal"
              placeholder="Amount"
              value={amount}
              onChange={(event) => onAmount(event.target.value)}
              disabled={pending}
            />
            <button type="button" className="max-btn" onClick={onMax} disabled={pending || balanceMicros <= 0}>
              Max
            </button>
          </div>
          <button type="button" className="primary" onClick={onSubmit} disabled={submitDisabled}>
            {pending ? "Withdrawing…" : "Withdraw"}
          </button>
        </div>
        {testnet && <p className="note">Pays QM USDC to your wallet on Base Sepolia.</p>}
        {error && <p className="note bad">{error}</p>}
      </div>
    </div>
  )
}

function Countdown({ endsAt, offsetRef }: { endsAt: number; offsetRef: RefObject<number> }) {
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
      <span className="clock-unit">s</span>
    </span>
  )
}

function SideCard(props: {
  side: Side
  share: string
  pool: number
  quote: string
  players: number
  fade: boolean
  fadeKey: number
  disabled: boolean
  onBet: () => void
}) {
  const up = props.side === "up"
  return (
    <article className={up ? "side up" : "side down"}>
      <p className="side-name">{up ? "▲ Up" : "▼ Down"}</p>
      <div className="side-figures" data-fade={props.fade ? "1" : "0"} key={props.fadeKey}>
        <p className="share">{props.share}</p>
        <p className="pool">
          {formatMoney(props.pool)} · {props.players} {props.players === 1 ? "player" : "players"}
        </p>
        <p className="to-win">{props.quote}</p>
      </div>
      <button type="button" disabled={props.disabled} onClick={props.onBet}>
        <span className="arrow" aria-hidden="true">{up ? "▲" : "▼"}</span>
        <span>{up ? "Buy up" : "Buy down"}</span>
      </button>
    </article>
  )
}

function GrantFollow({
  startedAt,
  txHash,
  seen,
  needed,
  chainId,
  now,
}: {
  startedAt: number
  txHash: string | null
  seen: number
  needed: number
  chainId: number
  now: number
}) {
  if (!txHash) return <WaitNote text={grantWaitStatus()} />
  const elapsed = Math.max(0, now - startedAt)
  const txUrl = grantTxUrl(chainId, txHash)
  return (
    <div className="grant-progress">
      <WaitNote text={grantWaitStatus({ seen, needed })} />
      <p className="grant-timer" aria-label={`Elapsed time ${formatGrantTimer(elapsed)}`}>
        {formatGrantTimer(elapsed)}
      </p>
      {txUrl ? (
        <a className="grant-tx" href={txUrl} target="_blank" rel="noreferrer">
          {txHash}
        </a>
      ) : (
        <p className="grant-tx">{txHash}</p>
      )}
    </div>
  )
}

function WaitNote({
  text,
  steps,
  phase,
}: {
  text: string
  steps?: readonly string[]
  phase?: "phantom" | "sign" | "session"
}) {
  return (
    <p className="wait-status" role="status" aria-live="polite">
      <span className="wait-spin" aria-hidden="true" />
      <span className="wait-body">
        <span key={text} className="wait-copy">
          {text}
        </span>
        {steps && phase && (
          <span className="wait-steps" aria-hidden="true">
            {steps.map((step, index) => {
              const state = loginStepState(index, phase)
              return (
                <span key={step} data-state={state}>
                  <span className="step-check" />
                  {step}
                </span>
              )
            })}
          </span>
        )}
      </span>
    </p>
  )
}

function History({ token, version, windowMs }: { token: string | null; version: number; windowMs: number }) {
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
    const mark = historyMark(row)
    return mark ? [{ id: row.id, ...mark }] : []
  })

  return (
    <details className="history">
      <summary>
        <h2>
          Previous markets
          <span className="history-count">(last 10)</span>
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
          All
        </button>
        <button type="button" className={mine ? "on" : ""} onClick={() => setMine(true)} disabled={!token}>
          My trades
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="empty">No settled rounds yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Result</th>
              <th>Open</th>
              <th>Close</th>
              <th>Up</th>
              <th>Down</th>
              <th>Feed</th>
              {mine && (
                <>
                  <th>Bought</th>
                  <th>Back</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} onClick={() => setReplay(row)} className={replay?.id === row.id ? "open" : ""}>
                <td>{formatClock(row.startsAt)}</td>
                <td className={resultTone(row)}>{resultText(row)}</td>
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
  return (
    <>
      {rows.map((row) => {
        const paid = payout?.(row)
        if (!payout) {
          return (
            <li key={row.address}>
              <span className="addr">{shortAddress(row.address)}</span>
              <span className={row.side}>{row.side === "up" ? "▲ Up" : "▼ Down"}</span>
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
        aria-label="Market replay"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <div className="replay-title">
              <h2>{formatClock(row.startsAt)}</h2>
              <FeedBadge source={row.source} />
            </div>
            <p>
              {resultText(row)}
              {row.strike && row.settle ? ` · ${formatPrice(row.strike)} → ${formatPrice(row.settle)}` : ""}
              {` · Up ${formatMoney(row.poolUpMicros)} · Down ${formatMoney(row.poolDownMicros)}`}
            </p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <section className="chart-wrap still" onPointerMove={scrub.move} onPointerLeave={scrub.clear}>
          <canvas ref={canvasRef} />
          {chart && <ChartOverlay chart={chart} board={board} openBuyIns={[]} feeBps={0} hover={scrub.hover} />}
        </section>
        {failed && <p className="empty">Couldn't load this market.</p>}
        {buyIns && buyIns.length === 0 && <p className="empty">No one in this pool.</p>}
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

function LateToast({ onDone }: { onDone: () => void }) {
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    const id = window.setTimeout(() => doneRef.current(), 4_500)
    return () => window.clearTimeout(id)
  }, [])
  return (
    <button type="button" className="toast late" onClick={onDone}>
      <span>{LATE_BUY_IN_ERROR}</span>
    </button>
  )
}

function ResultToast({ event, address, onDone }: { event: SettledMessage; address: string | null; onDone: () => void }) {
  const mine = address ? (event.payouts.find((payout) => payout.address === address) ?? null) : null
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    const id = window.setTimeout(() => doneRef.current(), 4_500)
    return () => window.clearTimeout(id)
  }, [])
  if (!mine) return null

  const tone = toastTone(event, mine.stakeMicros, mine.payoutMicros)
  const title = event.resolution === "void" ? "Void" : tone === "win" ? "You win" : tone === "loss" ? "Lost" : "= Push"
  const move = event.strike && event.settle ? moveText(event.strike, event.settle) : null
  const figures = formatReturn(mine.stakeMicros, mine.payoutMicros)
  const glyph = mine.side === "up" ? "▲" : "▼"
  return (
    <button type="button" className={`toast ${tone}`} onClick={onDone}>
      <span>
        <strong>{title}</strong>
        {move && <small>{move}</small>}
        <small>
          {glyph} Bought {formatMoney(mine.stakeMicros)}
        </small>
      </span>
      <b>
        {figures.back}
        {figures.profit && <span className="profit"> ({figures.profit})</span>}
      </b>
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

function historyMark(row: HistoryRound): { glyph: string; tone: string; name: string } | null {
  if (row.status === "void" || row.resolution === "void") return { glyph: "∅", tone: "void", name: "Void" }
  if (row.winningSide === "push") return { glyph: "=", tone: "push", name: "Push" }
  if (row.winningSide === "up") return { glyph: "▲", tone: "up", name: "Up" }
  if (row.winningSide === "down") return { glyph: "▼", tone: "down", name: "Down" }
  return null
}

function resultTone(row: HistoryRound): string {
  if (row.status === "void" || row.resolution === "void") return "void"
  if (row.winningSide === "push") return "push"
  if (row.winningSide === "up" || row.winningSide === "down") return row.winningSide
  return ""
}

function resultText(row: HistoryRound): string {
  if (row.status === "void" || row.resolution === "void") return "Void"
  if (row.winningSide === "push") return "= Push"
  if (row.winningSide === "up") return "▲ Up"
  if (row.winningSide === "down") return "▼ Down"
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

function toastTone(event: SettledMessage, stake: number, payout: number): string {
  if (event.resolution === "void") return "void"
  if (payout > stake) return "win"
  if (payout === 0) return "loss"
  return "push"
}

function moveText(strike: string, settle: string): string | null {
  const delta = formatPriceDelta(settle, strike)
  if (!delta) return null
  const from = formatPrice(strike)
  const to = formatPrice(settle)
  if (delta.side === "push") return `${from} = ${to} ($0.00)`
  const glyph = delta.side === "up" ? "▲" : "▼"
  const sign = delta.side === "up" ? "+" : "−"
  return `${from} ${glyph} ${to} (${sign}$${delta.text.slice(1)})`
}
