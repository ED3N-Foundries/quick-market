/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly CHAIN?: string
  readonly WALLETCONNECT_PROJECT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
