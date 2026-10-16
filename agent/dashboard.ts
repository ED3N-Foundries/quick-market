import { existsSync } from "node:fs"
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

const FILTERS: RosterFilter[] = ["all", "stuck", "richest", "woke", "slept"]

export function handleKey(state: DashState, key: string, selectedAddress: string | null, count: number): { state: DashState; quit: boolean } {
  if (key === "q" || key === "\u0003") return { state, quit: true }
  const control = { ...state.control, paused: state.control.paused.slice() }
  let { view, selected, filter } = state
  if (key === "1" || key === "2" || key === "3" || key === "4" || key === "5") view = Number(key) as DashState["view"]
  if ((key === "j" || key === "\u001b[B") && count > 0) selected = Math.min(count - 1, selected + 1)
  if ((key === "k" || key === "\u001b[A") && count > 0) selected = Math.max(0, selected - 1)
  if (key === "c") {
    control.mode = "clock"
    control.pin = null
  }
  if (key === "o") control.mode = "off-peak"
  if (key === "e") control.mode = "peak"
  if (key === "[") {
    control.mode = "pin"
    control.pin = Math.max(1, (control.pin ?? 30) - 1)
  }
  if (key === "]") {
    control.mode = "pin"
    control.pin = Math.min(6_000, (control.pin ?? 30) + 1)
  }
  if (key === "-") {
    control.mode = "pin"
    control.pin = Math.max(1, (control.pin ?? 30) - 10)
  }
  if (key === "=") {
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
  return { state: { view, selected, filter, control }, quit: false }
}

export function renderSnapshot(snapshot: SwarmSnapshot | null, state: Pick<DashState, "view" | "selected" | "filter">, rows: WalletRow[] = [], now = Date.now()): string {
  if (!snapshot) return ["Waiting for bun run agent.", "", "q closes this dashboard. The runner keeps going."].join("\n")
  const quiet = now - snapshot.at > 15_000 ? "agent quiet" : ""
  const pages = [
    renderCrowd(snapshot, quiet),
    renderBook(snapshot),
    renderMoney(snapshot),
    renderRoster(rows, state.selected, state.filter),
    renderOne(rows[state.selected % PAGE] ?? rows[0] ?? null, now),
  ]
  const help = "1 crowd  2 book  3 money  4 roster  5 wallet   j/k move   c clock  o off-peak  e peak  [ ] pin   b pause  p one  m bleed  f filter   q quit"
  return [pages[(state.view - 1)] ?? pages[0]!, "", help].join("\n")
}

function renderCrowd(snapshot: SwarmSnapshot, quiet: string): string {
  const window = `${snapshot.window[0]}–${snapshot.window[1]}`
  return [
    `Manila ${snapshot.manila}   ${snapshot.phase}   ${snapshot.mode}${snapshot.pin ? ` ${snapshot.pin}` : ""}`,
    `window ${window}   online ${snapshot.online}   spring ${Math.round(snapshot.spring)}   target ${Math.round(snapshot.target)}`,
    `arrivals ${snapshot.arrivedMinute}   departures ${snapshot.leftMinute}   ${quiet}`.trim(),
    spark(snapshot.trace) || "·",
    snapshot.lastError ? `error ${snapshot.lastError}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function renderBook(snapshot: SwarmSnapshot): string {
  const book = snapshot.book
  const total = book.bets + book.skips
  const skip = total === 0 ? "—" : `${Math.round((book.skips / total) * 100)}%`
  const bot = book.botUpMicros + book.botDownMicros
  const pool = book.upMicros + book.downMicros
  const share = pool === 0 ? "—" : `${Math.round((bot / pool) * 100)}%`
  return [
    `round ${book.roundId ?? "—"}   lag ${snapshot.bookLagMs === null ? "—" : `${snapshot.bookLagMs}ms`}`,
    `up ${formatMicros(book.upMicros)}   down ${formatMicros(book.downMicros)}   bot share ${share}`,
    `bets ${book.bets}   skips ${book.skips}   skip rate ${skip}`,
    `stake p50 ${formatMicros(book.p50)}   p90 ${formatMicros(book.p90)}`,
    snapshot.bettingPaused ? "betting paused" : "betting on",
  ].join("\n")
}

function renderMoney(snapshot: SwarmSnapshot): string {
  const money = snapshot.money
  const net = money.seedMicros + money.mintMicros - money.burnMicros
  const bars = money.histogram.map((band) => `${band.band} ${band.count}`).join("   ")
  return [
    `seed ${formatMicros(money.seedMicros)}   floor mints ${formatMicros(money.mintMicros)}   burns ${formatMicros(money.burnMicros)}`,
    `net bleed ${formatMicros(net)}   staked ${formatMicros(money.stakeMicros)}`,
    bars,
    snapshot.bleed ? "bleed on" : "bleed off",
  ].join("\n")
}

function renderRoster(rows: WalletRow[], selected: number, filter: RosterFilter): string {
  const head = `roster ${filter}`
  if (rows.length === 0) return `${head}\nno wallets`
  const body = rows.map((row, index) => {
    const mark = index === selected % PAGE ? ">" : " "
    const state = row.online ? "awake" : "asleep"
    const last = row.lastSide ? `${row.lastSide} ${formatMicros(row.lastStake ?? 0)}` : (row.lastSkip ?? "—")
    return `${mark} ${String(row.idx).padStart(4)}  ${shortAddress(row.address)}  ${state.padEnd(6)}  ${row.mind.padEnd(8)}  ${formatMicros(row.bankroll).padStart(10)}  ${last}`
  })
  return [head, ...body].join("\n")
}

function renderOne(row: WalletRow | null, now: number): string {
  if (!row) return "no wallet selected"
  const left = row.visitEnd > now ? `${Math.max(1, Math.round((row.visitEnd - now) / 1000))}s` : "ended"
  return [
    `${shortAddress(row.address)}   ${row.mind}   tempo ${row.tempo} windows`,
    `bankroll ${formatMicros(row.bankroll)}   ${row.online ? "awake" : "asleep"}   visit ${left}`,
    `last ${row.lastSide ? `${row.lastSide} ${formatMicros(row.lastStake ?? 0)}` : "—"}   skip ${row.lastSkip ?? "—"}`,
    `wins ${row.wins}   losses ${row.losses}`,
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

async function main() {
  let state: DashState = { view: 1, selected: 0, filter: "all", control: parseControl(readJson(CONTROL_PATH)) }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const load = () => parseSnapshot(readJson(SWARM_PATH)) ?? parseSnapshot(readJson(STATUS_PATH))

  const draw = () => {
    const snapshot = load()
    const page = Math.floor(state.selected / PAGE) * PAGE
    const { rows, count } = state.view >= 4 ? readRoster(state.filter, page) : { rows: [], count: 0 }
    if (count > 0 && state.selected >= count) state = { ...state, selected: count - 1 }
    const screen = renderSnapshot(snapshot, state, rows)
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
      if (text.startsWith("\u001b[A", i) || text.startsWith("\u001b[B", i)) {
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
