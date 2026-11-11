import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { LanguageProvider } from "./i18n"
import { chosenMarket, fetchMarkets, MARKET_STORAGE_KEY, runtimeChain, type MarketsPayload } from "./runtimeConfig"
import type { ChainKey } from "../../shared/chain"
import { WalletProviders } from "./wallet"
import "./styles.css"

function Splash({
  copy,
  detail,
  retry,
}: {
  copy: string
  detail?: string | null
  retry?: () => void
}) {
  return (
    <main
      className="splash"
      data-state={retry ? "error" : "loading"}
      role="status"
      aria-live="polite"
      aria-label="Loading Quick Market"
    >
      <div className="splash-card">
        <div className="splash-brand">
          <span className="splash-mark" aria-hidden="true">
            😭
          </span>
          <span className="splash-word">Quick Market</span>
        </div>
        <div className="splash-spinner" aria-hidden="true">
          <span className="splash-track" />
          <span className="splash-ring" />
          <span className="splash-orbit" />
          <span className="splash-core">◆</span>
        </div>
        <div className="splash-text">
          <p className="splash-copy">
            {copy}
            <span className="splash-dots" aria-hidden="true">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </p>
          {detail && <p className="splash-detail">{detail}</p>}
        </div>
        {retry ? (
          <button type="button" className="splash-retry" onClick={retry}>
            Retry
          </button>
        ) : null}
      </div>
    </main>
  )
}

function readStoredMarket(): string | null {
  try {
    return localStorage.getItem(MARKET_STORAGE_KEY)
  } catch {
    return null
  }
}

function Bootstrap() {
  const [payload, setPayload] = useState<MarketsPayload | null>(null)
  const [chainKey, setChainKey] = useState<ChainKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancel = false
    setError(null)
    void fetchMarkets()
      .then((value) => {
        if (cancel) return
        const chosen = chosenMarket(value.markets, readStoredMarket(), value.defaultChainKey)
        setPayload(value)
        setChainKey(chosen?.chainKey ?? null)
      })
      .catch((reason: unknown) => {
        if (!cancel) setError(reason instanceof Error ? reason.message : "Could not load market configuration.")
      })
    return () => {
      cancel = true
    }
  }, [attempt])

  if (error) {
    return (
      <Splash
        copy="Could not load the market"
        detail={error}
        retry={() => setAttempt((value) => value + 1)}
      />
    )
  }
  const config = payload?.markets.find((market) => market.chainKey === chainKey) ?? null
  if (!payload || !config) return <Splash copy="Warming up the market" />
  let chain
  try {
    chain = runtimeChain(config)
  } catch (reason) {
    return (
      <Splash
        copy="Could not load the market"
        detail={reason instanceof Error ? reason.message : "Could not load market configuration."}
        retry={() => setAttempt((value) => value + 1)}
      />
    )
  }
  const select = (key: ChainKey) => {
    try {
      localStorage.setItem(MARKET_STORAGE_KEY, key)
    } catch {
      // The choice still applies for this page.
    }
    setChainKey(key)
  }
  return (
    <WalletProviders key={chain.key} chain={chain}>
      <App initialConfig={config} markets={payload.markets} onMarket={select} />
    </WalletProviders>
  )
}

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <LanguageProvider>
      <Bootstrap />
    </LanguageProvider>,
  )
}
