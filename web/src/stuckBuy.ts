/** A buy result that never arrives must not disable the buttons until refresh. */
export const STUCK_BUY_MS = 8_000

/** True when a pending buy can no longer be waiting on a live socket. */
export function buyIsStuck(input: {
  pending: boolean
  sentAt: number | null
  now: number
  socketOpen: boolean
}): boolean {
  if (!input.pending) return false
  if (!input.socketOpen) return true
  if (input.sentAt == null) return true
  return input.now - input.sentAt >= STUCK_BUY_MS
}

/**
 * The lock drops only after a release was asked for and the reload for that
 * release has applied the server account. A live bet that has not asked stays
 * locked, so it cannot be sent a second time.
 */
export function shouldReleaseStuckBuy(input: {
  pending: boolean
  releaseRequested: boolean
  serverYouApplied: boolean
}): boolean {
  return input.pending && input.releaseRequested && input.serverYouApplied
}
