export type NearFunding = {
  cooling: boolean
  retryAfterMs: number
  untilMs: number | null
  reason: string | null
}

export const NEAR_COOLING_CODE = "NEAR_COOLING"

export function emptyNearFunding(): NearFunding {
  return { cooling: false, retryAfterMs: 0, untilMs: null, reason: null }
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Parse `/api/state`, snapshot, or error payloads. Never throws. */
export function parseNearFunding(value: unknown): NearFunding {
  if (!value || typeof value !== "object") return emptyNearFunding()
  const row = value as Record<string, unknown>
  const cooling = row.cooling === true
  const retryAfterMs = numOrNull(row.retryAfterMs) ?? 0
  const untilMs = numOrNull(row.untilMs)
  const reason = typeof row.reason === "string" ? row.reason : null
  return {
    cooling,
    retryAfterMs: Math.max(0, Math.floor(retryAfterMs)),
    untilMs,
    reason,
  }
}

/** Source of truth is server `untilMs`; fall back to `retryAfterMs` for clock skew. */
export function nearRetryMs(funding: NearFunding | null | undefined, now = Date.now()): number {
  if (!funding?.cooling) return 0
  if (typeof funding.untilMs === "number" && Number.isFinite(funding.untilMs)) {
    return Math.max(0, Math.ceil(funding.untilMs - now))
  }
  return Math.max(0, Math.ceil(funding.retryAfterMs))
}

/** Whole seconds, at least 1 while cooling. */
export function nearRetrySeconds(retryMs: number): number {
  return Math.max(1, Math.ceil(Math.max(0, retryMs) / 1000))
}

export function formatNearRetry(retryMs: number): string {
  return `${nearRetrySeconds(retryMs)}s`
}

/** True when a grant/withdraw response is the funding cooldown. */
export function isNearCoolingBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  const row = body as Record<string, unknown>
  return row.code === NEAR_COOLING_CODE
}
