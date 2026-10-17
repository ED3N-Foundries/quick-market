import { existsSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { CONTROL_PATH, STATUS_PATH, SWARM_DB_PATH, SWARM_PATH, readJson, writeJsonAtomic } from "./store"
import { roster, rosterCount, type RosterFilter, type WalletRow } from "./swarmdb"
import {
  formatMicros,
  parseControl,
  parseSnapshot,
  shortAddress,
  spark,
  type ControlFile,
  type SwarmSnapshot,
} from "./status"

export const PAGE = 24

export type DashState = {
  view: 1 | 2 | 3 | 4 | 5
  selected: number
  filter: RosterFilter
  control: ControlFile
}

export type RenderState = Pick<DashState, "view" | "selected" | "filter"> & {
  control?: ControlFile
  totalCount?: number
}

const FILTERS: RosterFilter[] = ["all", "stuck", "richest", "woke", "slept"]
const VIEW_LABELS: readonly [DashState["view"], string][] = [
  [1, "1 Crowd"],
  [2, "2 Book"],
  [3, "3 Money"],
  [4, "4 Roster"],
  [5, "5 Wallet"],
]

export function handleKey(state: DashState, key: string, selectedAddress: string | null, count: number): { state: DashState; quit: boolean } {
  if (key === "q" || key === "\u0003") return { state, quit: true }
  const control = { ...state.control, paused: state.control.paused.slice() }
  let { view, selected, filter } = state
  if (key === "1" || key === "2" || key === "3" || key === "4" || key === "5") view = Number(key) as DashState["view"]
  if (key === "\t") view = ((view % 5) + 1) as DashState["view"]
  if ((key === "\r" || key === "\n") && view === 4 && count > 0) view = 5
  if ((key === "\u007f" || key === "\u001b") && view === 5) view = 4
  if ((key === "j" || key === "\u001b[B") && count > 0) selected = Math.min(count - 1, selected + 1)
  if ((key === "k" || key === "\u001b[A") && count > 0) selected = Math.max(0, selected - 1)
  if ((key === "\u001b[C" || key === "l") && count > 0) selected = Math.min(count - 1, selected + PAGE)
  if ((key === "\u001b[D" || key === "h") && count > 0) selected = Math.max(0, selected - PAGE)
  if (key === "c") {
    control.mode = "clock"
    control.pin = null
  }
  if (key === "o") {
    control.mode = "off-peak"
    control.pin = null
  }
  if (key === "e") {
    control.mode = "peak"
    control.pin = null
  }
  if (key === "[") {
    control.mode = "pin"
    control.pin = Math.max(1, (control.pin ?? 30) - 1)
  }
  if (key === "]") {
    control.mode = "pin"
    control.pin = Math.min(6_000, (control.pin ?? 30) + 1)
  }
  if (key === "-" || key === "_") {
    control.mode = "pin"
    control.pin = Math.max(1, (control.pin ?? 30) - 10)
  }
  if (key === "=" || key === "+") {
    control.mode = "pin"
    control.pin = Math.min(6_000, (control.pin ?? 30) + 10)
  }
  if (key === "b") control.bettingPaused = !control.bettingPaused
  if (key === "m") control.bleed = !control.bleed
  if (key === "f") filter = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length] ?? "all"
  if (key === "p" && selectedAddress) {
    const address = selectedAddress.toLowerCase()
    control.paused = control.paused.includes(address) ? control.paused.filter((item) => item !== address) : [...control.paused, address]
  }
  if (key === "P") {
    control.paused = []
  }
  return { state: { view, selected, filter, control }, quit: false }
}

export function isRunnerAlive(snapshot: SwarmSnapshot | null, now = Date.now()): boolean {
  if (!snapshot) return false
  if (snapshot.running === false) return false
  if (typeof snapshot.pid === "number" && snapshot.pid > 0) {
    try {
      process.kill(snapshot.pid, 0)
      return now - snapshot.at <= 15_000
    } catch {
      return false
    }
  }
  return now - snapshot.at <= 15_000
}

