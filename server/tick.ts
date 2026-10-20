/** Latest price waiting for the next fanout slot. `null` means nothing new to send. */
export function takeTick<T>(
  pending: T | null,
  lastSentAt: number,
  now: number,
  tickMs: number,
): { send: T | null; lastSentAt: number } {
  if (pending == null) return { send: null, lastSentAt }
  if (!(tickMs > 0) || now - lastSentAt < tickMs) return { send: null, lastSentAt }
  return { send: pending, lastSentAt: now }
}
