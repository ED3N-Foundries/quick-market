import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { getScale, mountChart, subscribeScale, type TapeChart } from "./chart"
import { botLabel, formatCents, formatClock, formatMicros, formatPrice, microsToInput, moneyShare, quotePair, randomAddress, shortAddress, sourceLabel, takeMicros } from "./format"
import type { Band, Board, HistoryRound, OpenBet, Side } from "./types"
import { useMarket } from "./useMarket"

export function App() {
  const market = useMarket()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const viewRef = useRef({ follow: true, start: 0, end: 0 })
  const boardRef = useRef(market.board)
  const [stake, setStake] = useState("10")
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [following, setFollowing] = useState(true)
  boardRef.current = market.board

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const chart = mountChart(canvas, {
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
    })
    chartRef.current = chart
    market.bindChart(chart)
    return () => {
      chart.destroy()
      chartRef.current = null
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
    const current = getScale()
    if (!current || event.button !== 0) return
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

      <section className="chart-wrap" onPointerDown={onPointerDown}>
        <canvas ref={canvasRef} />
        <ChartOverlay board={board} openBets={you?.openBets ?? []} feeBps={market.config.feeBps} />
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

      <History address={market.address} version={market.historyVersion} />

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

function ChartOverlay({ board, openBets, feeBps }: { board: Board | null; openBets: OpenBet[]; feeBps: number }) {
  const current = useSyncExternalStore(subscribeScale, getScale, getScale)
  if (!current || !board) return null
  const span = Math.max(1, current.viewEnd - current.viewStart)
  const xAt = (t: number) => current.plotLeft + ((t - current.viewStart) / span) * current.plotWidth
  const featured = new Set([board.live?.id, board.join?.id].filter((id): id is number => id !== undefined))

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
      {board.bands.map((band) => {
        if (!featured.has(band.id)) return null
        const left = xAt(Math.max(band.strikeAt, current.viewStart))
        const right = xAt(Math.min(band.settlesAt, current.viewEnd))
        if (right - left < 8) return null
        const room = right - left - 16
        if (room < 36) return null
        return (
          <p className="pots" key={`p-${band.id}`} style={{ left: left + 8, top: current.plotTop + 8, maxWidth: room }}>
            <span>Up {formatMicros(band.poolUpMicros)}</span>
            <span>Down {formatMicros(band.poolDownMicros)}</span>
          </p>
        )
      })}
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
        <span key={tick.label} className="ytick" style={{ top: tick.y, right: 8 }}>
          {tick.label}
        </span>
      ))}
    </div>
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

function History({ address, version }: { address: string | null; version: number }) {
  const [mine, setMine] = useState(false)
  const [rows, setRows] = useState<HistoryRound[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<
    { address: string; side: Side; stakeMicros: number; payoutMicros: number | null; bot: boolean }[]
  >([])

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

  async function toggle(id: number) {
    if (openId === id) {
      setOpenId(null)
      return
    }
    setOpenId(id)
    const response = await fetch(`/api/rounds/${id}`)
    const body = await response.json()
    setDetail(body.bets ?? [])
  }

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
              <Fragment key={row.id}>
                <tr onClick={() => toggle(row.id)} className={openId === row.id ? "open" : ""}>
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
                {openId === row.id && (
                  <tr className="detail">
                    <td colSpan={mine ? 10 : 7}>
                      {detail.length === 0 ? (
                        <span>No bets in this pool.</span>
                      ) : (
                        <ul>
                          {detail.map((bet) => (
                            <li key={bet.address}>
                              <span className={bet.bot ? "bot" : ""}>{bet.bot ? botLabel(bet.address) : shortAddress(bet.address)}</span>
                              <span className={bet.side}>{bet.side === "up" ? "Up" : "Down"}</span>
                              <span>{formatMicros(bet.stakeMicros)}</span>
                              <span>{bet.payoutMicros === null ? "—" : formatMicros(bet.payoutMicros)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function resultLabel(row: HistoryRound): string {
  if (row.status === "void" || row.resolution === "void") return "Void"
  if (row.winningSide === "push") return "Push"
  if (row.winningSide === "up") return "Up"
  if (row.winningSide === "down") return "Down"
  return "—"
}
