import { join } from "node:path"
import * as z from "zod"
import { CHAINS, chainFromEnv, type ChainConfig, type ChainKey } from "../shared/chain"
import type { Assert, Equal } from "../shared/exact"
import { marketPreferences } from "../shared/market"
import { isNearAccountId } from "../shared/near"
import { seedFromSecret } from "../shared/nearKey"
import { activeChainKey } from "./activeChain"

/** Secrets and machine settings. Nothing here is hardcoded. */
export type Env = {
  treasuryPrivateKey: string
  nearTreasuryPrivateKey: string
  agentSecret: string
  rpcUrl: string
  usdcAddress: string
  tokenAccount: string
  dbPath: string
  port: number
  apiUrl: string
  swarmPin: number | null
  nodeEnv: string | undefined
}

type EnvSource = {
  TREASURY_PRIVATE_KEY?: string
  NEAR_TREASURY_PRIVATE_KEY?: string
  AGENT_SECRET?: string
  RPC_URL?: string
  USDC_ADDRESS?: string
  TOKEN_ACCOUNT?: string
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
const nearKeyMessage = "TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key"
const nearTreasuryMessage = "NEAR_TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key"

/** NEAR mode uses its own line. Blank is off. An EVM key is refused. */
export function parseNearTreasuryKey(value: unknown): string {
  const raw = unset(value)
  if (raw === undefined) return ""
  if (typeof raw !== "string" || !raw.startsWith("ed25519:") || !seedFromSecret(raw)) throw new Error(nearTreasuryMessage)
  return raw.trim()
}

/** EVM keys become `0x` + 64 hex. NEAR accepts an empty line or an `ed25519:` secret. */
export function parseTreasuryKey(value: unknown, chainKey: ChainKey = marketPreferences.chain): string {
  const raw = unset(value)
  if (raw === undefined) return ""
  if (typeof raw !== "string") return String(raw)
  if (chainKey !== "near-testnet") {
    const body = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw
    return `0x${body}`
  }
  if (raw.startsWith("0x") || raw.startsWith("0X") || !seedFromSecret(raw)) throw new Error(nearKeyMessage)
  return raw.trim()
}

export function parseTokenAccount(value: unknown): string {
  const raw = unset(value)
  if (raw === undefined) return ""
  if (typeof raw !== "string" || !isNearAccountId(raw)) throw new Error("TOKEN_ACCOUNT must be a NEAR account id")
  return raw
}

const treasuryKey = z.preprocess((value) => {
  const raw = unset(value)
  if (typeof raw === "string" && raw.startsWith("ed25519:")) return parseTreasuryKey(raw, "near-testnet")
  return parseTreasuryKey(value, "base-sepolia")
}, z.string().regex(/^$|^0x[0-9a-fA-F]{64}$|^ed25519:\S+$/, keyMessage))

const nearTreasuryKey = z.preprocess((value) => parseNearTreasuryKey(value), z.string())

const tokenAccount = z.preprocess((value) => parseTokenAccount(value), z.string())

const address = z.preprocess((value) => {
  const raw = unset(value)
  return raw === undefined ? "" : raw
}, z.string().regex(/^$|^0x[0-9a-fA-F]{40}$/, "USDC_ADDRESS must be a 20-byte hex address"))

const envSchema = z.object({
  treasuryPrivateKey: treasuryKey,
  nearTreasuryPrivateKey: nearTreasuryKey,
  agentSecret: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
  rpcUrl: z.preprocess((value) => {
    const raw = unset(value)
    return raw === undefined ? "" : raw
  }, z.string()),
  usdcAddress: address,
  tokenAccount,
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
    nearTreasuryPrivateKey: env.NEAR_TREASURY_PRIVATE_KEY,
    agentSecret: env.AGENT_SECRET,
    rpcUrl: env.RPC_URL,
    usdcAddress: env.USDC_ADDRESS,
    tokenAccount: env.TOKEN_ACCOUNT,
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

/** The chain inside `withChain`, or the process chain when no request is scoped. */
export function chainConfig(key: ChainKey = activeChainKey(), env: Env = loadEnv()): ChainConfig {
  return chainFromEnv(key, env.usdcAddress)
}

/** Prefer the NEAR line. A legacy ed25519 treasury key still works for a NEAR-only process. */
export function nearTreasurySecret(env: Env = loadEnv()): string {
  if (env.nearTreasuryPrivateKey) return env.nearTreasuryPrivateKey
  if (env.treasuryPrivateKey.startsWith("ed25519:")) return env.treasuryPrivateKey
  return ""
}

/** A market is on only when its keys are filled. `CHAIN` does not turn the other one off. */
export function enabledMarketKeys(env: Env = loadEnv()): ChainKey[] {
  const keys: ChainKey[] = []
  if (/^0x[0-9a-fA-F]{64}$/.test(env.treasuryPrivateKey) && /^0x[0-9a-fA-F]{40}$/.test(env.usdcAddress)) {
    keys.push("base-sepolia")
  }
  if (env.nearTreasuryPrivateKey.startsWith("ed25519:") && isNearAccountId(env.tokenAccount.trim())) keys.push("near-testnet")
  return keys
}

export function rpcFor(key: ChainKey, env: Env = loadEnv()): string {
  const custom = env.rpcUrl.trim()
  if (custom && key === "near-testnet" && custom.includes("near")) return custom
  if (custom && key !== "near-testnet" && !custom.includes("near")) return custom
  return CHAINS[key].rpc
}
