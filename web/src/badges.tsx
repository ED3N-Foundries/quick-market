import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import type { ChainKey } from "../../shared/chain"
import { chainBadgeText, isTestnetChain } from "./format"
import { useI18n } from "./i18n"
import { ChainLogo } from "./logos"

/** Clickable pill. The explanation opens under the badge and closes on an outside click or Escape. */
export function TipBadge({
  className,
  tip,
  children,
  ...data
}: {
  className: string
  tip: string
  children: ReactNode
  "data-testnet"?: "0" | "1"
  "data-kind"?: string
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const tipId = useId()
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown, true)
    }
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    const node = tipRef.current
    if (!anchor || !node) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const box = node.getBoundingClientRect()
      const margin = 8
      let left = rect.left
      if (left + box.width > window.innerWidth - margin) left = window.innerWidth - margin - box.width
      if (left < margin) left = margin
      let top = rect.bottom + 6
      if (top + box.height > window.innerHeight - margin && rect.top - 6 - box.height >= margin) {
        top = rect.top - 6 - box.height
      }
      node.style.left = `${left}px`
      node.style.top = `${top}px`
      node.style.visibility = "visible"
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open, tip])
  return (
    <span
      className="tip-anchor"
      ref={anchorRef}
      data-open={open ? "1" : "0"}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={className}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        data-testnet={data["data-testnet"]}
        data-kind={data["data-kind"]}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
      </button>
      {open && (
        <span ref={tipRef} id={tipId} className="badge-tip" role="tooltip">
          {tip}
        </span>
      )}
    </span>
  )
}

function asChainKey(chainKey: string): ChainKey | undefined {
  if (chainKey === "base" || chainKey === "base-sepolia" || chainKey === "near-testnet") return chainKey
  return undefined
}

/** Network pill. Testnets open an explanation. Mainnet stays a static pill of the same size. */
export function ChainBadge({
  chainId,
  chainKey,
  chainName,
  label,
}: {
  chainId: number
  chainKey: string
  chainName: string
  label?: string
}) {
  const { lang, text } = useI18n()
  const key = asChainKey(chainKey)
  const testnet = isTestnetChain(chainId, key)
  const shown = label ?? chainBadgeText(chainId, chainName, lang, key)
  const inner = (
    <>
      <ChainLogo chainKey={chainKey} className="chain-mark" />
      {shown}
    </>
  )
  if (!testnet) {
    return (
      <span className="net-badge" data-testnet="0">
        {inner}
      </span>
    )
  }
  return (
    <TipBadge className="net-badge" tip={key === "near-testnet" ? text.testnetTipNear : text.testnetTipBase} data-testnet="1">
      {inner}
    </TipBadge>
  )
}
