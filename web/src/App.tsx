import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { mountChart, type ChartScale, type TapeChart, type TapeSample } from "./chart"
import { botLabel, formatCents, formatClock, formatMicros, formatPrice, formatSigned, microsToInput, moneyShare, quotePair, randomAddress, shortAddress, sourceLabel, takeMicros } from "./format"
import type { Band, Board, HistoryRound, OpenBet, SettledMessage, Side } from "./types"
import { useMarket } from "./useMarket"

export function App() {
  const market = useMarket()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const viewRef = useRef({ follow: true, start: 0, end: 0 })
  const boardRef = useRef(market.board)
  const [chart, setChart] = useState<TapeChart | null>(null)
  const [stake, setStake] = useState("10")
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [following, setFollowing] = useState(true)
  const scrub = useScrub(chart)
  boardRef.current = market.board

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const next = mountChart(canvas, {
      getNow: () => Date.now() + market.offsetRef.current,
      getView: () => viewRef.current,
      getClock: () => {
        const board = boardRef.current
        return board ? { blockStart: board.blockStart, blockEnd: board.blockEnd } : null
      },
      getMarkets: () =>
        (boardRef.current?.bands ?? []).map((band) => ({
          id: band.id,
          betsOpen: band.betsOpen,
          strikeAt: band.strikeAt,
          settlesAt: band.settlesAt,
          strike: band.strike === null ? null : Number(band.strike),
        })),
      getBaseline: () => baselineOf(boardRef.current),
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
  const focus = board?.phase === "bets" ? board.join : board?.live
  const joined = !!board?.join && !!you?.openBets.some((bet) => bet.roundId === board.join?.id)
  const canBet = !!you && board?.phase === "bets" && !!board.join && market.feed === "live" && !joined && !market.pending
  const total = (focus?.poolUpMicros ?? 0) + (focus?.poolDownMicros ?? 0)

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
        <PriceReadout priceRef={market.priceRef} strike={board?.live?.strike ?? null} source={market.config.source} />
        <div className="clock-block">
          <span className="clock-label">{board?.phase === "market" ? "Market" : "Bets"}</span>
          {board ? (
            <Countdown endsAt={board.phase === "bets" ? board.windowEndsAt : board.blockEnd} offsetRef={market.offsetRef} />
          ) : (
            <strong className="clock">—</strong>
          )}
          {market.result && <span className="last-result">{market.result}</span>}
        </div>
        <div className="wallet">
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
      </header>

      <section className="chart-wrap" onPointerDown={onPointerDown} onPointerMove={scrub.move} onPointerLeave={scrub.clear}>
        <canvas ref={canvasRef} />
        {chart && (
          <ChartOverlay
            chart={chart}
            board={board}
            halves
            openBets={you?.openBets ?? []}
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
          players={focus?.playersUp ?? 0}
          disabled={!canBet}
          onBet={() => market.place("up", stake)}
        />
        <div className="stake">
          <p className="balance-label">
            Spendable <span>Demo</span>
          </p>
          <p className="balance">{you ? formatMicros(you.balanceMicros) : "—"}</p>
          {you?.openBets.map((bet) => (
            <p className="in-play" key={bet.roundId}>
              In play {formatMicros(bet.stakeMicros)} on {bet.side === "up" ? "Up" : "Down"}
            </p>
          ))}
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
          <button type="button" className="fund" onClick={() => market.fundWallet()} disabled={!you}>
            Fund +1,000
          </button>
          {market.error && <p className="note bad">{market.error}</p>}
        </div>
        <SideCard
          side="down"
          share={moneyShare(focus?.poolDownMicros ?? 0, total)}
          pool={focus?.poolDownMicros ?? 0}
          players={focus?.playersDown ?? 0}
          disabled={!canBet}
          onBet={() => market.place("down", stake)}
        />
      </section>

      <section className="tray">
        <header>
          <h2>This pool</h2>
          <span>{focus ? `${focus.tray.length} playing` : ""}</span>
        </header>
        {focus && focus.tray.length > 0 ? (
          <ul>
            {focus.tray.map((row) => (
              <li key={row.address}>
                <span className={row.bot ? "bot" : "addr"}>{row.bot ? botLabel(row.address) : shortAddress(row.address)}</span>
                <span className={row.side}>{row.side === "up" ? "Up" : "Down"}</span>
                <span className="amt">{formatMicros(row.stakeMicros)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No one in this pool yet.</p>
        )}
      </section>

      <History address={market.address} version={market.historyVersion} windowMs={market.config.windowSeconds * 1000} />
      {market.notice && <Reveal event={market.notice} address={market.address} onDone={market.dismissNotice} />}

      <footer className="footer">
        <p>{(market.config.feeBps / 100).toFixed(2)}% fee on a paid pool.</p>
        <p>Up finishes above the open. Down finishes below. Push is a tie, and stakes return.</p>
        <p>If a market never gets a price, it is void and stakes return.</p>
        <p>Price from {sourceLabel(market.config.source)}.</p>
        <div className="withdraw">
          <input
            aria-label="Withdraw amount"
            inputMode="decimal"
            placeholder="Amount"
            value={withdrawAmount}
            onChange={(event) => setWithdrawAmount(event.target.value)}
            disabled={!you}
          />
          <button type="button" onClick={() => market.withdrawWallet(withdrawAmount)} disabled={!you}>
            Withdraw
          </button>
        </div>
      </footer>
    </div>
  )
}

function ChartOverlay({
  chart,
  board,
  halves,
  openBets,
  feeBps,
  hover,
}: {
  chart: TapeChart
  board: Board | null
  halves: boolean
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
        const left = xAt(band.betsOpen)
        const right = xAt(band.strikeAt)
        if (right - left < 2 || right < 0 || left > current.width) return null
        const open = band.id === board.join?.id && board.phase === "bets"
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
      {halves && <HalfLabels board={board} scale={current} xAt={xAt} />}
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

function HalfLabels({
  board,
  scale,
  xAt,
}: {
  board: Board
  scale: ChartScale
  xAt: (t: number) => number
}) {
  const plotRight = scale.plotLeft + scale.plotWidth
  const plotBottom = scale.plotTop + scale.plotHeight
  const left = xAt(board.blockStart)
  const mid = xAt(board.windowEndsAt)
  const right = xAt(board.blockEnd)
  const completing = marketSettlingAt(board, board.windowEndsAt)
  const current = marketStrikingAt(board, board.windowEndsAt)
  const leftVisL = Math.max(left, scale.plotLeft)
  const leftVisR = Math.min(mid, plotRight)
  const rightVisL = Math.max(mid, scale.plotLeft)
  const rightVisR = Math.min(right, plotRight)

  return (
    <>
      {completing && leftVisR - leftVisL >= 48 && (
        <p className="market-tag" style={{ left: leftVisL + 8, top: scale.plotTop + 8, maxWidth: plotRight - leftVisL - 16 }}>
          <span>Last market completing</span>
          <b className="up">Up {formatMicros(completing.poolUpMicros)}</b>
          <b className="down">Down {formatMicros(completing.poolDownMicros)}</b>
        </p>
      )}
      {current && rightVisR - rightVisL >= 48 && (
        <p className="market-tag" style={{ left: rightVisL + 8, top: plotBottom - 28, maxWidth: rightVisR - rightVisL - 16 }}>
          <span>Current market</span>
          {(current.poolUpMicros > 0 || current.poolDownMicros > 0) && (
            <>
              <b className="up">Up {formatMicros(current.poolUpMicros)}</b>
              <b className="down">Down {formatMicros(current.poolDownMicros)}</b>
            </>
          )}
        </p>
      )}
    </>
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
          <span className={side === "flat" ? "" : side}>
            {formatSigned(fromOpen)} {side === "up" ? "Up" : side === "down" ? "Down" : "Push"}
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
  const takes = takeMicros(bet.stakeMicros, bet.side, band.poolUpMicros, band.poolDownMicros, feeBps)
  return (
    <p className={`chip ${bet.side}`} style={{ left, top: top + 52 }}>
      <strong>
        {bet.side === "up" ? "Up" : "Down"} {formatMicros(bet.stakeMicros)}
      </strong>
      <span>takes {formatCents(takes)}</span>
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
        if (price && strike) {
          const delta = Number(price) - Number(strike)
          deltaEl.current.textContent = `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta).toFixed(2)}`
          deltaEl.current.dataset.side = delta > 0 ? "up" : delta < 0 ? "down" : "flat"
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
  players: number
  disabled: boolean
  onBet: () => void
}) {
  const up = props.side === "up"
  return (
    <article className={up ? "side up" : "side down"}>
      <p className="side-name">{up ? "Up" : "Down"}</p>
      <p className="share">{props.share}</p>
      <p className="pool">
        {formatMicros(props.pool)} · {props.players} {props.players === 1 ? "player" : "players"}
      </p>
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
                  <th>Payout</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} onClick={() => setReplay(row)} className={replay?.id === row.id ? "open" : ""}>
                <td>{formatClock(row.startsAt)}</td>
                <td>{resultLabel(row)}</td>
                <td>{row.strike ? formatPrice(row.strike) : "—"}</td>
                <td>{row.settle ? formatPrice(row.settle) : "—"}</td>
                <td>{formatMicros(row.poolUpMicros)}</td>
                <td>{formatMicros(row.poolDownMicros)}</td>
                <td>{formatMicros(row.feeMicros)}</td>
                {mine && (
                  <>
                    <td>{row.mySide === "up" ? "Up" : row.mySide === "down" ? "Down" : "—"}</td>
                    <td>{row.myStakeMicros !== undefined ? formatMicros(row.myStakeMicros) : "—"}</td>
                    <td>
                      {row.myPayoutMicros !== undefined && row.myPayoutMicros !== null ? formatMicros(row.myPayoutMicros) : "—"}
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
          getBaseline: () => strike,
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
              {resultLabel(row)}
              {row.strike && row.settle ? ` · ${formatPrice(row.strike)} → ${formatPrice(row.settle)}` : ""}
              {` · Up ${formatMicros(row.poolUpMicros)} · Down ${formatMicros(row.poolDownMicros)}`}
            </p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <section className="chart-wrap still" onPointerMove={scrub.move} onPointerLeave={scrub.clear}>
          <canvas ref={canvasRef} />
          {chart && <ChartOverlay chart={chart} board={board} halves={false} openBets={[]} feeBps={0} hover={scrub.hover} />}
        </section>
        {failed && <p className="empty">Couldn't load this market.</p>}
        {bets && bets.length === 0 && <p className="empty">No bets in this pool.</p>}
        {bets && bets.length > 0 && (
          <div className="detail">
            <ul>
              {bets.map((bet) => (
                <li key={bet.address}>
                  <span className={bet.bot ? "bot" : ""}>{bet.bot ? botLabel(bet.address) : shortAddress(bet.address)}</span>
                  <span className={bet.side}>{bet.side === "up" ? "Up" : "Down"}</span>
                  <span>{formatMicros(bet.stakeMicros)}</span>
                  <span>{bet.payoutMicros === null ? "—" : formatMicros(bet.payoutMicros)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

function Reveal({ event, address, onDone }: { event: SettledMessage; address: string | null; onDone: () => void }) {
  const mine = address ? (event.payouts.find((payout) => payout.address === address) ?? null) : null
  useEffect(() => {
    const id = window.setTimeout(onDone, mine ? 4_500 : 3_200)
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") onDone()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener("keydown", onKey)
    }
  }, [event, mine, onDone])

  const result = marketWord(event)
  if (!mine) {
    const move = event.strike && event.settle ? `${formatPrice(event.strike)} → ${formatPrice(event.settle)}` : null
    return (
      <button type="button" className="reveal-banner" onClick={onDone}>
        <strong>{result}</strong>
        {move && <span>{move}</span>}
      </button>
    )
  }

  const profit = mine.payoutMicros - mine.stakeMicros
  const back = event.resolution === "void" || event.resolution === "refund" || event.winningSide === "push" || profit === 0
  const title = event.resolution === "void" ? "Void" : back ? "Push" : profit > 0 ? "You win" : "Lost"
  const tone = profit > 0 ? "win" : profit < 0 ? "loss" : "flat"
  const move = event.strike && event.settle ? `${formatPrice(event.strike)} → ${formatPrice(event.settle)}` : null
  return (
    <div className="reveal-back" onClick={onDone}>
      <div className={`reveal-card ${tone}`} role="dialog" aria-label={title}>
        {tone === "win" && (
          <span className="motes" aria-hidden="true">
            {Array.from({ length: 10 }, (_, index) => (
              <i key={index} style={{ ["--i" as string]: index }} />
            ))}
          </span>
        )}
        <p className="reveal-kicker">{result}</p>
        <h2>{title}</h2>
        <p className="take">{back && profit === 0 ? "Stakes back" : signedMicros(profit)}</p>
        <p className="reveal-sub">
          Stake {formatMicros(mine.stakeMicros)}
          {move ? ` · ${move}` : ""}
        </p>
      </div>
    </div>
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

function baselineOf(board: Board | null): number | null {
  if (!board) return null
  if (board.live?.strike != null) return Number(board.live.strike)
  for (let index = board.bands.length - 1; index >= 0; index--) {
    const strike = board.bands[index]?.strike
    if (strike != null) return Number(strike)
  }
  return null
}

function marketSettlingAt(board: Board, at: number): Band | null {
  const band = board.bands.find((row) => row.settlesAt === at && row.status === "open")
  if (band) return band
  if (board.live && board.live.settlesAt === at && board.live.status === "open") return board.live
  return null
}

function marketStrikingAt(board: Board, at: number): Band | null {
  return (
    board.bands.find((row) => row.strikeAt === at) ??
    (board.live?.strikeAt === at ? board.live : null) ??
    (board.join?.strikeAt === at ? board.join : null)
  )
}

function marketWord(event: SettledMessage): string {
  if (event.resolution === "void") return "Void"
  if (event.winningSide === "push" || !event.winningSide) return "Push"
  if (event.winningSide === "up") return "Up"
  return "Down"
}

function signedMicros(micros: number): string {
  if (micros > 0) return `+${formatMicros(micros)}`
  return formatMicros(micros)
}

function resultLabel(row: HistoryRound): string {
  if (row.status === "void" || row.resolution === "void") return "Void"
  if (row.winningSide === "push") return "Push"
  if (row.winningSide === "up") return "Up"
  if (row.winningSide === "down") return "Down"
  return "—"
}