export function renderSnapshot(
  snapshot: SwarmSnapshot | null,
  state: RenderState,
  rows: WalletRow[] = [],
  now = Date.now(),
): string {
  if (!snapshot) {
    return [
      "Waiting for bun run agent.",
      "",
      "Press r to start the runner, or q to close this dashboard. The runner keeps going.",
    ].join("\n")
  }
  const alive = isRunnerAlive(snapshot, now)
  const quiet = !alive ? "agent quiet" : ""
  const control = effectiveControl(snapshot, state.control)
  const header = renderHeader(snapshot, state.view, control, alive, quiet)
  const pages = [
    renderCrowd(snapshot, quiet),
    renderBook(snapshot, control),
    renderMoney(snapshot, control),
    renderRoster(rows, state.selected, state.filter, control, alive, state.totalCount),
    renderOne(rows[state.selected % PAGE] ?? rows[0] ?? null, now, control, alive, state.selected, state.totalCount ?? rows.length),
  ]
  const help =
    "views: 1–5/Tab   mode: c clock · o off-peak · e peak · [ ] ±1 · -/= ±10   toggles: b bets · m bleed · p wallet · P clear   list: j/k move · h/l page · f filter   r runner   q quit"
  return [header, "", pages[state.view - 1] ?? pages[0]!, "", help].join("\n")
}

function effectiveControl(snapshot: SwarmSnapshot, control?: ControlFile): ControlFile {
  if (control) return control
  return {
    mode:
      snapshot.mode === "pin" || snapshot.mode === "off-peak" || snapshot.mode === "peak" || snapshot.mode === "clock"
        ? snapshot.mode
        : "clock",
    pin: snapshot.pin,
    bettingPaused: snapshot.bettingPaused,
    paused: [],
    bleed: snapshot.bleed,
  }
}

function renderHeader(snapshot: SwarmSnapshot, view: DashState["view"], control: ControlFile, alive: boolean, quiet: string): string {
  const tabs = VIEW_LABELS.map(([id, label]) => (id === view ? `[${label}]` : label)).join("  ")
  const modeText = control.mode === "pin" ? `pin ${control.pin ?? snapshot.pin ?? 30}` : control.mode
  const runnerStatus = alive ? "runner live" : `${quiet || "agent quiet"} (press r to start)`
  const line1 = `${tabs}   Manila ${snapshot.manila}   ${snapshot.phase}   ${runnerStatus}`
  const line2 = [
    `controls: mode [${modeText}] (c clock · o off-peak · e peak · [/] ±1 · -/= ±10)`,
    `bets [${control.bettingPaused ? "PAUSED" : "ON"}] (b)`,
    `bleed [${control.bleed ? "ON" : "OFF"}] (m)`,
    `paused ${control.paused.length} (p/P)`,
  ].join("   ")
  return `${line1}\n${line2}`
}

