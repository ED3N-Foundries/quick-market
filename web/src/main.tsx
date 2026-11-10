import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { LanguageProvider } from "./i18n"
import { fetchRuntimeConfig, type RuntimeConfig } from "./runtimeConfig"
import { WalletProviders } from "./wallet"
import "./styles.css"

const screenStyle = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  padding: "24px",
  background: "#12141a",
  color: "#f3f0e8",
  fontFamily: "system-ui, sans-serif",
} as const

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
      <main style={screenStyle}>
        <div>
          <p>Could not load market configuration.</p>
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </div>
      </main>
    )
  }
  if (!runtime) return <main style={screenStyle}>Loading market configuration…</main>
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
