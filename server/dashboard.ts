import type { PriceSource } from "../shared/market"
import { quotePair, sourceLabel } from "../shared/source"
import { dollarGap } from "./blend"
import { loadEnv } from "./env"
import { SWITCH_LOG, VENUE_ORDER, type SwitchEvent } from "./oracle"
import type { FeedFrame, LegRole, VenueRow } from "./feeds"

const VENUES = new Set<string>(VENUE_ORDER)
const ROLES = new Set<LegRole>(["active", "ready", "stale", "far", "quiet", "down"])

export const HELP_LINES = ["j k move   q quit"] as const

export type DashState = {
  selected: number
  help: boolean
}

export type KeyInput = {
  name: string
  shift?: boolean
  ctrl?: boolean
  sequence?: string
}

export type BookSide = {
  poolMicros: number
  players: number
}

export type MarketStats = {
  phase: "buy-in" | "market"
  windowEndsAt: number
  join: { up: BookSide; down: BookSide } | null
  live: { strike: string | null; settlesAt: number; up: BookSide; down: BookSide } | null
}

/** API origin. `API_URL` wins, so a dashboard on the host or inside the compose network hits the same server. */
export function apiBase(apiUrl = loadEnv().apiUrl): string {
  return apiUrl.trim().replace(/\/api\/session\/?$/, "").replace(/\/+$/, "")
}

export function feedsUrl(apiUrl = loadEnv().apiUrl): string {
  return `${apiBase(apiUrl)}/api/feeds`
}

export function stateUrl(apiUrl = loadEnv().apiUrl): string {
  return `${apiBase(apiUrl)}/api/state`
}

export function apiHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function wideLayout(width: number): boolean {
  return width >= 88
}

export function keyFromEvent(key: KeyInput): string | null {
  if (key.ctrl && key.name.toLowerCase() === "c") return "\u0003"
  if (key.name === "escape" || key.name === "esc") return "escape"
  if (key.name === "up") return "k"
  if (key.name === "down") return "j"
  const sequence = key.sequence ?? ""
  if (sequence.length === 1 && !key.ctrl) return sequence
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name
  return null
}

export function handleKey(state: DashState, key: string, count: number): { state: DashState; quit: boolean } {
  if (key === "q" || key === "\u0003") return { state, quit: true }
  if (key === "?") return { state: { ...state, help: !state.help }, quit: false }
  let selected = state.selected
  if ((key === "j" || key === "\u001b[B") && count > 0) selected = Math.min(count - 1, selected + 1)
  if ((key === "k" || key === "\u001b[A") && count > 0) selected = Math.max(0, selected - 1)
  return { state: { ...state, selected }, quit: false }
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  return `${(ms / 1_000).toFixed(1)}s`
}

export function sourceLine(frame: FeedFrame, now: number): string {
  if (!frame.active) return "no price source"
  const venue = frame.venues.find((row) => row.venue === frame.active)
  const price = showPrice(venue?.price ?? null)
  const age = venue && venue.at > 0 ? formatAge(Math.max(0, now - venue.at)) : "—"
  return `${sourceLabel(frame.active)}   ${frame.live}   ${price}   ${age}`
}

export function holdLine(frame: FeedFrame, now: number): string {
  const handoff = frame.handoff
  if (!handoff) return `configured ${frame.configured}   handoff none`
  if (!handoff.to) return `configured ${frame.configured}   handoff ${handoff.from} dropped, waiting`
  const wait = handoff.resumeAt != null && handoff.resumeAt > now ? `   buy-in resumes in ${formatAge(handoff.resumeAt - now)}` : ""
  return `configured ${frame.configured}   handoff ${handoff.from} → ${handoff.to}${wait}`
}

export function signedMove(strike: string, price: string): string {
  const gap = dollarGap(strike, price)
  if (gap == null) return "—"
  const amount = Number(gap)
  if (!Number.isFinite(amount)) return gap
  const text = amount.toFixed(2)
  const left = Number(strike)
  const right = Number(price)
  if (!Number.isFinite(left) || !Number.isFinite(right) || right === left || amount < 0.005) return "=$0.00"
  return right > left ? `+$${text}` : `−$${text}`
}

export function marketLines(stats: MarketStats, price: string | null, now: number): string[] {
  const wait = formatAge(Math.max(0, stats.windowEndsAt - now))
  const buyIn = stats.join
    ? `buy-in ${wait}   ${sideText("up", stats.join.up)}   ${sideText("down", stats.join.down)}`
    : `buy-in closed   resumes in ${wait}`
  const lines = [buyIn]
  const live = stats.live
  if (!live) return lines
  const move = live.strike && price ? signedMove(live.strike, price) : "—"
  const left = formatAge(Math.max(0, live.settlesAt - now))
  lines.push(
    `market ${left}   strike ${showPrice(live.strike)}   ${move}   ${sideText("up", live.up)}   ${sideText("down", live.down)}`,
  )
  return lines
}

