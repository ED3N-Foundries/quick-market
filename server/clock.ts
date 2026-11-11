/** When the market loop should wake. Price fanout and window work are separate. */

export type MarketTiming = {
  windowMs: number
  marketMs: number
  /** Set while a venue handoff is counting down. Null when buy-ins are open. */
  handoffResumeAt: number | null
}

/**
 * The next window boundary, settle, or handoff resume strictly after `now`.
 * A wake at that instant is the moment `advance` must run.
 */
export function nextMarketAt(now: number, timing: MarketTiming): number {
  const open = timing.windowMs
  if (!(open > 0) || !Number.isFinite(now)) return now + 1_000
  const nextWindow = (Math.floor(now / open) + 1) * open
  let at = nextWindow
  const ride = timing.marketMs
  if (ride > 0) {
    // Round k-1 settles at k * window + ride. The smallest such instant after now.
    const k = Math.floor((now - ride) / open) + 1
    const settle = k * open + ride
    if (settle > now && settle < at) at = settle
  }
  const resume = timing.handoffResumeAt
  if (resume != null && resume > now && resume < at) at = resume
  return at
}

export type WakeInput = {
  now: number
  /** Market instant this wake was armed for. */
  marketAt: number
  lastTickAt: number
  tickMs: number
  hasPending: boolean
  /** A print arrived after a strike that is still waiting on a price. */
  strikeKick: boolean
}

export type WakePlan = {
  /** Run `advance`. This is the only plan that needs SQLite. */
  advance: boolean
  /** Send the queued price. No ledger read. */
  fanout: boolean
}

/** Decide what this wake does. A price slot that is not also a market instant does not advance. */
export function planWake(input: WakeInput): WakePlan {
  const advance = input.strikeKick || input.now >= input.marketAt
  const tickMs = input.tickMs
  const fanout = input.hasPending && (!(tickMs > 0) || input.now - input.lastTickAt >= tickMs)
  return { advance, fanout }
}

/** Run the plan. `advance` is skipped entirely on a price-only wake. */
export function runWake<T>(plan: WakePlan, actions: { advance: () => T; fanout: () => void }): { advanced: T | null } {
  const advanced = plan.advance ? actions.advance() : null
  if (plan.fanout) actions.fanout()
  return { advanced }
}
