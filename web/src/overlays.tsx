import { useEffect, useState } from "react"
import {
  chainBadgeText,
  chainNetworkLabel,
  formatGrantDollars,
  formatMoney,
  grantButtonLabel,
  grantNextLabel,
  grantSentence,
  grantTiming,
  parseAmountMicros,
  walletDisplayLabel,
} from "./format"
import { localize } from "./copy"
import { useI18n } from "./i18n"
import { ChainLogo } from "./logos"
import { TokenBadge } from "./App"
import { useSession } from "./wallet"

export function AddressWithHover({ address, label }: { address: string; label?: string | null }) {
  return (
    <span className="addr-hover" title={address}>
      <span>{walletDisplayLabel(address, label)}</span>
      <span className="addr-tip" role="tooltip">
        {address}
      </span>
    </span>
  )
}

export function briefTx(hash: string): string {
  return hash.length < 18 ? hash : `${hash.slice(0, 10)}…${hash.slice(-4)}`
}

export function FundOverlay({
  address,
  label,
  treasury,
  chainId,
  chainName,
  amount,
  disabled,
  customDisabled,
  blocked,
  notice = blocked,
  error,
  phase,
  hash,
  onAmount,
  onClose,
  onFund,
}: {
  address: string | null
  label: string | null
  treasury: string
  chainId: number
  chainName: string
  amount: string
  disabled: boolean
  customDisabled: boolean
  blocked: boolean
  notice?: boolean
  error: string | null
  phase: "idle" | "phantom" | "confirming" | "pending"
  hash: string | null
  onAmount: (amount: string) => void
  onClose: () => void
  onFund: (amount: string) => void
}) {
  const { lang, text } = useI18n()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label={text.depositUsdc} onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>{text.deposit}</h2>
            <TokenBadge kind="circle" />
            <span className="net-badge" data-testnet="0">
              <ChainLogo chainKey="base" className="chain-mark" />
              {chainBadgeText(chainId, chainName, lang)}
            </span>
          </div>
          <button type="button" className="overlay-close" aria-label={text.close} onClick={onClose}>
            {"×"}
          </button>
        </header>
        <dl className="overlay-meta">
          <div>
            <dt>{text.network}</dt>
            <dd>{chainNetworkLabel(chainId, chainName, lang)}</dd>
          </div>
          <div>
            <dt>{text.fromTo}</dt>
            <dd className="route-line">
              {address ? <AddressWithHover address={address} label={label} /> : <span>{text.wallet}</span>}
              <span className="route-arrow" aria-hidden="true">
                →
              </span>
              {treasury ? <AddressWithHover address={treasury} /> : <span>{text.treasury}</span>}
            </dd>
          </div>
        </dl>
        <div className="funds">
          <button type="button" onClick={() => onFund("10")} disabled={disabled}>
            +$10
          </button>
          <button type="button" onClick={() => onFund("1000")} disabled={disabled}>
            +$1,000
          </button>
        </div>
        <div className="fund-custom" data-busy={phase === "idle" ? "0" : "1"}>
          <input
            aria-label={text.fundAmount}
            inputMode="decimal"
            placeholder={text.customAmount}
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
            disabled={disabled}
          />
          <button type="button" className="primary" onClick={() => onFund(amount)} disabled={customDisabled}>
            {phase === "phantom" ? text.confirmPhantom : phase === "confirming" || phase === "pending" ? text.waitingConfirmations : text.deposit}
          </button>
        </div>
        {phase === "phantom" && <p className="note pending-note">{text.confirmPhantom}</p>}
        {phase === "confirming" && <p className="note pending-note">{text.waitingConfirmations}</p>}
        {phase === "pending" && (
          <p className="note pending-note" title={hash ?? undefined}>
            {text.ledgerWait(hash ? briefTx(hash) : "")}
          </p>
        )}
        {notice && (
          <p className="note warn" role="status">
            {text.reconnectingMarket} · {text.reconnectingHint}
          </p>
        )}
        {error && <p className="note bad">{localize(lang, error)}</p>}
      </div>
    </div>
  )
}

export function GrantOverlay({
  chainId,
  chainKey,
  chainName,
  grantMicros,
  grantIntervalMs,
  grantAt,
  now,
  granting,
  blocked,
  notice = blocked,
  error,
  onClose,
  onGrant,
}: {
  chainId: number
  chainKey: string
  chainName: string
  grantMicros: number
  grantIntervalMs: number
  grantAt: number | null
  now: number
  granting: boolean
  blocked: boolean
  notice?: boolean
  error: string | null
  onClose: () => void
  onGrant: () => void
}) {
  const { lang, text } = useI18n()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  const timing = grantTiming(grantAt, now, grantIntervalMs)
  const near = chainKey === "near-testnet"
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label={near ? text.grantNear : text.grantAria} onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>{text.grant}</h2>
            <TokenBadge kind="qm" chainKey={chainKey} />
            <span className="net-badge" data-testnet="1">
              <ChainLogo chainKey={chainKey} className="chain-mark" />
              {chainBadgeText(chainId, chainName, lang, chainKey as "base" | "base-sepolia" | "near-testnet")}
            </span>
          </div>
          <button type="button" className="overlay-close" aria-label={text.close} onClick={onClose}>
            {"×"}
          </button>
        </header>
        <p className="note grant-copy">{grantSentence(grantMicros, grantIntervalMs, lang, chainKey as "base" | "base-sepolia" | "near-testnet")}</p>
        <dl className="overlay-meta">
          <div>
            <dt>{text.amount}</dt>
            <dd>{formatGrantDollars(grantMicros)}</dd>
          </div>
          <div>
            <dt>{text.next}</dt>
            <dd>{grantNextLabel(timing, lang)}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="primary grant-submit"
          onClick={onGrant}
          disabled={granting || !timing.due || blocked}
          title={notice ? text.reconnectingMarket : undefined}
        >
          {granting ? text.granting : grantButtonLabel(timing, grantMicros, lang)}
        </button>
        {notice && (
          <p className="note warn" role="status">
            {text.reconnectingMarket} · {text.reconnectingHint}
          </p>
        )}
        {error && <p className="note bad">{localize(lang, error)}</p>}
      </div>
    </div>
  )
}

