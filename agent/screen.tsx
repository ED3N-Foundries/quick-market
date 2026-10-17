/** @jsxImportSource @opentui/react */
import { createCliRenderer, type MouseEvent } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import {
  HELP_LINES,
  bootRunner,
  crowdLine,
  detailLine,
  handleKey,
  histogramLine,
  isRunnerAlive,
  keyFromEvent,
  loadControl,
  loadSnapshot,
  moneyLine,
  pageRoster,
  panelsFit,
  rosterCapacity,
  rosterCells,
  saveControl,
  toggleRunner,
  type DashState,
  type RosterCells,
  type RowTone,
} from "./dashboard"
import { formatMicros, spark, type ControlFile, type SwarmSnapshot } from "./status"
import type { WalletRow } from "./swarmdb"

const text = "#f3f0e8"
const muted = "#8f8a80"
const up = "#2fce86"
const down = "#ff5a4f"
const gold = "#e2b340"
const bg = "#090a0c"
const raise = "#1b1e26"

const TONE: Record<RowTone, string> = { text, muted, gold, up, down }

const COL = { mark: 2, idx: 5, address: 13, state: 8, mind: 10, bankroll: 12, last: 16, skip: 12 }

type Page = { rows: WalletRow[]; count: number; offset: number; selected: number }

export function DashboardView({
  snapshot,
  page,
  state,
  now,
  width,
  height,
  onSelect,
  onScroll,
}: {
  snapshot: SwarmSnapshot | null
  page: Page
  state: DashState
  now: number
  width: number
  height: number
  onSelect: (index: number) => void
  onScroll: (delta: number) => void
}) {
  const wide = width >= 100
  const roomy = height >= 18
  if (!snapshot) {
    return (
      <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: bg, padding: 1 }}>
        <text fg={text}>Waiting for bun run agent.</text>
        <text fg={muted}>Press r to start the runner, or q to close this dashboard. The runner keeps going.</text>
      </box>
    )
  }
  const alive = isRunnerAlive(snapshot, now)
  const control = state.control
  const together = panelsFit(width, snapshot, control)
  const selectedRow = page.rows[state.selected - page.offset] ?? null
  const onWheel = (event: MouseEvent) => {
    const direction = event.scroll?.direction
    if (direction === "down") onScroll(3)
    else if (direction === "up") onScroll(-3)
    event.stopPropagation()
  }
  return (
    <box
      style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: bg, paddingLeft: 1, paddingRight: 1 }}
      onMouseScroll={onWheel}
    >
      <Line fg={alive ? text : gold}>
        Manila {snapshot.manila}   {snapshot.phase}   {alive ? "runner live" : "agent quiet"}
      </Line>
      <Line>{crowdLine(snapshot, alive)}</Line>
      {roomy ? <Line fg={muted}>{spark(snapshot.trace) || "·"}</Line> : null}
      {together ? (
        <box style={{ height: 1, flexDirection: "row", flexShrink: 0 }}>
          <Book snapshot={snapshot} />
          <Text>  </Text>
          <Money snapshot={snapshot} control={control} wide={false} />
        </box>
      ) : (
        <box style={{ flexDirection: "column", flexShrink: 0 }}>
          <Book snapshot={snapshot} />
          <Money snapshot={snapshot} control={control} wide={moneyLine(snapshot, control, true).length <= width - 2} />
        </box>
      )}
      {roomy ? <Line fg={muted}>{bandsLine(snapshot)}</Line> : null}
      {snapshot.lastError ? <Line fg={down}>error {snapshot.lastError}</Line> : null}
      <box style={{ flexGrow: 1, flexDirection: "column", flexShrink: 1 }}>
        <RosterHead wide={wide} />
        {page.rows.length === 0 ? <Line fg={muted}>no wallets</Line> : null}
        {page.rows.map((row, index) => (
          <RosterRow
            key={row.address}
            cells={rosterCells(row, page.offset + index === state.selected, control, alive)}
            wide={wide}
            onPress={() => onSelect(page.offset + index)}
          />
        ))}
      </box>
      <Line fg={muted}>{detailLine(selectedRow, control, alive, now)}</Line>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", flexShrink: 0 }}>
        <Status control={control} />
        <Text fg={muted}>{state.help ? "? hide" : "? keys"}</Text>
      </box>
      {state.help ? HELP_LINES.map((line) => <Line key={line} fg={muted}>{line}</Line>) : null}
    </box>
  )
}

