import { useCallback, useEffect, useRef, useState } from "react"

export type ToastKind = "progress" | "ok" | "error"

export type ToastItem = {
  id: string
  kind: ToastKind
  text: string
  txHash?: string | null
  txUrl?: string | null
}

const TOAST_MS = 7000

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
      if (
        items[at]?.kind === item.kind &&
        items[at]?.text === item.text &&
        items[at]?.txHash === item.txHash &&
        items[at]?.txUrl === item.txUrl
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

export function ToastStack({ toasts, onClose }: { toasts: ToastItem[]; onClose: (id: string) => void }) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-kind={toast.kind}>
          {toast.kind === "progress" ? (
            <span className="wait-spin" aria-hidden="true" />
          ) : (
            <span className="toast-dot" data-kind={toast.kind} aria-hidden="true" />
          )}
          <span className="toast-body">
            <span className="toast-text">{toast.text}</span>
            {toast.txHash &&
              (toast.txUrl ? (
                <a className="toast-tx" href={toast.txUrl} target="_blank" rel="noreferrer" title={toast.txHash}>
                  {briefHash(toast.txHash)}
                </a>
              ) : (
                <span className="toast-tx" title={toast.txHash}>
                  {briefHash(toast.txHash)}
                </span>
              ))}
          </span>
          <button type="button" className="plain toast-close" aria-label="Close" onClick={() => onClose(toast.id)}>
            {"×"}
          </button>
        </div>
      ))}
    </div>
  )
}
