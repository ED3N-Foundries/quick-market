import { useCallback, useEffect, useRef, useState } from "react"
import { prefersReducedMotion } from "./sideFigures"

export type ToastKind = "progress" | "ok" | "error"

export type ToastMeter = { seen: number; needed: number }

export type ToastItem = {
  id: string
  kind: ToastKind
  title: string
  text?: string
  txHash?: string | null
  txUrl?: string | null
  meter?: ToastMeter | null
}

const TOAST_MS = 7000
const LEAVE_MS = 180

function briefHash(hash: string): string {
  return hash.length < 18 ? hash : `${hash.slice(0, 10)}…${hash.slice(-4)}`
}

/**
 * One overlay toast. It sits on a fixed slot, so a new message replaces the
 * current one instead of stacking. Progress toasts persist until dismissed;
 * ok/error toasts time out on their own.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef(new Map<string, number>())

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((items) => (items.some((item) => item.id === id) ? items.filter((item) => item.id !== id) : items))
  }, [])

  const upsert = useCallback((item: ToastItem) => {
    const old = timers.current.get(item.id)
    if (old !== undefined) {
      window.clearTimeout(old)
      timers.current.delete(item.id)
    }
    if (item.kind !== "progress") {
      timers.current.set(
        item.id,
        window.setTimeout(() => {
          timers.current.delete(item.id)
          setToasts((items) => items.filter((entry) => entry.id !== item.id))
        }, TOAST_MS),
      )
    }
    setToasts((items) => {
      for (const entry of items) {
        if (entry.id === item.id) continue
        const timer = timers.current.get(entry.id)
        if (timer !== undefined) {
          window.clearTimeout(timer)
          timers.current.delete(entry.id)
        }
      }
      const current = items.find((entry) => entry.id === item.id)
      if (
        items.length === 1 &&
        current?.kind === item.kind &&
        current?.title === item.title &&
        current?.text === item.text &&
        current?.txHash === item.txHash &&
        current?.txUrl === item.txUrl &&
        current?.meter?.seen === item.meter?.seen &&
        current?.meter?.needed === item.meter?.needed
      ) {
        return items
      }
      return [item]
    })
  }, [])

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer))
      timers.current.clear()
    },
    [],
  )

  return { toasts, upsert, dismiss }
}

function toastKey(item: ToastItem | null): string {
  if (!item) return ""
  return `${item.id}\0${item.kind}\0${item.title}\0${item.text ?? ""}\0${item.txHash ?? ""}\0${item.txUrl ?? ""}\0${item.meter?.seen ?? ""}\0${item.meter?.needed ?? ""}`
}

export function ToastStack({ toasts, onClose }: { toasts: ToastItem[]; onClose: (id: string) => void }) {
  const next = toasts[toasts.length - 1] ?? null
  const nextKey = toastKey(next)
  const [view, setView] = useState<{ item: ToastItem; leaving: boolean } | null>(next ? { item: next, leaving: false } : null)
  const viewRef = useRef(view)
  viewRef.current = view
  const nextRef = useRef(next)
  nextRef.current = next

  useEffect(() => {
    const current = viewRef.current
    if (!next) {
      if (current && !current.leaving) setView({ item: current.item, leaving: true })
      return
    }
    if (!current) {
      setView({ item: next, leaving: false })
      return
    }
    if (current.item.id === next.id) {
      if (!current.leaving) setView({ item: next, leaving: false })
      return
    }
    if (!current.leaving) setView({ item: current.item, leaving: true })
  }, [nextKey, next])

  useEffect(() => {
    if (!view?.leaving) return
    const wait = prefersReducedMotion() ? 0 : LEAVE_MS
    const id = window.setTimeout(() => {
      const incoming = nextRef.current
      setView(incoming ? { item: incoming, leaving: false } : null)
    }, wait)
    return () => window.clearTimeout(id)
  }, [view?.leaving, view?.item.id])

  if (!view) return null
  const item = view.item
  const needed = item.meter?.needed ?? 0
  const seen = Math.min(needed, Math.max(0, item.meter?.seen ?? 0))
  const width = needed > 0 ? `${Math.round((seen / needed) * 100)}%` : "0%"
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      <div key={item.id} className="toast" data-kind={item.kind} data-leaving={view.leaving ? "1" : "0"}>
        <span className="toast-copy">
          <span className="toast-title">
            {item.kind === "progress" && <span className="wait-spin" aria-hidden="true" />}
            {item.title}
          </span>
          {item.text ? <span className="toast-text">{item.text}</span> : null}
          {needed > 0 && (
            <span className="toast-meter" aria-hidden="true">
              <span style={{ width }} />
            </span>
          )}
          {item.txHash &&
            (item.txUrl ? (
              <a className="toast-tx" href={item.txUrl} target="_blank" rel="noreferrer" title={item.txHash}>
                {briefHash(item.txHash)}
              </a>
            ) : (
              <span className="toast-tx" title={item.txHash}>
                {briefHash(item.txHash)}
              </span>
            ))}
        </span>
        <button type="button" className="plain toast-close" aria-label="Close" onClick={() => onClose(item.id)}>
          {"×"}
        </button>
      </div>
    </div>
  )
}
