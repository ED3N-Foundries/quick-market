import { createRoot } from "react-dom/client"
import { App } from "./App"
import { LanguageProvider } from "./i18n"
import { WalletProviders } from "./wallet"
import "./styles.css"

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <LanguageProvider>
      <WalletProviders>
        <App />
      </WalletProviders>
    </LanguageProvider>,
  )
}
