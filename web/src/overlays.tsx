import { useEffect, useRef, useState } from "react"
import {
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
import { agentConnectors, agentSetupText, connectorLinkLabel, connectorSessionToken } from "./agentsUrl"
import { ClaudeLogo, GrokLogo, OpenAiLogo } from "./logos"
import { TokenBadge } from "./App"
import { ChainBadge } from "./badges"
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
  confirmations,
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
  confirmations: number
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
            <ChainBadge chainId={chainId} chainKey="base" chainName={chainName} />
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
            {phase === "phantom" ? text.confirmPhantom : phase === "confirming" || phase === "pending" ? text.waitingConfirmations(confirmations) : text.deposit}
          </button>
        </div>
        {phase === "phantom" && <p className="note pending-note">{text.confirmPhantom}</p>}
        {phase === "confirming" && <p className="note pending-note">{text.waitingConfirmations(confirmations)}</p>}
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
  cooling = false,
  coolingWait = "",
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
  cooling?: boolean
  coolingWait?: string
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
  const coolingActive = cooling && near
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label={near ? text.grantNear : text.grantAria} onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>{text.grant}</h2>
            <TokenBadge kind="qm" chainKey={chainKey} />
            <ChainBadge chainId={chainId} chainKey={chainKey} chainName={chainName} />
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
          disabled={granting || !timing.due || blocked || coolingActive}
          aria-disabled={granting || !timing.due || blocked || coolingActive}
          title={coolingActive ? `${text.nearPaused} ${text.nearRetry(coolingWait)}` : notice ? text.reconnectingMarket : undefined}
        >
          {granting ? text.granting : grantButtonLabel(timing, grantMicros, lang)}
        </button>
        {coolingActive && (
          <p className="note warn" role="status">
            {text.nearPaused} {text.nearRetry(coolingWait)} {text.nearContinues}
          </p>
        )}
        {notice && !coolingActive && (
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
  cooling = false,
  coolingWait = "",
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
  cooling?: boolean
  coolingWait?: string
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
  const coolingActive = cooling && chainKey === "near-testnet"
  const submitDisabled = pending || blocked || coolingActive || parsed === null || parsed > balanceMicros
  return (
    <div className="fund-back" onClick={onClose}>
      <div className="fund-overlay" role="dialog" aria-modal="true" aria-label={chainKey === "near-testnet" ? text.withdrawNear : testnet ? text.withdrawQm : text.withdrawUsdc} onClick={(event) => event.stopPropagation()}>
        <header className="overlay-head">
          <div>
            <h2>{text.withdraw}</h2>
            <TokenBadge kind={testnet ? "qm" : "circle"} chainKey={chainKey} />
            <ChainBadge chainId={chainId} chainKey={chainKey} chainName={chainName} />
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
            <span className="amount-prefix" aria-hidden="true">$</span>
            <input
              aria-label={text.withdrawAmount}
              inputMode="decimal"
              placeholder={text.amount}
              value={amount}
              onChange={(event) => onAmount(event.target.value)}
              disabled={pending || blocked || coolingActive}
            />
            <button type="button" className="max-btn" onClick={onMax} disabled={pending || blocked || coolingActive || balanceMicros <= 0}>
              {text.max}
            </button>
          </div>
          <button
            type="button"
            className="primary"
            onClick={onSubmit}
            disabled={submitDisabled}
            aria-disabled={submitDisabled}
            title={coolingActive ? `${text.nearPaused} ${text.nearRetry(coolingWait)}` : undefined}
          >
            {pending ? text.withdrawing : text.withdraw}
          </button>
        </div>
        {chainKey === "near-testnet" ? <p className="note">{text.paysNear}</p> : testnet ? <p className="note">{text.paysQm}</p> : null}
        {coolingActive && (
          <p className="note warn" role="status">
            {text.nearPaused} {text.nearRetry(coolingWait)} {text.nearContinues}
          </p>
        )}
        {notice && !coolingActive && (
          <p className="note warn" role="status">
            {text.reconnectingMarket} · {text.reconnectingHint}
          </p>
        )}
        {error && <p className="note bad">{localize(lang, error)}</p>}
      </div>
    </div>
  )
}

const agentClients = [
  { Logo: GrokLogo, name: "Grok", href: "https://grok.com/connectors", label: "grok.com/connectors", text: "agentsGrok" },
  { Logo: ClaudeLogo, name: "Claude", href: null, label: null, text: "agentsClaude" },
  { Logo: OpenAiLogo, name: "ChatGPT", href: "https://chatgpt.com/plugins", label: "chatgpt.com/plugins", text: "agentsChat" },
] as const

function selectContents(node: HTMLElement | null) {
  if (!node) return
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
    node.focus()
    node.select()
    return
  }
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  selection.addRange(range)
}

export function AgentsPanel({ chainKey }: { chainKey: string }) {
  const { text } = useI18n()
  const session = useSession()
  const pageToken = session.pageChain?.key === chainKey ? session.token : null
  const markets = agentConnectors(window.location.origin, { chainKey, token: pageToken })
  const [copied, setCopied] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const fields = useRef(new Map<string, HTMLElement>())
  const copy = (value: string, which: string) => {
    const done = () => {
      setCopied(which)
      setFailed(null)
    }
    const missed = () => {
      setCopied(null)
      setFailed(which)
      selectContents(fields.current.get(which) ?? null)
    }
    if (!navigator.clipboard?.writeText) {
      missed()
      return
    }
    void navigator.clipboard.writeText(value).then(done, missed)
  }
  const labelFor = (key: string) => (key === "near-testnet" ? text.chainNearNetwork : text.chainTestnetNetwork)
  const paste = agentSetupText(
    text.agentsSetupAsk,
    markets.map(({ chainKey: key, url }) => ({ label: labelFor(key), url })),
  )
  return (
    <div className="agents-panel">
      <p className="agents-paste-lead">{text.agentsPasteLead}</p>
      <div className="agents-card agents-paste-card">
        <div className="agents-card-head">
          <span className="agents-url-label">{text.agentsPasteLabel}</span>
          <button type="button" className="primary" onClick={() => copy(paste, "paste")}>
            {copied === "paste" ? text.agentsCopied : text.agentsCopy}
          </button>
        </div>
        <textarea
          className="agents-paste"
          readOnly
          spellCheck={false}
          rows={Math.min(18, Math.max(8, paste.split("\n").length + 3))}
          aria-label={text.agentsPasteLabel}
          value={paste}
          ref={(node) => {
            if (node) fields.current.set("paste", node)
            else fields.current.delete("paste")
          }}
        />
        {failed === "paste" ? <p className="note bad">{text.agentsCopyFailed}</p> : null}
      </div>
      <details className="agents-manual">
        <summary>{text.agentsManual}</summary>
        <div className="agents-manual-body">
          <p>{text.agentsIntro}</p>
          {markets.map(({ chainKey: key, url }) => {
            const token = connectorSessionToken(url)
            return (
              <div key={key} className="agents-card">
                <div className="agents-card-head">
                  <span className="agents-url-label">{labelFor(key)}</span>
                  <button type="button" onClick={() => copy(url, key)}>
                    {copied === key ? text.agentsCopied : text.agentsCopy}
                  </button>
                </div>
                <code className="agents-link" title={url}>
                  {connectorLinkLabel(url)}
                </code>
                {token ? (
                  <div className="agents-token">
                    <span className="agents-url-label">{text.agentsToken}</span>
                    <code
                      className="agents-token-value"
                      tabIndex={0}
                      ref={(node) => {
                        if (node) fields.current.set(key, node)
                        else fields.current.delete(key)
                      }}
                      onClick={(event) => selectContents(event.currentTarget)}
                      onFocus={(event) => selectContents(event.currentTarget)}
                    >
                      {token}
                    </code>
                  </div>
                ) : null}
                {failed === key ? <p className="note bad">{text.agentsCopyFailed}</p> : null}
              </div>
            )
          })}
          <div className="agents-card">
            <div className="agents-card-head">
              <span className="agents-url-label">{text.agentsPromptLabel}</span>
              <button type="button" onClick={() => copy(text.agentsPrompt, "prompt")}>
                {copied === "prompt" ? text.agentsCopied : text.agentsCopy}
              </button>
            </div>
            <p
              className="agents-prompt-text"
              ref={(node) => {
                if (node) fields.current.set("prompt", node)
                else fields.current.delete("prompt")
              }}
            >
              {text.agentsPrompt}
            </p>
            {failed === "prompt" ? <p className="note bad">{text.agentsCopyFailed}</p> : null}
          </div>
          <div className="agents-steps">
            <span className="agents-url-label">{text.agentsGetStarted}</span>
            {agentClients.map((client) => (
              <div key={client.name} className="agents-client">
                <client.Logo />
                <p>
                  <strong>{client.name}. </strong>
                  {client.href && client.label ? (
                    <>
                      <a href={client.href} target="_blank" rel="noreferrer">
                        {client.label}
                      </a>
                      {". "}
                    </>
                  ) : null}
                  {text[client.text]}
                </p>
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  )
}