function App() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [state, setState] = useState<DashState>(() => ({
    selected: 0,
    filter: "all",
    help: false,
    control: loadControl(),
  }))
  const [snapshot, setSnapshot] = useState<SwarmSnapshot | null>(null)
  const [page, setPage] = useState<Page>({ rows: [], count: 0, offset: 0, selected: 0 })
  const [now, setNow] = useState(() => Date.now())
  const stateRef = useRef(state)
  const pageRef = useRef(page)
  const offsetRef = useRef(0)
  stateRef.current = state
  pageRef.current = page

  useEffect(() => {
    const tick = () => {
      try {
        const next = loadSnapshot()
        const current = stateRef.current
        const capacity = rosterCapacity(width, height, {
          help: current.help,
          error: Boolean(next?.lastError),
          stacked: !next || !panelsFit(width, next, current.control),
        })
        const listed = pageRoster(current.filter, current.selected, offsetRef.current, capacity)
        offsetRef.current = listed.offset
        setSnapshot(next)
        setPage(listed)
        setNow(Date.now())
        if (listed.selected !== current.selected) setState({ ...current, selected: listed.selected })
      } catch {
        // A locked snapshot or roster read keeps the last frame on screen.
      }
    }
    tick()
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [width, height, state.help, state.filter, state.selected])

  useKeyboard((key) => {
    const token = keyFromEvent(key)
    if (!token || key.eventType === "release") return
    const current = stateRef.current
    if (token === "r") {
      toggleRunner(loadSnapshot())
      setSnapshot(loadSnapshot())
      return
    }
    const local = pageRef.current.rows[current.selected - pageRef.current.offset] ?? null
    const next = handleKey(current, token, local?.address ?? null, pageRef.current.count)
    if (JSON.stringify(next.state.control) !== JSON.stringify(current.control)) saveControl(next.state.control)
    setState(next.state)
    if (next.quit) renderer.destroy()
  })

  return (
    <DashboardView
      snapshot={snapshot}
      page={page}
      state={state}
      now={now}
      width={width}
      height={height}
      onSelect={(index) => setState((current) => ({ ...current, selected: index }))}
      onScroll={(delta) =>
        setState((current) => ({
          ...current,
          selected: Math.min(Math.max(0, pageRef.current.count - 1), Math.max(0, current.selected + delta)),
        }))
      }
    />
  )
}

function bandsLine(snapshot: SwarmSnapshot): string {
  const lag = snapshot.bookLagMs === null ? "—" : `${snapshot.bookLagMs}ms`
  return `p50 ${formatMicros(snapshot.book.p50)}  p90 ${formatMicros(snapshot.book.p90)}  lag ${lag}   ${histogramLine(snapshot)}`
}

function Book({ snapshot }: { snapshot: SwarmSnapshot }) {
  const book = snapshot.book
  const pool = book.upMicros + book.downMicros
  const bot = book.botUpMicros + book.botDownMicros
  const share = pool === 0 ? "—" : `${Math.round((bot / pool) * 100)}%`
  return (
    <box style={{ height: 1, flexDirection: "row", flexShrink: 1 }}>
      <Text>book  r{book.roundId ?? "—"}  </Text>
      <Text fg={up}>up {formatMicros(book.upMicros)}</Text>
      <Text>  </Text>
      <Text fg={down}>down {formatMicros(book.downMicros)}</Text>
      <Text>  bots {share}  bets {book.bets}  skips {book.skips}</Text>
    </box>
  )
}

