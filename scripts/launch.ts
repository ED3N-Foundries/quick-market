import { bootstrapChainEnv } from "../server/envFile"

const targets = {
  dev: "../server/dev.ts",
  server: "../server/index.ts",
  agent: "../agent/index.ts",
  agents: "../agent/dashboard.ts",
  feeds: "../server/dashboard.ts",
  treasury: "./treasury.ts",
  token: "./token.ts",
} as const

type Target = keyof typeof targets

const requested = process.argv[2] as Target
if (!(requested in targets)) throw new Error(`Unknown launch target "${requested}"`)
bootstrapChainEnv()
await import(targets[requested])
