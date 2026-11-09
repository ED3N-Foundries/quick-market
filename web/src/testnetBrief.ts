export const BRIEF_KEY = "qm.testnetBriefAt"
export const BRIEF_MS = 24 * 60 * 60 * 1000

export type BriefStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function store(): BriefStore | null {
  try {
    if (typeof localStorage === "undefined") return null
    return localStorage
  } catch {
    return null
  }
}

/** True when the brief should show. Missing, unreadable, or at least `windowMs` old. */
export function briefDue(stored: number | null, now: number, windowMs = BRIEF_MS): boolean {
  if (stored === null || !Number.isSafeInteger(stored)) return true
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(windowMs) || windowMs <= 0) return true
  return now - stored >= windowMs
}

/** Dismiss time in ms, or null when missing or unreadable. */
export function readBriefAt(source: BriefStore | null = store()): number | null {
  try {
    if (!source) return null
    const raw = source.getItem(BRIEF_KEY)
    if (raw === null) return null
    const text = raw.trim()
    if (text === "") return null
    const value = Number(text)
    return Number.isSafeInteger(value) ? value : null
  } catch {
    return null
  }
}

/** Remember that the brief was dismissed. A thrown store leaves the next load due. */
export function writeBriefAt(now: number, source: BriefStore | null = store()): void {
  try {
    if (!source || !Number.isSafeInteger(now)) return
    source.setItem(BRIEF_KEY, String(now))
  } catch {
    // Private mode leaves the brief due on the next load.
  }
}
