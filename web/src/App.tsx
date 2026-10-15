import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { mountChart, priceY, type ChartScale, type TapeChart, type TapeSample } from "./chart"
import { chartMarket, focusPool, followWindow, heldMarket, heldStrike } from "./focus"
import { formatClock, formatDollarMove, formatGainLoss, formatMoney, formatPrice, formatPriceDelta, formatSigned, microsToInput, moneyShare, parseAmountMicros, payoutMicros, quoteDollar, quotePair, shortAddress, sourceLabel } from "./format"
import type { Band, Board, HistoryRound, OpenBet, SettledMessage, Side } from "./types"
import { useMarket } from "./useMarket"
import { ConnectButton, useSession } from "./wallet"

export function App() {
  const session = useSession()
  const market = useMarket(session.token)
  const expireRef = useRef(session.expire)
  expireRef.current = session.expire
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const viewRef = useRef({ follow: true, start: 0, end: 0 })
  const viewSecondsRef = useRef(market.config.viewSeconds)
  const boardRef = useRef(market.board)
  const openBetsRef = useRef<OpenBet[]>([])
  const [chart, setChart] = useState<TapeChart | null>(null)
  const [stake, setStake] = useState("10")
  const [fundAmount, setFundAmount] = useState("")
  const [fundOpen, setFundOpen] = useState(false)
  const [fundError, setFundError] = useState<string | null>(null)
  const [funding, setFunding] = useState(false)
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  const scrub = useScrub(chart)
  boardRef.current = market.board
  openBetsRef.current = market.you?.openBets ?? []
  viewSecondsRef.current = market.config.viewSeconds

  useEffect(() => {
    if (market.unauthorized) expireRef.current()
  }, [market.unauthorized])

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
        const frame = followWindow(board, openBetsRef.current, now, (viewSecondsRef.current || 5) * 1000)
        return { blockStart: frame.start, blockEnd: frame.end }
      },
      getStrike: () => {
        const board = boardRef.current
        if (!board) return null
        const now = Date.now() + market.offsetRef.current
        const riding = chartMarket(board, openBetsRef.current, now)
        const strike = heldStrike(riding)
        if (!strike || !riding) return null
        return { ...strike, peg: true, at: riding.strikeAt, openAt: riding.betsOpen }
      },
      getAim: () => {
        const board = boardRef.current
        if (!board) return null
        const now = Date.now() + market.offsetRef.current
        const held = heldMarket(board, openBetsRef.current, now)
        if (!held) return null
        return openBetsRef.current.find((bet) => bet.roundId === held.id)?.side ?? null
      },
      extendLive: () => true,
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
  const openBets = you?.openBets ?? []
  const now = Date.now() + market.offsetRef.current
  const heldSpan = board ? heldMarket(board, openBets, now) : null
  const focus = focusPool(board, openBets, now)
  const canBet = !!you && !heldSpan && !!board?.join && market.feed === "live" && !market.pending
  const total = (focus?.poolUpMicros ?? 0) + (focus?.poolDownMicros ?? 0)
  const held = openBets.find((bet) => bet.roundId === focus?.id) ?? null
  const upQuote = focus ? quoteDollar("up", focus.poolUpMicros, focus.poolDownMicros, market.config.feeBps) : "—"
  const downQuote = focus ? quoteDollar("down", focus.poolUpMicros, focus.poolDownMicros, market.config.feeBps) : "—"
  const ticketWin = held ? payoutMicros(held.stakeMicros, held.side, focus?.poolUpMicros ?? 0, focus?.poolDownMicros ?? 0, market.config.feeBps) : 0
  const fundMicros = parseAmountMicros(fundAmount)

  async function onWithdraw() {
    const message = await market.withdrawWallet(withdrawAmount)
    if (message) {
      setWithdrawError(message)
      return
    }
    setWithdrawError(null)
    setWithdrawAmount("")
  }

  function chip(percent: number) {
    if (!you) return
    setStake(microsToInput(Math.max(market.config.minStakeMicros, Math.floor((you.balanceMicros * percent) / 100))))
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
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
          <span className="mark">Quick</span>
          <span className="pair">BTC</span>
        </div>
        <div className="clock-cluster" data-move={heldSpan?.strike ? "1" : "0"}>
          <PriceReadout priceRef={market.priceRef} strike={heldSpan?.strike ?? null} source={market.config.source} />
          <div className="clock-block">
            <span className="clock-label">{heldSpan ? "Settles" : "Bets"}</span>
            {board ? (
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

      <section className="chart-wrap" onPointerDown={onPointerDown} onPointerMove={scrub.move} onPointerLeave={scrub.clear}>
        <canvas ref={canvasRef} />
        {chart && (
          <ChartOverlay
            chart={chart}
            board={board}
            openBets={openBets}
            feeBps={market.config.feeBps}
            hover={scrub.hover}
            offsetRef={market.offsetRef}
          />
        )}
        {market.feed === "stale" && <p className="feed-flag">Price delayed</p>}
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
          share={moneyShare(focus?.poolUpMicros ?? 0, total)}
          pool={focus?.poolUpMicros ?? 0}
          quote={upQuote}
          players={focus?.playersUp ?? 0}
          disabled={!canBet}
          onBet={() => market.place("up", stake)}
        />
        <div className="stake">
          <div className="balance-label">
            <span>Spendable</span>
            {session.projectReady && session.address ? (
              <ConnectButton.Custom>
                {({ account, chain, openAccountModal, openChainModal, mounted }) => {
                  if (!mounted || !account) {
                    return (
                      <button type="button" className="primary" onClick={session.connect}>
                        Connect
                      </button>
                    )
                  }
                  const wrong = Boolean(chain?.unsupported || chain?.id !== market.config.chainId)
                  return (
                    <span className="who">
                      <span className="who-line">
                        <button type="button" className="plain" onClick={openAccountModal}>
                          {shortAddress(account.address)}
                        </button>
                        <button
                          type="button"
                          className="fund-plus"
                          aria-label="Deposit"
                          onClick={() => {
                            setFundError(null)
                            setFundOpen(true)
                          }}
                          disabled={!session.token || funding}
                        >
                          +
                        </button>
                      </span>
                      {wrong ? (
                        <button type="button" className="plain" onClick={openChainModal}>
                          Switch network
                        </button>
                      ) : (
                        <small>{session.signing ? "Signing" : session.signError ? "Sign in" : market.config.chainName}</small>
                      )}
                      {session.signError && !session.token && (
                        <button type="button" className="plain" onClick={session.signIn}>
                          Sign in
                        </button>
                      )}
                    </span>
                  )
                }}
              </ConnectButton.Custom>
            ) : (
              <span className="who">
                <button type="button" className="primary" onClick={session.connect} disabled={!session.projectReady}>
                  Connect
                </button>
                {!session.projectReady && !session.chainError && <small>Set WALLETCONNECT_PROJECT_ID</small>}
              </span>
            )}
          </div>
          <BalanceFigure micros={you?.balanceMicros ?? null} />
          {held && (
            <div className="ticket">
              <p className={held.side}>{held.side === "up" ? "▲ Up" : "▼ Down"}</p>
              <p>Staked {formatMoney(held.stakeMicros)}</p>
              <p>To win {formatMoney(ticketWin)}</p>
            </div>
          )}
          <label className="stake-field">
            <span>Stake</span>
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
          {market.error && <p className="note bad">{market.error}</p>}
        </div>
        <SideCard
          side="down"
          share={moneyShare(focus?.poolDownMicros ?? 0, total)}
          pool={focus?.poolDownMicros ?? 0}
          quote={downQuote}
          players={focus?.playersDown ?? 0}
          disabled={!canBet}
          onBet={() => market.place("down", stake)}
        />
      </section>
      {fundOpen && (
        <FundOverlay
          amount={fundAmount}
          disabled={!session.token || funding}
          customDisabled={!session.token || funding || fundMicros === null}
          error={fundError}
          onAmount={setFundAmount}
          onClose={() => setFundOpen(false)}
          onFund={(amount) => {
            const micros = parseAmountMicros(amount)
            if (micros === null) return
            const target = (you?.balanceMicros ?? 0) + micros
            setFunding(true)
            setFundError(null)
            void session.deposit(amount, market.config.treasury, market.config.usdc, market.config.chainId).then(async (message) => {
              if (message) {
                setFundError(message)
                setFunding(false)
                return
              }
              const updated = await market.waitForBalance(target)
              setFunding(false)
              if (!updated) setFundError("Deposit sent. It will show after confirmation.")
              else setFundOpen(false)
            })
          }}
        />
      )}

      <details className="tray">
        <summary>
          <h2>This pool</h2>
          <span>{focus && focus.tray.length > 0 ? `${focus.tray.length} playing` : ""}</span>
        </summary>
        {focus && focus.tray.length > 0 ? (
          <ul>
            {focus.tray.map((row) => (
              <li key={row.address}>
                <span className={row.bot ? "bot" : "addr"}>{row.bot ? "Bot" : shortAddress(row.address)}</span>
                <span className={row.side}>{row.side === "up" ? "▲ Up" : "▼ Down"}</span>
                <span className="amt">{formatMoney(row.stakeMicros)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No one in this pool yet.</p>
        )}
      </details>

      <History token={session.token} version={market.historyVersion} windowMs={market.config.windowSeconds * 1000} />
      {market.notices.length > 0 && (
        <div className="toasts">
          {market.notices.map((event) => (
            <ResultToast
              key={event.roundId}
              event={event}
              address={market.address}
              onDone={() => market.dismissNotice(event.roundId)}
            />
          ))}
        </div>
      )}

      <footer className="footer">
        <div className="rules">
          <p className="periods">
            Bets {market.config.windowSeconds}s · Market {market.config.marketSeconds}s
          </p>
          <p>Up finishes above the open. Down finishes below. Push is a tie, and stakes return.</p>
          <p>If a market never gets a price, it is void and stakes return.</p>
          <p>
            {(market.config.feeBps / 100).toFixed(2)}% fee on a paid pool. Price from {sourceLabel(market.config.source)}.
          </p>
        </div>
        <div className="withdraw">
          <label>
            <span>Withdraw</span>
            <input
              aria-label="Withdraw amount"
              inputMode="decimal"
              placeholder="Amount"
              value={withdrawAmount}
              onChange={(event) => {
                setWithdrawAmount(event.target.value)
                setWithdrawError(null)
              }}
              disabled={!you}
            />
          </label>
          <button type="button" onClick={() => void onWithdraw()} disabled={!you || !withdrawAmount.trim()}>
            Withdraw
          </button>
          {withdrawError && <p className="note bad">{withdrawError}</p>}
        </div>
      </footer>
    </div>
  )
}

function ChartOverlay({
  chart,
  board,
  openBets,
  feeBps,
  hover,
  offsetRef,
}: {
  chart: TapeChart
  board: Board | null
  openBets: OpenBet[]
  feeBps: number
  hover: { t: number } | null
  offsetRef?: RefObject<number>
}) {
  const current = useSyncExternalStore(chart.subscribe, chart.getScale, chart.getScale)
  if (!current || !board) return null
  const span = Math.max(1, current.viewEnd - current.viewStart)
  const xAt = (t: number) => current.plotLeft + ((t - current.viewStart) / span) * current.plotWidth
  const now = Date.now() + (offsetRef?.current ?? 0)
  const riding = chartMarket(board, openBets, now)
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
      {openBets.map((bet) => {
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
  bet: OpenBet
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
      <span>To win {formatMoney(payout)}</span>
    </p>
  )
}

function BalanceFigure({ micros }: { micros: number | null }) {
  const [shown, setShown] = useState<number | null>(micros)
  const [dir, setDir] = useState<"" | "up" | "down">("")
  const shownRef = useRef(shown)
  const readyRef = useRef(false)
  shownRef.current = shown

  useEffect(() => {
    if (micros == null) {
      readyRef.current = false
      setShown(null)
      setDir("")
      return
    }
    const previous = shownRef.current
    if (!readyRef.current || previous == null) {
      readyRef.current = true
      setShown(micros)
      return
    }
    if (previous === micros) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    setDir(micros > previous ? "up" : "down")
    const clearDir = window.setTimeout(() => setDir(""), 730)
    if (reduce) {
      setShown(micros)
      return () => window.clearTimeout(clearDir)
    }
    const from = previous
    const started = performance.now()
    let frame = 0
    const step = (stamp: number) => {
      const t = Math.min(1, (stamp - started) / 450)
      const eased = 1 - (1 - t) * (1 - t)
      setShown(Math.round(from + (micros - from) * eased))
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(clearDir)
    }
  }, [micros])

  return (
    <p className="balance" data-dir={dir}>
      {shown == null ? "—" : formatMoney(shown)}
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
  source,
}: {
  priceRef: RefObject<string | null>
  strike: string | null
  source: string
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
        <span className="quote">{quotePair(source)}</span>
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

function FundOverlay({
  amount,
  disabled,
  customDisabled,
  error,
  onAmount,
  onClose,
  onFund,
}: {
  amount: string
  disabled: boolean
  customDisabled: boolean
  error: string | null
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
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label="Deposit" onClick={(event) => event.stopPropagation()}>
        <div className="funds">
          <button type="button" onClick={() => onFund("10")} disabled={disabled}>
            +$10
          </button>
          <button type="button" onClick={() => onFund("1000")} disabled={disabled}>
            +$1,000
          </button>
        </div>
        <div className="fund-custom">
          <input
            aria-label="Fund amount"
            inputMode="decimal"
            placeholder="Amount"
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
            disabled={disabled}
          />
          <button type="button" onClick={() => onFund(amount)} disabled={customDisabled}>
            Deposit
          </button>
        </div>
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
  disabled: boolean
  onBet: () => void
}) {
  const up = props.side === "up"
  return (
    <article className={up ? "side up" : "side down"}>
      <p className="side-name">{up ? "▲ Up" : "▼ Down"}</p>
      <p className="share">{props.share}</p>
      <p className="pool">
        {formatMoney(props.pool)} · {props.players} {props.players === 1 ? "player" : "players"}
      </p>
      <p className="to-win">{props.quote}</p>
      <button type="button" disabled={props.disabled} onClick={props.onBet}>
        <span className="arrow" aria-hidden="true">{up ? "▲" : "▼"}</span>
        <span>{up ? "Bet up" : "Bet down"}</span>
      </button>
    </article>
  )
}

function History({ token, version, windowMs }: { token: string | null; version: number; windowMs: number }) {
  const [mine, setMine] = useState(false)
  const [rows, setRows] = useState<HistoryRound[]>([])
  const [replay, setReplay] = useState<HistoryRound | null>(null)

  useEffect(() => {
    const params = new URLSearchParams({ limit: "30" })
    if (mine && token) params.set("mine", "1")
    let cancel = false
    const headers: HeadersInit = mine && token ? { authorization: `Bearer ${token}` } : {}
    fetch(`/api/rounds?${params}`, { headers })
      .then((response) => response.json())
      .then((body) => {
        if (!cancel) setRows(body.rounds ?? [])
      })
      .catch(() => {})
    return () => {
      cancel = true
    }
  }, [token, mine, version])

  return (
    <section className="history">
      <header>
        <h2>Previous rounds</h2>
        <div className="filters">
          <button type="button" className={!mine ? "on" : ""} onClick={() => setMine(false)}>
            All
          </button>
          <button type="button" className={mine ? "on" : ""} onClick={() => setMine(true)} disabled={!token}>
            My plays
          </button>
        </div>
      </header>
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
              <th>Fee</th>
              {mine && (
                <>
                  <th>Side</th>
                  <th>Stake</th>
                  <th>Gain/loss</th>
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
                <td>{formatMoney(row.feeMicros)}</td>
                {mine && (
                  <>
                    <td className={row.mySide ?? ""}>{sideText(row.mySide)}</td>
                    <td>{row.myStakeMicros !== undefined ? formatMoney(row.myStakeMicros) : "—"}</td>
                    <td className={gainTone(row.myStakeMicros, row.myPayoutMicros)}>
                      {row.myStakeMicros !== undefined && row.myPayoutMicros != null
                        ? formatGainLoss(row.myStakeMicros, row.myPayoutMicros)
                        : "—"}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {replay && <Replay row={replay} windowMs={windowMs} onClose={() => setReplay(null)} />}
    </section>
  )
}

type RoundBet = { address: string; side: Side; stakeMicros: number; payoutMicros: number | null; bot: boolean }

function Replay({ row, windowMs, onClose }: { row: HistoryRound; windowMs: number; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [chart, setChart] = useState<TapeChart | null>(null)
  const [bets, setBets] = useState<RoundBet[] | null>(null)
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
        const betsOpen = row.startsAt - windowMs
        viewRef.current = { follow: false, start: betsOpen, end: row.endsAt }
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
        setBets(body.bets ?? [])
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
        betsOpen: row.startsAt - windowMs,
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
            <h2>{formatClock(row.startsAt)}</h2>
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
          {chart && <ChartOverlay chart={chart} board={board} openBets={[]} feeBps={0} hover={scrub.hover} />}
        </section>
        {failed && <p className="empty">Couldn't load this market.</p>}
        {bets && bets.length === 0 && <p className="empty">No bets in this pool.</p>}
        {bets && bets.length > 0 && (
          <div className="detail">
            <ul>
              {bets.map((bet) => (
                <li key={bet.address}>
                  <span className={bet.bot ? "bot" : ""}>{bet.bot ? "Bot" : shortAddress(bet.address)}</span>
                  <span className={bet.side}>{bet.side === "up" ? "▲ Up" : "▼ Down"}</span>
                  <span>{formatMoney(bet.stakeMicros)}</span>
                  <span className={bet.payoutMicros === null ? "" : gainTone(bet.stakeMicros, bet.payoutMicros)}>
                    {bet.payoutMicros === null ? "—" : formatGainLoss(bet.stakeMicros, bet.payoutMicros)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
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
  return (
    <button type="button" className={`toast ${tone}`} onClick={onDone}>
      <span>
        <strong>{title}</strong>
        {move && <small>{move}</small>}
      </span>
      <b>{formatGainLoss(mine.stakeMicros, mine.payoutMicros)}</b>
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

function sideText(side: Side | undefined): string {
  if (side === "up") return "▲ Up"
  if (side === "down") return "▼ Down"
  return "—"
}

function gainTone(stake: number | undefined, payout: number | null | undefined): string {
  if (stake === undefined || payout == null) return ""
  if (payout > stake) return "up"
  if (payout === 0) return "down"
  return "push"
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
