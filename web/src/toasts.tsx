import { useCallback, useEffect, useRef, useState } from "react"

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
 * Overlay toast stack. Toasts float above the layout, so showing progress or
 * errors never resizes the page. Progress toasts persist until dismissed;
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
      const at = items.findIndex((entry) => entry.id === item.id)
      if (at < 0) return [...items.slice(-2), item]
      const current = items[at]
      if (
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
      const next = items.slice()
      next[at] = item
      return next
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

type ToastRow = { item: ToastItem; leaving: boolean }

export function ToastStack({ toasts, onClose }: { toasts: ToastItem[]; onClose: (id: string) => void }) {
  const [rows, setRows] = useState<ToastRow[]>([])
  const timers = useRef(new Map<string, number>())

  useEffect(() => {
    setRows((current) => {
      const incoming = new Map(toasts.map((item) => [item.id, item]))
      const next: ToastRow[] = []
      for (const row of current) {
        const fresh = incoming.get(row.item.id)
        if (fresh) {
          incoming.delete(row.item.id)
          const timer = timers.current.get(row.item.id)
          if (timer !== undefined) {
            window.clearTimeout(timer)
            timers.current.delete(row.item.id)
          }
          next.push({ item: fresh, leaving: false })
          continue
        }
        if (row.leaving) {
          next.push(row)
          continue
        }
        next.push({ item: row.item, leaving: true })
        timers.current.set(
          row.item.id,
          window.setTimeout(() => {
            timers.current.delete(row.item.id)
            setRows((shown) => shown.filter((entry) => entry.item.id !== row.item.id))
          }, LEAVE_MS),
        )
      }
      for (const item of incoming.values()) next.push({ item, leaving: false })
      return next
    })
  }, [toasts])

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer))
      timers.current.clear()
    },
    [],
  )

  if (rows.length === 0) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {rows.map(({ item, leaving }) => {
        const needed = item.meter?.needed ?? 0
        const seen = Math.min(needed, Math.max(0, item.meter?.seen ?? 0))
        const width = needed > 0 ? `${Math.round((seen / needed) * 100)}%` : "0%"
        return (
          <div key={item.id} className="toast" data-kind={item.kind} data-leaving={leaving ? "1" : "0"}>
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
        )
      })}
    </div>
  )
}