function sideText(name: string, side: BookSide): string {
  return `${name} ${dollars(side.poolMicros)} · ${Math.trunc(side.players)}`
}

function dollars(micros: number): string {
  const sign = micros < 0 ? "-" : ""
  const abs = Math.abs(Math.trunc(micros))
  const whole = Math.floor(abs / 1_000_000)
  const cents = Math.floor((abs % 1_000_000) / 10_000)
  return `${sign}$${whole.toLocaleString("en-US")}.${String(cents).padStart(2, "0")}`
}

export function detailLine(row: VenueRow | null, now: number): string {
  if (!row) return "no venue selected"
  const age = row.at > 0 ? formatAge(Math.max(0, now - row.at)) : "—"
  const gap = row.gap == null ? "—" : Number(row.gap).toFixed(2)
  return `${row.venue}  ${quotePair(row.venue)}  ${row.role}  ${row.reason}  ping ${age}  gap ${gap}`
}

export function switchStamp(at: number): string {
  return `${new Date(at).toISOString().slice(11, 19)}Z`
}

export function switchLine(row: SwitchEvent): string {
  return `${switchStamp(row.at)}  ${row.from} → ${row.to ?? "waiting"}  ${row.reason}`
}

/** Tall screens show the last five. A short screen keeps the newest row. */
export function switchLines(rows: readonly SwitchEvent[], height: number): string[] {
  if (rows.length === 0) return ["switches  none"]
  const shown = height >= 22 ? rows.slice(0, SWITCH_LOG) : rows.slice(0, 1)
  return shown.map(switchLine)
}

export function venueLine(row: VenueRow, selected: boolean, wide: boolean, now: number): string {
  const age = row.at > 0 ? formatAge(Math.max(0, now - row.at)) : "—"
  const head = `${selected ? ">" : " "} ${cell(row.venue, 10)}${cell(row.role, 8)}${cell(showPrice(row.price), 12)}${cell(age, 8)}`
  if (!wide) return head.trimEnd()
  return `${head}${cell(showGap(row.gap), 10)}${cell(showSwing(row.swing), 10)}${row.feed ?? "—"}`.trimEnd()
}

export function headLine(wide: boolean): string {
  const head = `  ${cell("venue", 10)}${cell("role", 8)}${cell("price", 12)}${cell("ping", 8)}`
  if (!wide) return head.trimEnd()
  return `${head}${cell("gap", 10)}${cell("swing", 10)}feed`
}

export function renderFeeds(
  frame: FeedFrame | null,
  state: DashState & { quiet: boolean },
  now: number,
  url: string,
  stats: MarketStats | null = null,
  height = 24,
): string {
  if (!frame) {
    const lines = [`Waiting for the API on ${apiHost(url)}.`, "q closes this dashboard. The API keeps going."]
    if (state.quiet) lines.push("api quiet")
    return lines.join("\n")
  }
  const price = frame.venues.find((row) => row.venue === frame.active)?.price ?? frame.anchor
  const lines = [
    sourceLine(frame, now),
    holdLine(frame, now),
    ...switchLines(frame.switches, height),
    ...(stats ? marketLines(stats, price, now) : []),
    state.quiet ? "api quiet" : "",
    headLine(true),
    ...frame.venues.map((row, index) => venueLine(row, index === state.selected, true, now)),
    detailLine(frame.venues[state.selected] ?? null, now),
    state.help ? HELP_LINES[0] : "q quit",
  ]
  return lines.filter((line) => line !== "").join("\n")
}

export async function pullFeeds(url: string): Promise<{ frame: FeedFrame | null; stats: MarketStats | null; quiet: boolean }> {
  const base = url.replace(/\/api\/feeds\/?$/, "")
  try {
    const [feedsRes, stateRes] = await Promise.all([fetch(url), fetch(`${base}/api/state`)])
    if (!feedsRes.ok) return { frame: null, stats: null, quiet: true }
    const frame = parseFeedFrame(await feedsRes.json())
    if (!frame) return { frame: null, stats: null, quiet: true }
    const stats = stateRes.ok ? parseMarketStats(await stateRes.json()) : null
    return { frame, stats, quiet: false }
  } catch {
    return { frame: null, stats: null, quiet: true }
  }
}

export function parseMarketStats(value: unknown): MarketStats | null {
  if (!isRecord(value) || !isRecord(value.board)) return null
  const board = value.board
  if (board.phase !== "buy-in" && board.phase !== "market") return null
  if (typeof board.windowEndsAt !== "number" || !Number.isFinite(board.windowEndsAt)) return null
  if (board.join !== null && !isRecord(board.join)) return null
  const join = board.join === null ? null : parseBook(board.join)
  if (board.join !== null && !join) return null
  if (board.live !== null && board.live !== undefined && !isRecord(board.live)) return null
  const live = board.live == null ? null : parseLive(board.live)
  if (board.live != null && !live) return null
  return { phase: board.phase, windowEndsAt: board.windowEndsAt, join, live }
}