function Money({ snapshot, control, wide }: { snapshot: SwarmSnapshot; control: ControlFile; wide: boolean }) {
  return <Line fg={control.bleed ? text : gold}>{moneyLine(snapshot, control, wide)}</Line>
}

function Status({ control }: { control: ControlFile }) {
  const mode = control.mode === "pin" ? `pin ${control.pin ?? 1}` : control.mode
  return (
    <box style={{ height: 1, flexDirection: "row", flexShrink: 1 }}>
      <Text fg={control.mode === "clock" ? text : gold}>{mode}</Text>
      <Text fg={muted}>  ·  </Text>
      <Text fg={control.bettingPaused ? gold : text}>{control.bettingPaused ? "bets paused" : "bets on"}</Text>
      <Text fg={muted}>  ·  </Text>
      <Text fg={control.bleed ? text : gold}>{control.bleed ? "bleed on" : "bleed off"}</Text>
      <Text>  ·  paused {control.paused.length}</Text>
    </box>
  )
}

function RosterHead({ wide }: { wide: boolean }) {
  return (
    <box style={{ height: 1, flexDirection: "row", flexShrink: 0 }}>
      <Cell width={COL.mark} fg={muted}> </Cell>
      <Cell width={COL.idx} fg={muted}>#</Cell>
      <Cell width={COL.address} fg={muted}>address</Cell>
      <Cell width={COL.state} fg={muted}>state</Cell>
      {wide ? <Cell width={COL.mind} fg={muted}>mind</Cell> : null}
      <Cell width={COL.bankroll} fg={muted}>bankroll</Cell>
      {wide ? <Cell width={COL.last} fg={muted}>last</Cell> : null}
      <Cell width={COL.skip} fg={muted}>skip</Cell>
      {wide ? <Text fg={muted}>W/L</Text> : null}
    </box>
  )
}

function RosterRow({ cells, wide, onPress }: { cells: RosterCells; wide: boolean; onPress: () => void }) {
  return (
    <box
      style={{ height: 1, flexDirection: "row", flexShrink: 0, backgroundColor: cells.mark === ">" ? raise : bg }}
      onMouseDown={(event) => {
        onPress()
        event.stopPropagation()
      }}
    >
      <Cell width={COL.mark} fg={gold}>{cells.mark}</Cell>
      <Cell width={COL.idx}>{cells.idx}</Cell>
      <Cell width={COL.address} fg={cells.mark === ">" ? gold : text}>{cells.address}</Cell>
      <Cell width={COL.state} fg={TONE[cells.stateTone]}>{cells.state}</Cell>
      {wide ? <Cell width={COL.mind} fg={muted}>{cells.mind}</Cell> : null}
      <Cell width={COL.bankroll}>{cells.bankroll}</Cell>
      {wide ? <Cell width={COL.last} fg={TONE[cells.lastTone]}>{cells.last}</Cell> : null}
      <Cell width={COL.skip} fg={muted}>{cells.skip}</Cell>
      {wide ? <Text>{cells.record}</Text> : null}
    </box>
  )
}

function Line({ children, fg = text }: { children: string; fg?: string }) {
  return <Text fg={fg}>{children}</Text>
}

function Text({ children, fg = text }: { children: string; fg?: string }) {
  return (
    <text wrapMode="none" fg={fg} style={{ height: 1, flexShrink: 0 }}>
      {children}
    </text>
  )
}

function Cell({ children, width, fg = text }: { children: string; width: number; fg?: string }) {
  return (
    <text wrapMode="none" fg={fg} style={{ height: 1, width, flexShrink: 0 }}>
      {fit(children, width)}
    </text>
  )
}

function fit(value: string, width: number): string {
  if (value.length > width) return value.slice(0, width)
  return value.padEnd(width)
}

export async function runScreen(): Promise<void> {
  bootRunner()
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    targetFps: 30,
    backgroundColor: bg,
  })
  createRoot(renderer).render(<App />)
  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve())
  })
}
