import { useEffect, useRef } from "react"
import { briefGrantLine } from "./format"
import { useI18n } from "./i18n"

export function TestnetBrief({
  chainName,
  tokenLabel,
  grantMicros,
  grantIntervalMs,
  onDismiss,
}: {
  chainName: string
  tokenLabel: string
  grantMicros: number
  grantIntervalMs: number
  onDismiss: () => void
}) {
  const { lang, text } = useI18n()
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    buttonRef.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onDismiss])
  return (
    <div className="brief-back">
      <div className="brief" role="dialog" aria-modal="true" aria-labelledby="testnet-brief-title">
        <div className="brief-head">
          <p className="net-badge" data-testnet="1">
            {text.briefKicker}
          </p>
          <h2 id="testnet-brief-title">{chainName}</h2>
        </div>
        <div className="brief-copy">
          <p>{text.briefSignIn}</p>
          <p>{text.briefTrades(tokenLabel)}</p>
          <p>{text.briefWallet}</p>
          <p>{briefGrantLine(grantMicros, grantIntervalMs, lang)}</p>
        </div>
        <button type="button" className="primary" ref={buttonRef} onClick={onDismiss}>
          {text.briefContinue}
        </button>
      </div>
    </div>
  )
}
