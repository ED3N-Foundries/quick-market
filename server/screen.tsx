/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import {
  HELP_LINES,
  apiHost,
  detailLine,
  handleKey,
  formatAge,
  headLine,
  holdLine,
  keyFromEvent,
  pullFeeds,
  sourceLine,
  wideLayout,
  type DashState,
} from "./dashboard"
import type { FeedFrame, LegRole, VenueRow } from "./feeds"

const text = "#f3f0e8"
const muted = "#8f8a80"
const up = "#2fce86"
const down = "#ff5a4f"
const gold = "#e2b340"
const bg = "#090a0c"
const raise = "#1b1e26"

const ROLE: Record<LegRole, string> = {
  active: text,
  ready: up,
  stale: gold,
  far: down,
  quiet: muted,
  down: gold,
}

export function FeedsView({
  frame,
  state,
  now,
  width,
  height,
  quiet,
  host,
  onSelect,
}: {
  frame: FeedFrame | null
  state: DashState
  now: number
  width: number
  height: number
  quiet: boolean
  host: string
  onSelect: (index: number) => void
}) {
  const wide = wideLayout(width)
  const roomy = height >= 16
  if (!frame) {
    return (
      <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: bg, padding: 1 }}>
        <Text>{`Waiting for the API on ${host}.`}</Text>
        <Text fg={muted}>q closes this dashboard. The API keeps going.</Text>
        {quiet ? <Text fg={gold}>api quiet</Text> : null}
      </box>
    )
  }
  const selected = frame.venues[state.selected] ?? null
  return (
    <box
      style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: bg, paddingLeft: 1, paddingRight: 1 }}
    >
      <Text>{sourceLine(frame, now)}</Text>
      <Text fg={muted}>{holdLine(frame, now)}</Text>
      {quiet ? <Text fg={gold}>api quiet</Text> : null}
      <Text fg={muted}>{headLine(wide)}</Text>
      {frame.venues.map((row, index) => (
        <VenueLine
          key={row.venue}
          row={row}
          selected={index === state.selected}
          wide={wide}
          now={now}
          onPress={() => onSelect(index)}
        />
      ))}
      {roomy ? <Text fg={muted}>{detailLine(selected, now)}</Text> : null}
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", flexShrink: 0 }}>
        <Text fg={muted}>q quit</Text>
        <Text fg={muted}>{state.help ? "? hide" : "? keys"}</Text>
      </box>
      {state.help ? HELP_LINES.map((line) => <Text key={line} fg={muted}>{line}</Text>) : null}
    </box>
  )
}

function App({ url }: { url: string }) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [state, setState] = useState<DashState>({ selected: 0, help: false })
  const [frame, setFrame] = useState<FeedFrame | null>(null)
  const [quiet, setQuiet] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const stateRef = useRef(state)
  const frameRef = useRef(frame)
  stateRef.current = state
  frameRef.current = frame

  useEffect(() => {
    let stop = false
    const tick = async () => {
      const pulled = await pullFeeds(url)
      if (stop) return
      setNow(Date.now())
      if (!pulled.frame) {
        setQuiet(true)
        return
      }
      setFrame(pulled.frame)
      setQuiet(false)
    }
    void tick()
    const timer = setInterval(() => void tick(), 250)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [url])

  useKeyboard((key) => {
    const token = keyFromEvent(key)
    if (!token || key.eventType === "release") return
    const next = handleKey(stateRef.current, token, frameRef.current?.venues.length ?? 0)
    stateRef.current = next.state
    setState(next.state)
    if (next.quit) renderer.destroy()
  })

  return (
    <FeedsView
      frame={frame}
      state={state}
      now={now}
      width={width}
      height={height}
      quiet={quiet}
      host={apiHost(url)}
      onSelect={(index) => {
        const next = { ...stateRef.current, selected: index }
        stateRef.current = next
        setState(next)
      }}
    />
  )
}

function VenueLine({
  row,
  selected,
  wide,
  now,
  onPress,
}: {
  row: VenueRow
  selected: boolean
  wide: boolean
  now: number
  onPress: () => void
}) {
  const age = row.at > 0 ? formatAge(Math.max(0, now - row.at)) : "—"
  return (
    <box
      style={{ height: 1, flexDirection: "row", flexShrink: 0, backgroundColor: selected ? raise : bg }}
      onMouseDown={(event) => {
        onPress()
        event.stopPropagation()
      }}
    >
      <Cell width={2} fg={gold}>{selected ? ">" : " "}</Cell>
      <Cell width={10} fg={selected ? gold : text}>{row.venue}</Cell>
      <Cell width={8} fg={ROLE[row.role]}>{row.role}</Cell>
      <Cell width={12}>{priceText(row.price)}</Cell>
      <Cell width={8} fg={muted}>{age}</Cell>
      {wide ? <Cell width={10} fg={muted}>{gapText(row.gap)}</Cell> : null}
      {wide ? <Text fg={muted}>{row.feed ?? "—"}</Text> : null}
    </box>
  )
}

function priceText(price: string | null): string {
  if (!price) return "—"
  const amount = Number(price)
  if (!Number.isFinite(amount)) return price
  return amount.toFixed(2)
}

function gapText(gap: string | null): string {
  if (gap == null) return "—"
  const amount = Number(gap)
  if (!Number.isFinite(amount)) return gap
  return amount.toFixed(2)
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

export async function runScreen(url: string): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    targetFps: 30,
    backgroundColor: bg,
  })
  createRoot(renderer).render(<App url={url} />)
  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve())
  })
}
