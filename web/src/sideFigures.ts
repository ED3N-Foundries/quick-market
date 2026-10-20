export type SideBook = {
  roundId: number | null
  upShare: string
  downShare: string
  upPool: number
  downPool: number
  upPlayers: number
  downPlayers: number
  upQuote: string
  downQuote: string
}

/** How long a brand-new empty book stays hidden so a one-frame zero does not paint. */
export const HOLD_MS = 150

export function bookKey(book: SideBook): string {
  return [
    book.roundId ?? "",
    book.upPool,
    book.downPool,
    book.upPlayers,
    book.downPlayers,
    book.upShare,
    book.downShare,
    book.upQuote,
    book.downQuote,
  ].join("|")
}

export function sameBook(a: SideBook, b: SideBook): boolean {
  return bookKey(a) === bookKey(b)
}

export function bookEmpty(book: SideBook): boolean {
  return book.upPool <= 0 && book.downPool <= 0
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * What the up/down cards should paint.
 * Same round: the incoming book, immediately.
 * A new round that is empty while the previous book was not: keep the previous
 * book until HOLD_MS, so a fresh window does not flash 0%.
 * Otherwise the incoming book. `fade` is set only when the round changed and
 * motion is allowed. Numbers are never counted through zero.
 */
export function bookStep(
  shown: SideBook | null,
  incoming: SideBook,
  elapsedMs: number,
  reducedMotion: boolean,
): { book: SideBook; fade: boolean } {
  if (!shown || shown.roundId === incoming.roundId) return { book: incoming, fade: false }
  if (bookEmpty(incoming) && !bookEmpty(shown) && elapsedMs < HOLD_MS) return { book: shown, fade: false }
  return { book: incoming, fade: !reducedMotion }
}
