import { useEffect, useRef, useState } from "react"
import { mountChart, type TapeChart } from "./chart"
import { heldStrike } from "./focus"
import { formatClock, formatMoney, formatPrice, formatReturn, shortAddress } from "./format"
import type { Board, HistoryRound, Side, TrayRow } from "./types"
import type { Copy } from "./copy"
import { useI18n } from "./i18n"
import { FeedBadge } from "./venues"
import { ChartOverlay, useScrub } from "./App"

export function History({
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
        status: row.status === "void" ? "void" : row.status === "open" ? "open" : "settled",
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