export function WithdrawOverlay({
  testnet,
  address,
  label,
  balanceMicros,
  chainId,
  chainKey,
  chainName,
  amount,
  pending,
  blocked,
  notice = blocked,
  error,
  onAmount,
  onMax,
  onClose,
  onSubmit,
}: {
  testnet: boolean
  address: string | null
  label: string | null
  balanceMicros: number
  chainId: number
  chainKey: string
  chainName: string
  amount: string
  pending: boolean
  blocked: boolean
  notice?: boolean
  error: string | null
  onAmount: (value: string) => void
  onMax: () => void
  onClose: () => void
  onSubmit: () => void
}) {
  const { lang, text } = useI18n()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  const parsed = parseAmountMicros(amount)
  const submitDisabled = pending || blocked || parsed === null || parsed > balanceMicros
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label={chainKey === "near-testnet" ? text.withdrawNear : testnet ? text.withdrawQm : text.withdrawUsdc} onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>{text.withdraw}</h2>
            <TokenBadge kind={testnet ? "qm" : "circle"} chainKey={chainKey} />
            <span className="net-badge" data-testnet={testnet ? "1" : "0"}>
              <ChainLogo chainKey={chainKey} className="chain-mark" />
              {chainBadgeText(chainId, chainName, lang, chainKey as "base" | "base-sepolia" | "near-testnet")}
            </span>
          </div>
          <button type="button" className="overlay-close" aria-label={text.close} onClick={onClose}>
            {"×"}
          </button>
        </header>
        <dl className="overlay-meta">
          <div>
            <dt>{text.toWallet}</dt>
            <dd>{address ? <AddressWithHover address={address} label={label} /> : "—"}</dd>
          </div>
          <div>
            <dt>{text.spendable}</dt>
            <dd>{formatMoney(balanceMicros)}</dd>
          </div>
        </dl>
        <div className="fund-custom">
          <div className="input-with-max">
            <input
              aria-label={text.withdrawAmount}
              inputMode="decimal"
              placeholder={text.amount}
              value={amount}
              onChange={(event) => onAmount(event.target.value)}
              disabled={pending || blocked}
            />
            <button type="button" className="max-btn" onClick={onMax} disabled={pending || blocked || balanceMicros <= 0}>
              {text.max}
            </button>
          </div>
          <button type="button" className="primary" onClick={onSubmit} disabled={submitDisabled}>
            {pending ? text.withdrawing : text.withdraw}
          </button>
        </div>
        {chainKey === "near-testnet" ? <p className="note">{text.paysNear}</p> : testnet ? <p className="note">{text.paysQm}</p> : null}
        {notice && (
          <p className="note warn" role="status">
            {text.reconnectingMarket} · {text.reconnectingHint}
          </p>
        )}
        {error && <p className="note bad">{localize(lang, error)}</p>}
      </div>
    </div>
  )
}

function connectorUrl(chainKey: string, token: string | null): string {
  const url = new URL("/mcp", window.location.origin)
  url.searchParams.set("chain", chainKey)
  if (token) url.searchParams.set("token", token)
  return url.toString()
}

export function AgentsOverlay({ chainKey, onClose }: { chainKey: string; onClose: () => void }) {
  const { text } = useI18n()
  const session = useSession()
  const token = session.pageChain?.key === chainKey && session.token ? session.token : null
  const [copied, setCopied] = useState<"url" | "token" | null>(null)
  const url = connectorUrl(chainKey, token)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  const copy = (value: string, which: "url" | "token") => {
    void navigator.clipboard.writeText(value).then(
      () => setCopied(which),
      () => setCopied(null),
    )
  }
  return (
    <div className="fund-back" onClick={onClose}>
      <div
        className="fund-overlay agents-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={text.agentsLabel}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="overlay-head">
          <h2>{text.agentsLabel}</h2>
          <button type="button" className="overlay-close" aria-label={text.close} onClick={onClose}>
            {"×"}
          </button>
        </header>
        <p>{text.agentsLine}</p>
        <div className="agents-url-row">
          <span className="agents-url-label">{text.agentsUrl}</span>
          <code className="agents-url">{url}</code>
          <button type="button" onClick={() => copy(url, "url")}>
            {copied === "url" ? text.agentsCopied : text.agentsCopy}
          </button>
        </div>
        {token ? (
          <>
            <div className="agents-url-row">
              <span className="agents-url-label">{text.agentsToken}</span>
              <code className="agents-url">{token}</code>
              <button type="button" onClick={() => copy(token, "token")}>
                {copied === "token" ? text.agentsCopied : text.agentsCopy}
              </button>
            </div>
            <p>{text.agentsTokenHint}</p>
          </>
        ) : (
          <p>{text.agentsTokenMissing}</p>
        )}
        <div className="agents-steps">
          <h3>{text.agentsGrokTitle}</h3>
          <p>
            <a href="https://grok.com/connectors" target="_blank" rel="noreferrer">
              grok.com/connectors
            </a>
            {". "}
            {text.agentsGrok}
          </p>
          <h3>{text.agentsClaudeTitle}</h3>
          <p>{text.agentsClaude}</p>
          <h3>{text.agentsOtherTitle}</h3>
          <p>{text.agentsOther}</p>
        </div>
        <p>{text.agentsTools}</p>
      </div>
    </div>
  )
}