function parseBook(value: Record<string, unknown>): { up: BookSide; down: BookSide } | null {
  const up = parseSide(value.poolUpMicros, value.playersUp)
  const down = parseSide(value.poolDownMicros, value.playersDown)
  if (!up || !down) return null
  return { up, down }
}

function parseLive(value: Record<string, unknown>): MarketStats["live"] | null {
  const book = parseBook(value)
  if (!book) return null
  if (value.strike !== null && typeof value.strike !== "string") return null
  if (typeof value.settlesAt !== "number" || !Number.isFinite(value.settlesAt)) return null
  return { strike: value.strike, settlesAt: value.settlesAt, ...book }
}

function parseSide(pool: unknown, players: unknown): BookSide | null {
  if (typeof pool !== "number" || !Number.isFinite(pool)) return null
  if (typeof players !== "number" || !Number.isFinite(players)) return null
  return { poolMicros: pool, players }
}

export function parseFeedFrame(value: unknown): FeedFrame | null {
  if (!isRecord(value)) return null
  if (!isSource(value.configured)) return null
  if (value.active !== null && !isSource(value.active)) return null
  if (value.anchor !== null && typeof value.anchor !== "string") return null
  if (value.live !== "live" && value.live !== "stale") return null
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null
  const handoff = parseHandoff(value.handoff)
  if (handoff === undefined) return null
  const switches = parseSwitches(value.switches)
  if (!switches) return null
  if (!Array.isArray(value.venues) || value.venues.length !== VENUE_ORDER.length) return null
  const venues: VenueRow[] = []
  for (let index = 0; index < VENUE_ORDER.length; index++) {
    const row = parseVenue(value.venues[index], VENUE_ORDER[index]!)
    if (!row) return null
    venues.push(row)
  }
  return {
    at: value.at,
    configured: value.configured,
    active: value.active,
    anchor: value.anchor,
    live: value.live,
    handoff,
    switches,
    venues,
  }
}

function parseSwitches(value: unknown): SwitchEvent[] | null {
  if (value == null) return []
  if (!Array.isArray(value)) return null
  const rows: SwitchEvent[] = []
  for (const item of value) {
    const row = parseSwitch(item)
    if (!row) return null
    rows.push(row)
  }
  return rows.slice(0, SWITCH_LOG)
}

function parseSwitch(value: unknown): SwitchEvent | null {
  if (!isRecord(value) || !isSource(value.from)) return null
  if (value.to !== null && !isSource(value.to)) return null
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null
  if (typeof value.reason !== "string" || value.reason.length === 0) return null
  return { at: value.at, from: value.from, to: value.to, reason: value.reason }
}

function parseHandoff(value: unknown): FeedFrame["handoff"] | undefined {
  if (value === null) return null
  if (!isRecord(value) || !isSource(value.from)) return undefined
  if (value.to !== null && !isSource(value.to)) return undefined
  if (value.resumeAt !== null && (typeof value.resumeAt !== "number" || !Number.isFinite(value.resumeAt))) return undefined
  return { from: value.from, to: value.to, resumeAt: value.resumeAt }
}

function parseVenue(value: unknown, venue: PriceSource): VenueRow | null {
  if (!isRecord(value) || value.venue !== venue) return null
  if (value.price !== null && typeof value.price !== "string") return null
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null
  if (value.feed !== null && typeof value.feed !== "string") return null
  if (typeof value.up !== "boolean") return null
  if (typeof value.role !== "string" || !ROLES.has(value.role as LegRole)) return null
  if (typeof value.reason !== "string") return null
  if (value.gap !== null && typeof value.gap !== "string") return null
  if (value.swing != null && typeof value.swing !== "string") return null
  return {
    venue,
    price: value.price,
    at: value.at,
    feed: value.feed,
    up: value.up,
    role: value.role as LegRole,
    reason: value.reason,
    gap: value.gap,
    swing: typeof value.swing === "string" ? value.swing : "0",
  }
}

function isSource(value: unknown): value is PriceSource {
  return typeof value === "string" && VENUES.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function showPrice(price: string | null): string {
  if (!price) return "—"
  const amount = Number(price)
  if (!Number.isFinite(amount)) return price
  return amount.toFixed(2)
}

function showGap(gap: string | null): string {
  if (gap == null) return "—"
  const amount = Number(gap)
  if (!Number.isFinite(amount)) return gap
  return amount.toFixed(2)
}

function showSwing(swing: string): string {
  const amount = Number(swing)
  if (!Number.isFinite(amount)) return swing
  return `$${amount.toFixed(2)}`
}

function cell(value: string, width: number): string {
  if (value.length > width) return value.slice(0, width)
  return value.padEnd(width)
}

async function main() {
  const url = feedsUrl()
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!interactive) {
    const pulled = await pullFeeds(url)
    console.log(renderFeeds(pulled.frame, { selected: 0, help: false, quiet: pulled.quiet }, Date.now(), url, pulled.stats))
    return
  }
  const { runScreen } = await import("./screen")
  await runScreen(url)
}

if (import.meta.main) await main()
