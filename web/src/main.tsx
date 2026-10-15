import "@rainbow-me/rainbowkit/styles.css"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { WalletProviders } from "./wallet"
import "./styles.css"

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <WalletProviders>
      <App />
    </WalletProviders>,
  )
}
