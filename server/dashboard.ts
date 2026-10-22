import type { PriceSource } from "../shared/market"
import { quotePair, sourceLabel } from "../shared/source"
import { loadEnv } from "./env"
import { VENUE_ORDER } from "./oracle"
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

export function feedsUrl(port = loadEnv().port): string {
  return `http://127.0.0.1:${port}/api/feeds`
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

export function detailLine(row: VenueRow | null, now: number): string {
  if (!row) return "no venue selected"
  const age = row.at > 0 ? formatAge(Math.max(0, now - row.at)) : "—"
  const gap = row.gap == null ? "—" : Number(row.gap).toFixed(2)
  return `${row.venue}  ${quotePair(row.venue)}  ${row.role}  ${row.reason}  age ${age}  gap ${gap}`
}

export function venueLine(row: VenueRow, selected: boolean, wide: boolean, now: number): string {
  const age = row.at > 0 ? formatAge(Math.max(0, now - row.at)) : "—"
  const head = `${selected ? ">" : " "} ${cell(row.venue, 10)}${cell(row.role, 8)}${cell(showPrice(row.price), 12)}${cell(age, 8)}`
  if (!wide) return head.trimEnd()
  return `${head}${cell(showGap(row.gap), 10)}${row.feed ?? "—"}`.trimEnd()
}

export function headLine(wide: boolean): string {
  const head = `  ${cell("venue", 10)}${cell("role", 8)}${cell("price", 12)}${cell("age", 8)}`
  if (!wide) return head.trimEnd()
  return `${head}${cell("gap", 10)}feed`
}

export function renderFeeds(
  frame: FeedFrame | null,
  state: DashState & { quiet: boolean },
  now: number,
  url: string,
): string {
  if (!frame) {
    const lines = [`Waiting for the API on ${apiHost(url)}.`, "q closes this dashboard. The API keeps going."]
    if (state.quiet) lines.push("api quiet")
    return lines.join("\n")
  }
  const lines = [
    sourceLine(frame, now),
    holdLine(frame, now),
    state.quiet ? "api quiet" : "",
    headLine(true),
    ...frame.venues.map((row, index) => venueLine(row, index === state.selected, true, now)),
    detailLine(frame.venues[state.selected] ?? null, now),
    state.help ? HELP_LINES[0] : "q quit",
  ]
  return lines.filter((line) => line !== "").join("\n")
}

export async function pullFeeds(url: string): Promise<{ frame: FeedFrame | null; quiet: boolean }> {
  try {
    const response = await fetch(url)
    if (!response.ok) return { frame: null, quiet: true }
    const frame = parseFeedFrame(await response.json())
    if (!frame) return { frame: null, quiet: true }
    return { frame, quiet: false }
  } catch {
    return { frame: null, quiet: true }
  }
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
    venues,
  }
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
  return {
    venue,
    price: value.price,
    at: value.at,
    feed: value.feed,
    up: value.up,
    role: value.role as LegRole,
    reason: value.reason,
    gap: value.gap,
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

function cell(value: string, width: number): string {
  if (value.length > width) return value.slice(0, width)
  return value.padEnd(width)
}

async function main() {
  const url = feedsUrl()
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!interactive) {
    const pulled = await pullFeeds(url)
    console.log(renderFeeds(pulled.frame, { selected: 0, help: false, quiet: pulled.quiet }, Date.now(), url))
    return
  }
  const { runScreen } = await import("./screen")
  await runScreen(url)
}

if (import.meta.main) await main()
