import type { PriceSource } from "../shared/market"
import type { Handoff } from "../shared/source"
import { dollarGap, withinDollars } from "./blend"
import { STANDBY_MS, SWITCH_DOLLARS, VENUE_ORDER, type OracleView } from "./oracle"

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
}

export type FeedFrame = {
  at: number
  configured: PriceSource
  active: PriceSource | null
  anchor: string | null
  live: "live" | "stale"
  handoff: Handoff | null
  venues: VenueRow[]
}

export type LegInput = {
  venue: PriceSource
  active: PriceSource | null
  anchor: string | null
  price: string | null
  at: number
  up: boolean
  now: number
}

/** Dashboard label. `active` wins. A fresh backup within $25 is `ready`; a wider fresh gap is `far` and can still be selected. */
export function legRole(input: LegInput): { role: LegRole; reason: string } {
  if (input.venue === input.active) {
    return { role: "active", reason: input.up ? "publishing the price" : "publishing, socket down" }
  }
  if (!input.up) return { role: "down", reason: "socket is down" }
  if (!input.price) return { role: "quiet", reason: "no price yet" }
  if (input.now - input.at > STANDBY_MS) return { role: "stale", reason: "print is older than 3s" }
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
    const leg = view.venues.find((item) => item.venue === venue) ?? { venue, price: null, at: 0, feed: null, up: false }
    const status = legRole({
      venue,
      active: view.active,
      anchor: view.anchor,
      price: leg.price,
      at: leg.at,
      up: leg.up,
      now: market.now,
    })
    const gap = view.anchor && leg.price ? dollarGap(view.anchor, leg.price) : null
    return { venue, price: leg.price, at: leg.at, feed: leg.feed, up: leg.up, role: status.role, reason: status.reason, gap }
  })
  return {
    at: market.now,
    configured: market.configured,
    active: view.active,
    anchor: view.anchor,
    live: market.live,
    handoff: market.handoff,
    venues,
  }
}
