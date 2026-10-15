/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly CHAIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
