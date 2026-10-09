import { Fragment, useEffect, useRef, useState, type RefObject } from "react"
import { mountChart, type TapeChart } from "./chart"
import { formatClock, formatMicros, formatPrice, microsToInput, moneyShare, randomAddress, shortAddress } from "./format"
import type { HistoryRound, Side } from "./types"
import { useMarket } from "./useMarket"

export function App() {
  const market = useMarket()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<TapeChart | null>(null)
  const [stake, setStake] = useState("10")
  const [withdrawAmount, setWithdrawAmount] = useState("")

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const chart = mountChart(canvas, () => Date.now() + market.offsetRef.current)
    chartRef.current = chart
    market.bindChart(chart)
    return () => {
      chart.destroy()
      chartRef.current = null
      market.bindChart(null)
    }
  }, [market.bindChart, market.offsetRef])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !market.round) return
    market.setRoundOnChart(chart, market.round)
  }, [market, market.round])

  const round = market.round
  const you = market.you
  const total = (round?.poolUpMicros ?? 0) + (round?.poolDownMicros ?? 0)
  const inCutoff = !!round && market.now >= round.endsAt - market.config.betCutoffMs
  const locked = !!you?.openBet
  const canBet = !!you && !!round?.strike && market.feed === "live" && !inCutoff && !locked && !market.pending

  const addMicros = parseStake(stake)
  const note = statusNote({
    connected: !!you,
    locked,
    openBet: you?.openBet ?? null,
    strike: round?.strike ?? null,
    feed: market.feed,
    inCutoff,
    error: market.error,
    result: market.result,
  })

  function chip(percent: number) {
    if (!you) return
    setStake(microsToInput(Math.floor((you.balanceMicros * percent) / 100)))
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark">Quick</span>
          <span className="pair">BTC</span>
        </div>
        <PriceReadout priceRef={market.priceRef} strike={round?.strike ?? null} />
        <div className="clock-block">
          <span className="clock-label">Window</span>
          {round ? <Countdown endsAt={round.endsAt} offsetRef={market.offsetRef} /> : <strong className="clock">—</strong>}
        </div>
        <WalletBar
          address={market.address}
          onConnect={() => market.connect(market.address ?? randomAddress())}
          onFund={market.fundWallet}
          withdrawAmount={withdrawAmount}
          onWithdrawAmount={setWithdrawAmount}
          onWithdraw={() => market.withdrawWallet(withdrawAmount)}
        />
      </header>

      <section className="chart-wrap">
        <canvas ref={canvasRef} />
        {market.feed === "stale" && <p className="feed-flag">Price delayed</p>}
      </section>

      <section className="trade">
        <SideCard
          side="up"
          share={moneyShare(round?.poolUpMicros ?? 0, total)}
          pool={round?.poolUpMicros ?? 0}
          players={round?.playersUp ?? 0}
          disabled={!canBet}
          onBet={() => market.place("up", stake)}
        />
        <div className="stake">
          <p className="balance-label">
            Spendable <span>Demo</span>
          </p>
          <p className="balance">{you ? formatMicros(you.balanceMicros) : "—"}</p>
          {you?.openBet && (
            <p className="in-play">
              In play {formatMicros(you.openBet.stakeMicros)} on {you.openBet.side === "up" ? "Up" : "Down"}
            </p>
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
          <p className="share-preview">{locked ? "" : sharePreview(addMicros, round)}</p>
          <p className={`note${market.error ? " bad" : ""}`}>{note}</p>
          <p className="fee">{(market.config.feeBps / 100).toFixed(2)}% fee on the pool</p>
        </div>
        <SideCard
          side="down"
          share={moneyShare(round?.poolDownMicros ?? 0, total)}
          pool={round?.poolDownMicros ?? 0}
          players={round?.playersDown ?? 0}
          disabled={!canBet}
          onBet={() => market.place("down", stake)}
        />
      </section>

      <section className="tray">
        <header>
          <h2>This pool</h2>
          <span>{round ? `${round.tray.length} playing` : ""}</span>
        </header>
        {round && round.tray.length > 0 ? (
          <ul>
            {round.tray.map((row) => (
              <li key={row.address}>
                <span className="addr">{shortAddress(row.address)}</span>
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
    </div>
  )
}

function PriceReadout({ priceRef, strike }: { priceRef: RefObject<string | null>; strike: string | null }) {
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
          deltaEl.current.textContent = strike ? "at open" : "waiting for open"
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
      <span ref={priceEl} className="price">
        —
      </span>
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

function WalletBar(props: {
  address: string | null
  onConnect: () => void
  onFund: () => void
  withdrawAmount: string
  onWithdrawAmount: (value: string) => void
  onWithdraw: () => void
}) {
  if (!props.address) {
    return (
      <div className="wallet">
        <button type="button" className="primary" onClick={props.onConnect}>
          Connect
        </button>
      </div>
    )
  }
  return (
    <div className="wallet">
      <span className="who">
        {shortAddress(props.address)}
        <small>Demo</small>
      </span>
      <button type="button" onClick={props.onFund}>
        Fund +1,000
      </button>
      <input
        aria-label="Withdraw amount"
        inputMode="decimal"
        placeholder="Amount"
        value={props.withdrawAmount}
        onChange={(event) => props.onWithdrawAmount(event.target.value)}
      />
      <button type="button" onClick={props.onWithdraw}>
        Withdraw
      </button>
    </div>
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
  const [detail, setDetail] = useState<{ address: string; side: Side; stakeMicros: number; payoutMicros: number | null }[]>([])

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
                      <td>{row.myPayoutMicros !== undefined && row.myPayoutMicros !== null ? formatMicros(row.myPayoutMicros) : "—"}</td>
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
                              <span>{shortAddress(bet.address)}</span>
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

function parseStake(value: string): number | null {
  const stake = value.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(stake)) return null
  const [whole, frac = ""] = stake.split(".")
  return Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"))
}

function sharePreview(add: number | null, round: { poolUpMicros: number; poolDownMicros: number; strike: string | null } | null): string {
  if (!round?.strike) return "The open price sets the line."
  if (!add) return "Enter a stake to see your share of that side."
  const up = Math.round((add / (round.poolUpMicros + add)) * 100)
  const down = Math.round((add / (round.poolDownMicros + add)) * 100)
  return `This stake would be ${up}% of Up or ${down}% of Down.`
}

function statusNote(input: {
  connected: boolean
  locked: boolean
  openBet: { side: Side } | null
  strike: string | null
  feed: "live" | "stale"
  inCutoff: boolean
  error: string | null
  result: string | null
}): string {
  if (input.error) return input.error
  if (!input.connected) return "Connect a demo wallet to bet."
  if (input.locked) return "Next market unlocks when this one resolves."
  if (!input.strike) return "Waiting for the open."
  if (input.feed === "stale") return "Price feed is delayed."
  if (input.inCutoff) return "Window closed."
  return input.result ?? "Bet whether bitcoin finishes this window above or below the open."
}

function resultLabel(row: HistoryRound): string {
  if (row.status === "void" || row.resolution === "void") return "Void"
  if (row.winningSide === "push") return "Push"
  if (row.resolution === "refund" && (row.poolUpMicros > 0 || row.poolDownMicros > 0)) return "Refund"
  if (row.winningSide === "up") return "Up"
  if (row.winningSide === "down") return "Down"
  return "—"
}
