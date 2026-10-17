import { existsSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { marketPreferences } from "../shared/market"
import { loadEnv } from "../server/env"
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

const FILTERS: readonly RosterFilter[] = ["all", "stuck", "richest"]

export const HELP_LINES = [
  "c clock   o off-peak   e peak   [ ] pin ±1   - = pin ±10",
  "b bets   m bleed   p wallet   P clear   j/k move   f filter   r runner   q quit",
] as const

export type DashState = {
  selected: number
  filter: RosterFilter
  help: boolean
  control: ControlFile
}

export type KeyInput = {
  name: string
  shift?: boolean
  ctrl?: boolean
  sequence?: string
}

export function keyFromEvent(key: KeyInput): string | null {
  if (key.ctrl && key.name.toLowerCase() === "c") return "\u0003"
  if (key.name === "up") return "k"
  if (key.name === "down") return "j"
  const sequence = key.sequence ?? ""
  if (sequence.length === 1 && !key.ctrl) return sequence
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name
  return null
}

export function handleKey(
  state: DashState,
  key: string,
  selectedAddress: string | null,
  count: number,
): { state: DashState; quit: boolean } {
  if (key === "q" || key === "\u0003") return { state, quit: true }
  if (key === "?") return { state: { ...state, help: !state.help }, quit: false }
  const control = { ...state.control, paused: state.control.paused.slice() }
  let { selected, filter } = state
  if ((key === "j" || key === "\u001b[B") && count > 0) selected = Math.min(count - 1, selected + 1)
  if ((key === "k" || key === "\u001b[A") && count > 0) selected = Math.max(0, selected - 1)
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
  if (key === "f") {
    filter = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length] ?? "all"
    selected = 0
  }
  if (key === "p" && selectedAddress) {
    const address = selectedAddress.toLowerCase()
    control.paused = control.paused.includes(address)
      ? control.paused.filter((item) => item !== address)
      : [...control.paused, address]
  }
  if (key === "P") control.paused = []
  return { state: { selected, filter, help: state.help, control }, quit: false }
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

export function panelsFit(width: number, snapshot: SwarmSnapshot, control: ControlFile): boolean {
  if (width < 100) return false
  return bookLine(snapshot, false).length + moneyLine(snapshot, control, false).length + 2 <= width - 2
}

export function rosterCapacity(width: number, height: number, options: { help: boolean; error: boolean; stacked: boolean }): number {
  const roomy = height >= 18
  const chrome =
    1 +
    1 +
    (roomy ? 1 : 0) +
    (options.stacked ? 2 : 1) +
    (roomy ? 1 : 0) +
    (options.error ? 1 : 0) +
    1 +
    1 +
    1 +
    (options.help ? 2 : 0)
  return Math.max(1, height - chrome)
}

export function followOffset(offset: number, selected: number, count: number, visible: number): number {
  const size = Math.max(1, visible)
  if (count <= 0) return 0
  const max = Math.max(0, count - size)
  let next = Math.min(Math.max(0, offset), max)
  if (selected < next) next = selected
  if (selected >= next + size) next = Math.min(max, selected - size + 1)
  return next
}

export function crowdLine(snapshot: SwarmSnapshot, alive: boolean): string {
  const online = alive ? String(snapshot.online) : `0 (last ${snapshot.online})`
  const enrolled = typeof snapshot.enrolled === "number" ? `   enrolled ${snapshot.enrolled}` : ""
  const low = Math.round(snapshot.window[0])
  const high = Math.round(snapshot.window[1])
  return `online ${online}${enrolled}   window ${low}–${high}   spring ${Math.round(snapshot.spring)}   target ${Math.round(snapshot.target)}   +${snapshot.arrivedMinute} −${snapshot.leftMinute}`
}

export function bookLine(snapshot: SwarmSnapshot, wide: boolean): string {
  const book = snapshot.book
  const pool = book.upMicros + book.downMicros
  const bot = book.botUpMicros + book.botDownMicros
  const share = pool === 0 ? "—" : `${Math.round((bot / pool) * 100)}%`
  const head = `book  r${book.roundId ?? "—"}  up ${formatMicros(book.upMicros)}  down ${formatMicros(book.downMicros)}  bots ${share}  bets ${book.bets}  skips ${book.skips}`
  if (!wide) return head
  const lag = snapshot.bookLagMs === null ? "—" : `${snapshot.bookLagMs}ms`
  return `${head}  p50 ${formatMicros(book.p50)}  p90 ${formatMicros(book.p90)}  lag ${lag}`
}

export function moneyLine(snapshot: SwarmSnapshot, control: ControlFile, wide: boolean): string {
  const money = snapshot.money
  const net = money.seedMicros + money.mintMicros - money.burnMicros
  const bleed = control.bleed ? "bleed on" : "bleed off"
  const head = `money  seed ${formatMicros(money.seedMicros)}  net ${formatMicros(net)}  ${bleed}`
  if (!wide) return head
  return `money  seed ${formatMicros(money.seedMicros)}  mints ${formatMicros(money.mintMicros)}  burns ${formatMicros(money.burnMicros)}  net ${formatMicros(net)}  staked ${formatMicros(money.stakeMicros)}  ${bleed}`
}

export function histogramLine(snapshot: SwarmSnapshot): string {
  return snapshot.money.histogram.map((band) => `${band.band} ${band.count}`).join("   ")
}

export function statusLine(control: ControlFile): string {
  const mode = control.mode === "pin" ? `pin ${control.pin ?? 1}` : control.mode
  const bets = control.bettingPaused ? "bets paused" : "bets on"
  const bleed = control.bleed ? "bleed on" : "bleed off"
  return `${mode}  ·  ${bets}  ·  ${bleed}  ·  paused ${control.paused.length}`
}

export type RowTone = "text" | "muted" | "gold" | "up" | "down"

export type RosterCells = {
  mark: string
  idx: string
  address: string
  state: string
  stateTone: RowTone
  mind: string
  bankroll: string
  last: string
  lastTone: RowTone
  skip: string
  record: string
}

export function rosterCells(row: WalletRow, selected: boolean, control: ControlFile, alive: boolean): RosterCells {
  const paused = control.paused.includes(row.address.toLowerCase())
  const state = paused ? "paused" : !alive ? (row.online ? "quiet" : "asleep") : row.online ? "awake" : "asleep"
  const stateTone: RowTone = paused || state === "quiet" ? "gold" : state === "awake" ? "text" : "muted"
  const last = row.lastSide ? `${row.lastSide} ${formatMicros(row.lastStake ?? 0)}` : "—"
  const lastTone: RowTone = row.lastSide === "up" ? "up" : row.lastSide === "down" ? "down" : "muted"
  return {
    mark: selected ? ">" : " ",
    idx: String(row.idx),
    address: shortAddress(row.address),
    state,
    stateTone,
    mind: row.mind,
    bankroll: formatMicros(row.bankroll),
    last,
    lastTone,
    skip: row.lastSkip ?? (row.online ? "ready" : "asleep"),
    record: `${row.wins}/${row.losses}`,
  }
}

export function detailLine(row: WalletRow | null, control: ControlFile, alive: boolean, now: number): string {
  if (!row) return "no wallet selected"
  const paused = control.paused.includes(row.address.toLowerCase())
  const visit = !alive ? "runner quiet" : row.visitEnd > now ? `${Math.max(1, Math.round((row.visitEnd - now) / 1000))}s left` : "visit ended"
  const tempo = Number.isFinite(row.tempo) ? row.tempo.toFixed(1) : String(row.tempo)
  const last = row.lastSide ? `${row.lastSide} ${formatMicros(row.lastStake ?? 0)}` : "—"
  const games = row.wins + row.losses
  const rate = games > 0 ? ` ${Math.round((row.wins / games) * 100)}%` : ""
  return `#${row.idx}  ${row.mind}  tempo ${tempo}  ${visit}  ${formatMicros(row.bankroll)}  last ${last}  ${row.lastSkip ?? "—"}  ${row.wins}/${row.losses}${rate}${paused ? "  paused" : ""}`
}

export function renderSnapshot(
  snapshot: SwarmSnapshot | null,
  state: { help?: boolean; control?: ControlFile } = {},
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
  const control = state.control ?? controlFromSnapshot(snapshot)
  const lines = [
    `Manila ${snapshot.manila}   ${snapshot.phase}   ${alive ? "runner live" : "agent quiet"}`,
    crowdLine(snapshot, alive),
    spark(snapshot.trace) || "·",
    bookLine(snapshot, true),
    moneyLine(snapshot, control, true),
    histogramLine(snapshot),
    snapshot.lastError ? `error ${snapshot.lastError}` : "",
    statusLine(control),
    ...(state.help ? HELP_LINES : []),
  ].filter((line) => line !== "")
  return lines.join("\n")
}

export function loadSnapshot(): SwarmSnapshot | null {
  return parseSnapshot(readJson(SWARM_PATH)) ?? parseSnapshot(readJson(STATUS_PATH))
}

export function loadControl(): ControlFile {
  return parseControl(readJson(CONTROL_PATH))
}

export function saveControl(control: ControlFile) {
  writeJsonAtomic(CONTROL_PATH, control)
}

export function pageRoster(
  filter: RosterFilter,
  selected: number,
  previousOffset: number,
  capacity: number,
): { rows: WalletRow[]; count: number; offset: number; selected: number } {
  const size = Math.max(1, capacity)
  if (!existsSync(SWARM_DB_PATH)) return { rows: [], count: 0, offset: 0, selected: 0 }
  const db = new Database(SWARM_DB_PATH, { readonly: true })
  try {
    const count = rosterCount(db, filter)
    const nextSelected = count === 0 ? 0 : Math.min(Math.max(0, selected), count - 1)
    const offset = followOffset(previousOffset, nextSelected, count, size)
    return { rows: roster(db, filter, offset, size), count, offset, selected: nextSelected }
  } finally {
    db.close()
  }
}

export function toggleRunner(snapshot: SwarmSnapshot | null) {
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

export function bootRunner() {
  if (!isRunnerAlive(loadSnapshot())) startRunnerBackground()
}

function controlFromSnapshot(snapshot: SwarmSnapshot): ControlFile {
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

function startRunnerBackground() {
  if (marketPreferences.chain === "base" || !loadEnv().agentSecret) return
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
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!interactive) {
    console.log(renderSnapshot(loadSnapshot(), { control: loadControl() }))
    return
  }
  const { runScreen } = await import("./screen.tsx")
  await runScreen()
}

if (import.meta.main) await main()