function renderCrowd(snapshot: SwarmSnapshot, quiet: string): string {
  const window = `${Math.round(snapshot.window[0])}–${Math.round(snapshot.window[1])}`
  const enrolled = typeof snapshot.enrolled === "number" ? ` (enrolled ${snapshot.enrolled})` : ""
  const onlineText = quiet ? `0 (last ${snapshot.online})` : `${snapshot.online}`
  return [
    `window ${window}   online ${onlineText}${enrolled}   spring ${Math.round(snapshot.spring)}   target ${Math.round(snapshot.target)}`,
    `arrivals ${snapshot.arrivedMinute}   departures ${snapshot.leftMinute}   round ${snapshot.book.roundId ?? "—"}   bets ${snapshot.book.bets}   skips ${snapshot.book.skips}${quiet ? `   ${quiet}` : ""}`,
    spark(snapshot.trace) || "·",
    snapshot.lastError ? `error ${snapshot.lastError}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function renderBook(snapshot: SwarmSnapshot, control: ControlFile): string {
  const book = snapshot.book
  const total = book.bets + book.skips
  const skip = total === 0 ? "—" : `${Math.round((book.skips / total) * 100)}%`
  const bot = book.botUpMicros + book.botDownMicros
  const pool = book.upMicros + book.downMicros
  const share = pool === 0 ? "—" : `${Math.round((bot / pool) * 100)}%`
  return [
    `round ${book.roundId ?? "—"}   lag ${snapshot.bookLagMs === null ? "—" : `${snapshot.bookLagMs}ms`}   ${control.bettingPaused ? "betting paused" : "betting on"}`,
    `up ${formatMicros(book.upMicros)}   down ${formatMicros(book.downMicros)}   bot up ${formatMicros(book.botUpMicros)}   bot down ${formatMicros(book.botDownMicros)}   bot share ${share}`,
    `bets ${book.bets}   skips ${book.skips}   skip rate ${skip}   stake p50 ${formatMicros(book.p50)}   p90 ${formatMicros(book.p90)}`,
  ].join("\n")
}

function renderMoney(snapshot: SwarmSnapshot, control: ControlFile): string {
  const money = snapshot.money
  const net = money.seedMicros + money.mintMicros - money.burnMicros
  const bars = money.histogram.map((band) => `${band.band} ${band.count}`).join("   ")
  return [
    `seed ${formatMicros(money.seedMicros)}   floor mints ${formatMicros(money.mintMicros)}   burns ${formatMicros(money.burnMicros)}   ${control.bleed ? "bleed on" : "bleed off"}`,
    `net bleed ${formatMicros(net)}   staked ${formatMicros(money.stakeMicros)}`,
    bars,
  ].join("\n")
}

function renderRoster(
  rows: WalletRow[],
  selected: number,
  filter: RosterFilter,
  control: ControlFile,
  alive: boolean,
  totalCount?: number,
): string {
  const filterTabs = FILTERS.map((item) => (item === filter ? `[${item}]` : item)).join(" · ")
  const total = totalCount ?? rows.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE))
  const currentPage = Math.min(totalPages, Math.floor(selected / PAGE) + 1)
  const head = `roster ${filter} (${total})   filter: ${filterTabs} (f)   page ${currentPage}/${totalPages}`
  if (rows.length === 0) return `${head}\nno wallets`
  const pausedSet = new Set(control.paused.map((item) => item.toLowerCase()))
  const columns = `     #  address        state   mind        bankroll  last bet        status       W/L`
  const body = rows.map((row, index) => {
    const mark = index === selected % PAGE ? ">" : " "
    const isPaused = pausedSet.has(row.address.toLowerCase())
    const state = isPaused ? "paused" : !alive ? (row.online ? "quiet" : "asleep") : row.online ? "awake" : "asleep"
    const lastBet = row.lastSide ? `${row.lastSide} ${formatMicros(row.lastStake ?? 0)}` : "—"
    const status = isPaused ? "paused" : (row.lastSkip ?? (row.online ? "ready" : "asleep"))
    const wl = `${row.wins}/${row.losses}`
    return `${mark} ${String(row.idx).padStart(4)}  ${shortAddress(row.address)}  ${state.padEnd(6)}  ${row.mind.padEnd(8)}  ${formatMicros(row.bankroll).padStart(10)}  ${lastBet.padEnd(14)}  ${status.padEnd(11)}  ${wl}`
  })
  return [head, columns, ...body].join("\n")
}

function renderOne(
  row: WalletRow | null,
  now: number,
  control: ControlFile,
  alive: boolean,
  selected: number,
  total: number,
): string {
  if (!row) return "no wallet selected"
  const isPaused = control.paused.includes(row.address.toLowerCase())
  const state = isPaused ? "paused" : !alive ? (row.online ? "quiet (runner stopped)" : "asleep") : row.online ? "awake" : "asleep"
  const left = !alive ? "paused" : row.visitEnd > now ? `${Math.max(1, Math.round((row.visitEnd - now) / 1000))}s` : "ended"
  const tempo = Number.isFinite(row.tempo) ? row.tempo.toFixed(1) : String(row.tempo)
  const games = row.wins + row.losses
  const winRate = games > 0 ? ` (${Math.round((row.wins / games) * 100)}%)` : ""
  return [
    `wallet #${row.idx} (${selected + 1}/${Math.max(1, total)})   ${row.address}   [${isPaused ? "PAUSED — press p to resume" : "ACTIVE — press p to pause"}]`,
    `mind ${row.mind}   tempo ${tempo} windows   state ${state}   visit ${left}`,
    `bankroll ${formatMicros(row.bankroll)}   last ${row.lastSide ? `${row.lastSide} ${formatMicros(row.lastStake ?? 0)}` : "—"}   skip ${row.lastSkip ?? "—"}`,
    `wins ${row.wins}   losses ${row.losses}${winRate}`,
  ].join("\n")
}

function readRoster(filter: RosterFilter, offset: number): { rows: WalletRow[]; count: number } {
  if (!existsSync(SWARM_DB_PATH)) return { rows: [], count: 0 }
  const db = new Database(SWARM_DB_PATH, { readonly: true })
  try {
    return { rows: roster(db, filter, offset, PAGE), count: rosterCount(db, filter) }
  } finally {
    db.close()
  }
}

function toggleRunner(snapshot: SwarmSnapshot | null) {
  if (isRunnerAlive(snapshot)) {
    if (typeof snapshot?.pid === "number" && snapshot.pid > 0) {
      try {
        process.kill(snapshot.pid, "SIGTERM")
      } catch {}
    }
    return
  }
  startRunnerBackground()
}

function startRunnerBackground() {
  if ((process.env.CHAIN ?? "").trim() === "base" || !process.env.AGENT_SECRET) return
  try {
    const child = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts")], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: process.env,
    })
    child.unref()
  } catch {}
}

