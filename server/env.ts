import { join } from "node:path"
import * as z from "zod"
import { chainFromEnv, type ChainConfig } from "../shared/chain"
import type { Assert, Equal } from "../shared/exact"
import { marketPreferences } from "../shared/market"

/** Secrets and machine settings. Nothing here is hardcoded. */
export type Env = {
  treasuryPrivateKey: string
  agentSecret: string
  rpcUrl: string
  usdcAddress: string
  dbPath: string
  port: number
  apiUrl: string
  swarmPin: number | null
  nodeEnv: string | undefined
}

type EnvSource = {
  TREASURY_PRIVATE_KEY?: string
  AGENT_SECRET?: string
  RPC_URL?: string
  USDC_ADDRESS?: string
  DB_PATH?: string
  PORT?: string
  API_URL?: string
  SWARM_PIN?: string
  NODE_ENV?: string
}

function unset(value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

const keyMessage = "TREASURY_PRIVATE_KEY must be a 32-byte hex string"

const treasuryKey = z.preprocess((value) => {
  const raw = unset(value)
  if (raw === undefined) return ""
  if (typeof raw !== "string") return raw
  const body = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw
  return `0x${body}`
}, z.string().regex(/^$|^0x[0-9a-fA-F]{64}$/, keyMessage))

const address = z.preprocess((value) => {
  const raw = unset(value)
  return raw === undefined ? "" : raw
}, z.string().regex(/^$|^0x[0-9a-fA-F]{40}$/, "USDC_ADDRESS must be a 20-byte hex address"))

const envSchema = z.object({
  treasuryPrivateKey: treasuryKey,
  agentSecret: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
  rpcUrl: z.preprocess((value) => {
    const raw = unset(value)
    return raw === undefined ? "" : raw
  }, z.string()),
  usdcAddress: address,
  dbPath: z.preprocess((value) => {
    const raw = unset(value)
    return raw === undefined ? join(process.cwd(), "data", "quick-market.sqlite") : raw
  }, z.string().min(1)),
  port: z.preprocess((value) => {
    const raw = unset(value)
    return raw === undefined ? 3001 : raw
  }, z.coerce.number().int().min(1).max(65535)),
  apiUrl: z.preprocess((value) => {
    const raw = unset(value)
    return raw === undefined ? "http://127.0.0.1:3001" : raw
  }, z.string().min(1)),
  swarmPin: z.preprocess(unset, z.coerce.number().optional()).transform((value) => value ?? null),
  nodeEnv: z.preprocess((value) => {
    const raw = unset(value)
    return typeof raw === "string" ? raw : undefined
  }, z.union([z.string(), z.undefined()])),
})

type _env = Assert<Equal<z.infer<typeof envSchema>, Env>>

/** Read secrets and deployment settings from the environment on each call. */
export function loadEnv(env: EnvSource = process.env): Env {
  return envSchema.parse({
    treasuryPrivateKey: env.TREASURY_PRIVATE_KEY,
    agentSecret: env.AGENT_SECRET,
    rpcUrl: env.RPC_URL,
    usdcAddress: env.USDC_ADDRESS,
    dbPath: env.DB_PATH,
    port: env.PORT,
    apiUrl: env.API_URL,
    swarmPin: env.SWARM_PIN,
    nodeEnv: env.NODE_ENV,
  })
}

export function configuredChain(env: EnvSource = process.env): ChainConfig {
  return chainFromEnv(marketPreferences.chain, loadEnv(env).usdcAddress)
}
