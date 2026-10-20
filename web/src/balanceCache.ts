const KEY = "qm.balance"

export type CachedBalance = {
  balanceMicros: number
  grantAt: number | null
}

type BalanceStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function store(): BalanceStore | null {
  try {
    if (typeof localStorage === "undefined") return null
    return localStorage
  } catch {
    return null
  }
}

function readMap(source: BalanceStore): Record<string, CachedBalance> {
  const raw = source.getItem(KEY)
  if (!raw) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object") return {}
  return parsed as Record<string, CachedBalance>
}

function valid(entry: CachedBalance | undefined): entry is CachedBalance {
  if (!entry) return false
  if (!Number.isSafeInteger(entry.balanceMicros) || entry.balanceMicros < 0) return false
  if (entry.grantAt !== null && !Number.isSafeInteger(entry.grantAt)) return false
  return true
}

/** Last balance the server confirmed for this address. Null when missing or unreadable. */
export function readCachedBalance(address: string, source: BalanceStore | null = store()): CachedBalance | null {
  try {
    if (!source) return null
    const entry = readMap(source)[address.toLowerCase()]
    return valid(entry) ? { balanceMicros: entry.balanceMicros, grantAt: entry.grantAt } : null
  } catch {
    return null
  }
}

/** Remember a server-confirmed balance. A bad payload is ignored. */
export function writeCachedBalance(
  you: { address: string; balanceMicros: number; grantAt: number | null },
  source: BalanceStore | null = store(),
): void {
  try {
    if (!source || !you.address) return
    const entry = { balanceMicros: you.balanceMicros, grantAt: you.grantAt }
    if (!valid(entry)) return
    const map = readMap(source)
    map[you.address.toLowerCase()] = entry
    source.setItem(KEY, JSON.stringify(map))
  } catch {
    // Private mode and a broken cache both leave the last good value unread.
  }
}

/** Cached figure until the server has answered. After that, the server figure, including zero or none. */
export function visibleBalance(confirmed: boolean, serverMicros: number | null, cachedMicros: number | null): number | null {
  if (confirmed) return serverMicros
  return cachedMicros
}
