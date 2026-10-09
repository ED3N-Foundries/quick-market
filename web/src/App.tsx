import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { mountChart, type ChartScale, type TapeChart, type TapeSample } from "./chart"
import { focusPool, followWindow, heldMarket } from "./focus"
import { botLabel, formatClock, formatGainLoss, formatMoney, formatPrice, formatPriceDelta, formatSigned, microsToInput, moneyShare, parseAmountMicros, payoutMicros, quoteDollar, quotePair, randomAddress, shortAddress, sourceLabel } from "./format"
import type { Band, Board, HistoryRound, OpenBet, SettledMessage, Side } from "./types"
import { useMarket } from "./useMarket"

export function App() {
  const market = useMarket()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const viewRef = useRef({ follow: true, start: 0, end: 0 })
  const boardRef = useRef(market.board)
  const openBetsRef = useRef<OpenBet[]>([])
  const [chart, setChart] = useState<TapeChart | null>(null)
  const [stake, setStake] = useState("10")
  const [fundAmount, setFundAmount] = useState("")
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  const scrub = useScrub(chart)
  boardRef.current = market.board
  openBetsRef.current = market.you?.openBets ?? []

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
        const frame = followWindow(board, openBetsRef.current, now)
        return { blockStart: frame.start, blockEnd: frame.end }
      },
      getMarkets: () => {
        const board = boardRef.current
        if (!board) return []
        const held = heldMarket(board, openBetsRef.current, Date.now() + market.offsetRef.current)
        if (!held) return []
        return [
          {
            id: held.id,
            betsOpen: held.betsOpen,
            strikeAt: held.strikeAt,
            settlesAt: held.settlesAt,
            strike: held.strike === null ? null : Number(held.strike),
          },
        ]
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
  const canBet = !!you && !heldSpan && board?.phase === "bets" && !!board.join && market.feed === "live" && !market.pending
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
        <PriceReadout priceRef={market.priceRef} strike={heldSpan?.strike ?? null} source={market.config.source} />
        <div className="clock-block">
          <span className="clock-label">{heldSpan ? "Settles" : "Bets"}</span>
          {board ? (
            <Countdown
              endsAt={heldSpan ? heldSpan.settlesAt : board.phase === "bets" ? board.windowEndsAt : board.blockEnd}
              offsetRef={market.offsetRef}
            />
          ) : (
            <strong className="clock">—</strong>
          )}
          {market.result && <span className="last-result">{market.result}</span>}
        </div>
      </header>

      <section className="chart-wrap" onPointerDown={onPointerDown} onPointerMove={scrub.move} onPointerLeave={scrub.clear}>
        <canvas ref={canvasRef} />
        {chart && (
          <ChartOverlay
            chart={chart}
            board={board}
            shade={heldSpan && now >= heldSpan.strikeAt ? { betsOpen: heldSpan.betsOpen, strikeAt: heldSpan.strikeAt } : null}
            heldId={heldSpan?.id ?? null}
            openBets={openBets}
            feeBps={market.config.feeBps}
            hover={scrub.hover}
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
            {market.address ? (
              <span className="who">
                {shortAddress(market.address)}
                <small>Demo</small>
              </span>
            ) : (
              <button type="button" className="primary" onClick={() => market.connect(randomAddress())}>
                Connect
              </button>
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
        <div className="funding">
          <div className="funds">
            <button type="button" onClick={() => market.fundWallet("10")} disabled={!you}>
              +$10
            </button>
            <button type="button" onClick={() => market.fundWallet("1000")} disabled={!you}>
              +$1,000
            </button>
          </div>
          <div className="fund-custom">
            <input
              aria-label="Fund amount"
              inputMode="decimal"
              placeholder="Amount"
              value={fundAmount}
              onChange={(event) => setFundAmount(event.target.value)}
              disabled={!you}
            />
            <button type="button" onClick={() => market.fundWallet(fundAmount)} disabled={!you || fundMicros === null}>
              Fund
            </button>
          </div>
        </div>
      </section>

      <details className="tray">
        <summary>
          <h2>This pool</h2>
          <span>{focus && focus.tray.length > 0 ? `${focus.tray.length} playing` : ""}</span>
        </summary>
        {focus && focus.tray.length > 0 ? (
          <ul>
            {focus.tray.map((row) => (
              <li key={row.address}>
                <span className={row.bot ? "bot" : "addr"}>{row.bot ? botLabel(row.address) : shortAddress(row.address)}</span>
                <span className={row.side}>{row.side === "up" ? "▲ Up" : "▼ Down"}</span>
                <span className="amt">{formatMoney(row.stakeMicros)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No one in this pool yet.</p>
        )}
      </details>

      <History address={market.address} version={market.historyVersion} windowMs={market.config.windowSeconds * 1000} />
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
  shade,
  heldId,
  openBets,
  feeBps,
  hover,
}: {
  chart: TapeChart
  board: Board | null
  shade: { betsOpen: number; strikeAt: number } | null
  heldId: number | null
  openBets: OpenBet[]
  feeBps: number
  hover: { t: number } | null
}) {
  const current = useSyncExternalStore(chart.subscribe, chart.getScale, chart.getScale)
  if (!current || !board) return null
  const span = Math.max(1, current.viewEnd - current.viewStart)
  const xAt = (t: number) => current.plotLeft + ((t - current.viewStart) / span) * current.plotWidth

  return (
    <div className="chart-overlay">
      {board.bands.map((band) => {
        if (heldId != null && band.id !== heldId) return null
        const left = xAt(band.betsOpen)
        const right = xAt(band.strikeAt)
        if (right - left < 2 || right < 0 || left > current.width) return null
        const open = heldId == null && band.id === board.join?.id && board.phase === "bets"
        return (
          <div
            key={`w-${band.id}`}
            className={open ? "window-span on" : "window-span"}
            style={{ left, width: right - left, top: current.plotTop, height: current.plotHeight }}
          >
            {open && <span>Bets</span>}
          </div>
        )
      })}
      {shade && <LockShade betsOpen={shade.betsOpen} strikeAt={shade.strikeAt} scale={current} xAt={xAt} />}
      {openBets.map((bet) => {
        const band = board.bands.find((row) => row.id === bet.roundId) ?? (board.join?.id === bet.roundId ? board.join : null)
        if (!band) return null
        return (
          <BetChip
            key={bet.roundId}
            bet={bet}
            band={band}
            left={Math.max(current.plotLeft, xAt(band.strikeAt)) + 8}
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

function LockShade({
  betsOpen,
  strikeAt,
  scale,
  xAt,
}: {
  betsOpen: number
  strikeAt: number
  scale: ChartScale
  xAt: (t: number) => number
}) {
  const plotRight = scale.plotLeft + scale.plotWidth
  const left = Math.max(xAt(betsOpen), scale.plotLeft)
  const right = Math.min(xAt(strikeAt), plotRight)
  if (right - left < 8) return null
  return (
    <div className="lock-shade" style={{ left, width: right - left, top: scale.plotTop, height: scale.plotHeight }}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          fill="currentColor"
          d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1h1zm2 0h6V7a3 3 0 0 0-6 0v3z"
        />
      </svg>
      <span>Locked</span>
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

function BetChip({
  bet,
  band,
  left,
  top,
  feeBps,
}: {
  bet: OpenBet
  band: Band
  left: number
  top: number
  feeBps: number
}) {
  const payout = payoutMicros(bet.stakeMicros, bet.side, band.poolUpMicros, band.poolDownMicros, feeBps)
  return (
    <p className={`chip ${bet.side}`} style={{ left, top: top + 52 }}>
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
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const price = priceRef.current
      if (priceEl.current) priceEl.current.textContent = price ? formatPrice(price) : "—"
      if (deltaEl.current) {
        const delta = price && strike ? formatPriceDelta(price, strike) : null
        if (delta) {
          deltaEl.current.textContent = delta.text
          deltaEl.current.dataset.side = delta.side
        } else {
          deltaEl.current.textContent = ""
          deltaEl.current.dataset.side = "flat"
        }
      }
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [priceRef, strike])
  return (
    <div className="price-block">
      <div>
        <span className="quote">{quotePair(source)}</span>
        <span ref={priceEl} className="price">
          —
        </span>
      </div>
      <span ref={deltaEl} className="delta" data-side="flat" />
    </div>
  )
}

function Countdown({ endsAt, offsetRef }: { endsAt: number; offsetRef: RefObject<number> }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const left = Math.max(0, endsAt - (Date.now() + offsetRef.current))
      if (ref.current) ref.current.textContent = (left / 1000).toFixed(1)
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [endsAt, offsetRef])
  return (
    <strong ref={ref} className="clock">
      0.0
    </strong>
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
        {up ? "Bet up" : "Bet down"}
      </button>
    </article>
  )
}

function History({ address, version, windowMs }: { address: string | null; version: number; windowMs: number }) {
  const [mine, setMine] = useState(false)
  const [rows, setRows] = useState<HistoryRound[]>([])
  const [replay, setReplay] = useState<HistoryRound | null>(null)

  useEffect(() => {
    const params = new URLSearchParams({ limit: "30" })
    if (mine && address) {
      params.set("mine", "1")
      params.set("address", address)
    }
    let cancel = false
    fetch(`/api/rounds?${params}`)
      .then((response) => response.json())
      .then((body) => {
        if (!cancel) setRows(body.rounds ?? [])
      })
      .catch(() => {})
    return () => {
      cancel = true
    }
  }, [address, mine, version])

  return (
    <section className="history">
      <header>
        <h2>Previous rounds</h2>
        <div className="filters">
          <button type="button" className={!mine ? "on" : ""} onClick={() => setMine(false)}>
            All
          </button>
          <button type="button" className={mine ? "on" : ""} onClick={() => setMine(true)} disabled={!address}>
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
        const strike = row.strike == null ? null : Number(row.strike)
        const betsOpen = row.startsAt - windowMs
        viewRef.current = { follow: false, start: betsOpen, end: row.endsAt }
        spawned = mountChart(canvas, {
          getNow: () => row.endsAt + 1,
          getView: () => viewRef.current,
          getClock: () => null,
          getMarkets: () => [
            {
              id: row.id,
              betsOpen,
              strikeAt: row.startsAt,
              settlesAt: row.endsAt,
              strike,
            },
          ],
          extendLive: () => false,
        })
        spawned.reset(tape.map((point) => ({ t: point.t, price: Number(point.price) })))
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
          {chart && <ChartOverlay chart={chart} board={board} shade={null} heldId={null} openBets={[]} feeBps={0} hover={scrub.hover} />}
        </section>
        {failed && <p className="empty">Couldn't load this market.</p>}
        {bets && bets.length === 0 && <p className="empty">No bets in this pool.</p>}
        {bets && bets.length > 0 && (
          <div className="detail">
            <ul>
              {bets.map((bet) => (
                <li key={bet.address}>
                  <span className={bet.bot ? "bot" : ""}>{bet.bot ? botLabel(bet.address) : shortAddress(bet.address)}</span>
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
  const move = event.strike && event.settle ? `${formatPrice(event.strike)} → ${formatPrice(event.settle)}` : null
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
