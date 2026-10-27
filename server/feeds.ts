import type { PriceSource } from "../shared/market"
import type { Handoff } from "../shared/source"
import { dollarGap, withinDollars } from "./blend"
import { STANDBY_MS, SWITCH_DOLLARS, VENUE_ORDER, type OracleView, type SwitchEvent } from "./oracle"

export type LegRole = "active" | "ready" | "stale" | "far" | "quiet" | "down"

export type VenueRow = {
  venue: PriceSource
  price: string | null
  at: number
  feed: string | null
  up: boolean
  role: LegRole
  reason: string
  gap: string | null
  swing: string
}

export type FeedFrame = {
  at: number
  configured: PriceSource
  active: PriceSource | null
  anchor: string | null
  live: "live" | "stale"
  handoff: Handoff | null
  switches: SwitchEvent[]
  venues: VenueRow[]
}

export type LegInput = {
  venue: PriceSource
  active: PriceSource | null
  anchor: string | null
  price: string | null
  at: number
  movedAt?: number
  up: boolean
  now: number
}

/** Dashboard label. `active` wins. A backup whose price changed within 5s and is inside $25 is `ready`. */
export function legRole(input: LegInput): { role: LegRole; reason: string } {
  if (input.venue === input.active) {
    return { role: "active", reason: input.up ? "publishing the price" : "publishing, socket down" }
  }
  if (!input.up) return { role: "down", reason: "socket is down" }
  if (!input.price) return { role: "quiet", reason: "no price yet" }
  const movedAt = input.movedAt ?? input.at
  if (movedAt <= 0 || input.now - movedAt > STANDBY_MS) return { role: "stale", reason: "no price move for 5s" }
  if (!input.anchor) return { role: "far", reason: "no anchor to compare" }
  if (!withinDollars(input.anchor, input.price, SWITCH_DOLLARS)) {
    return { role: "far", reason: "more than $25 from the anchor" }
  }
  return { role: "ready", reason: "fresh and within $25" }
}

export function feedsNow(
  view: OracleView,
  market: { configured: PriceSource; live: "live" | "stale"; handoff: Handoff | null; now: number },
): FeedFrame {
  const venues = VENUE_ORDER.map((venue) => {
    const leg = view.venues.find((item) => item.venue === venue) ?? {
      venue,
      price: null,
      at: 0,
      feed: null,
      up: false,
    }
    const movedAt = leg.movedAt ?? leg.at
    const swing = leg.swing ?? "0"
    const status = legRole({
      venue,
      active: view.active,
      anchor: view.anchor,
      price: leg.price,
      at: leg.at,
      movedAt,
      up: leg.up,
      now: market.now,
    })
    const gap = view.anchor && leg.price ? dollarGap(view.anchor, leg.price) : null
    return {
      venue,
      price: leg.price,
      at: leg.at,
      feed: leg.feed,
      up: leg.up,
      role: status.role,
      reason: status.reason,
      gap,
      swing,
    }
  })
  return {
    at: market.now,
    configured: market.configured,
    active: view.active,
    anchor: view.anchor,
    live: market.live,
    handoff: market.handoff,
    switches: view.switches ?? [],
    venues,
  }
}
