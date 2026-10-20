import { useEffect, useRef, useState } from "react"
import { HOLD_MS, bookStep, prefersReducedMotion, sameBook, type SideBook } from "./sideFigures"

export function useSideBook(incoming: SideBook): { book: SideBook; fade: boolean; gen: number } {
  const incomingRef = useRef(incoming)
  incomingRef.current = incoming
  const shownRef = useRef(incoming)
  const [paint, setPaint] = useState({ book: incoming, fade: false, gen: 0 })
  const key = [
    incoming.roundId ?? "",
    incoming.upPool,
    incoming.downPool,
    incoming.upPlayers,
    incoming.downPlayers,
    incoming.upShare,
    incoming.downShare,
    incoming.upQuote,
    incoming.downQuote,
  ].join("|")

  useEffect(() => {
    const reduced = prefersReducedMotion()
    let timer = 0
    const run = (elapsed: number) => {
      const next = incomingRef.current
      const step = bookStep(shownRef.current, next, elapsed, reduced)
      const holding = step.book === shownRef.current && next.roundId !== shownRef.current.roundId
      if (holding) {
        timer = window.setTimeout(() => run(HOLD_MS), Math.max(0, HOLD_MS - elapsed))
        return
      }
      const fade = step.fade && shownRef.current.roundId !== step.book.roundId
      if (sameBook(shownRef.current, step.book) && !fade) return
      shownRef.current = step.book
      setPaint((prev) => ({ book: step.book, fade, gen: fade ? prev.gen + 1 : prev.gen }))
    }
    run(0)
    return () => window.clearTimeout(timer)
  }, [key])

  return paint
}
