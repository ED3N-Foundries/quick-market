/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly CHAIN?: string
  readonly USDC_ADDRESS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