async function main() {
  let state: DashState = { view: 1, selected: 0, filter: "all", control: parseControl(readJson(CONTROL_PATH)) }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const load = () => parseSnapshot(readJson(SWARM_PATH)) ?? parseSnapshot(readJson(STATUS_PATH))

  if (interactive && !isRunnerAlive(load())) {
    startRunnerBackground()
  }

  const draw = () => {
    const snapshot = load()
    const page = Math.floor(state.selected / PAGE) * PAGE
    const { rows, count } = state.view >= 4 ? readRoster(state.filter, page) : { rows: [], count: 0 }
    if (count > 0 && state.selected >= count) state = { ...state, selected: count - 1 }
    const screen = renderSnapshot(snapshot, { ...state, totalCount: count }, rows)
    if (!interactive) {
      console.log(screen)
      return
    }
    process.stdout.write(`\x1b[H\x1b[2J${screen}\n`)
  }

  if (!interactive) {
    draw()
    return
  }

  process.stdout.write("\x1b[?1049h\x1b[?25l")
  process.stdin.setRawMode(true)
  process.stdin.resume()
  const restore = () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l")
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
  const shutdown = () => {
    restore()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.stdin.on("end", shutdown)
  const onKey = (key: string) => {
    if (key === "r") {
      toggleRunner(load())
      draw()
      return
    }
    const page = Math.floor(state.selected / PAGE) * PAGE
    const { rows, count } = readRoster(state.filter, page)
    const selectedRow = rows[state.selected - page] ?? null
    const next = handleKey(state, key, selectedRow?.address ?? null, count)
    const changed = JSON.stringify(next.state.control) !== JSON.stringify(state.control)
    state = next.state
    if (changed) writeJsonAtomic(CONTROL_PATH, state.control)
    if (next.quit) shutdown()
    else draw()
  }
  process.stdin.on("data", (chunk) => {
    const text = chunk.toString("utf8")
    for (let i = 0; i < text.length; i++) {
      if (
        text.startsWith("\u001b[A", i) ||
        text.startsWith("\u001b[B", i) ||
        text.startsWith("\u001b[C", i) ||
        text.startsWith("\u001b[D", i)
      ) {
        onKey(text.slice(i, i + 3))
        i += 2
      } else onKey(text[i]!)
    }
  })
  const timer = setInterval(draw, 250)
  timer.unref?.()
  draw()
  await new Promise(() => {})
}

if (import.meta.main) await main()
