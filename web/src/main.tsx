import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { LanguageProvider } from "./i18n"
import { fetchRuntimeConfig, type RuntimeConfig } from "./runtimeConfig"
import { WalletProviders } from "./wallet"
import "./styles.css"

function BaseSquare({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="base-square"
      width={size}
      height={size}
      viewBox="0 0 1280 1280"
      role="img"
      aria-label="Base logo"
    >
      <path
        fill="#0000FF"
        d="M0,101.12c0-34.64,0-51.95,6.53-65.28,6.25-12.76,16.56-23.07,29.32-29.32C49.17,0,66.48,0,101.12,0h1077.76c34.63,0,51.96,0,65.28,6.53,12.75,6.25,23.06,16.56,29.32,29.32,6.52,13.32,6.52,30.64,6.52,65.28v1077.76c0,34.63,0,51.96-6.52,65.28-6.26,12.75-16.57,23.06-29.32,29.32-13.32,6.52-30.65,6.52-65.28,6.52H101.12c-34.64,0-51.95,0-65.28-6.52-12.76-6.26-23.07-16.57-29.32-29.32-6.53-13.32-6.53-30.65-6.53-65.28V101.12Z"
      />
    </svg>
  )
}

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
        <p className="splash-powered">
          <span>Powered by</span>
          <BaseSquare />
          <strong>Base</strong>
        </p>
      </div>
    </main>
  )
}

function Bootstrap() {
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancel = false
    setError(null)
    void fetchRuntimeConfig()
      .then((value) => {
        if (!cancel) setRuntime(value)
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
  if (!runtime)
    return <Splash copy="Warming up the market" />
  return (
    <WalletProviders chain={runtime.chain}>
      <App initialConfig={runtime.config} />
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
