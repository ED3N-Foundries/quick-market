import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ChainKey } from "../shared/chain.ts"

export type EnvValues = Record<string, string>

const DEFAULTS: Record<ChainKey, EnvValues> = {
  "near-testnet": {
    RPC_URL: "",
    TOKEN_ACCOUNT: "",
    TOKEN_PRIVATE_KEY: "",
    TREASURY_PRIVATE_KEY: "",
  },
  "base-sepolia": {
    RPC_URL: "",
    USDC_ADDRESS: "",
    TREASURY_PRIVATE_KEY: "",
  },
  base: {
    RPC_URL: "",
    TREASURY_PRIVATE_KEY: "",
  },
}

const SHARED_DEFAULTS: EnvValues = {
  DB_PATH: "data/quick-market.sqlite",
  PORT: "3001",
  API_URL: "http://127.0.0.1:3001",
  WINDOW_SECONDS: "10",
  MARKET_SECONDS: "10",
  VIEW_SECONDS: "5",
  FEE_BPS: "0",
  PRICE_SOURCE: "binance",
  GRANT_MICROS: "100000000",
  GRANT_INTERVAL_MS: "120000",
}

export function envFilePath(chain: ChainKey, root = process.cwd()): string {
  return join(root, `.env.${chain}`)
}

export function parseEnvText(source: string): EnvValues {
  const values: EnvValues = {}
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]!.trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }
    values[match[1]!] = value
  }
  return values
}

function readValues(path: string): EnvValues {
  return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {}
}

function validChain(value: string | undefined): ChainKey | null {
  return value === "base" || value === "base-sepolia" || value === "near-testnet" ? value : null
}

export function selectedChain(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): ChainKey {
  const explicit = validChain(env.CHAIN?.trim())
  if (explicit) return explicit
  const fromFile = validChain(readValues(join(root, ".env")).CHAIN?.trim())
  return fromFile ?? "near-testnet"
}

export function requiredEnvDefaults(chain: ChainKey): EnvValues {
  return { ...SHARED_DEFAULTS, ...DEFAULTS[chain] }
}

export function fillEnvDefaults(source: string, chain: ChainKey): { text: string; changed: boolean } {
  const required = requiredEnvDefaults(chain)
  const lines = source.length === 0 ? [] : source.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
  const seen = new Set<string>()
  const next = lines.map((line) => {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim())
    if (!match) return line
    const key = match[1]!
    seen.add(key)
    if (!(key in required) || line.split("=").slice(1).join("=").trim() !== "") return line
    return `${key}=${required[key]}`
  })
  for (const [key, value] of Object.entries(required)) {
    if (seen.has(key)) continue
    next.push(`${key}=${value}`)
  }
  const text = `${next.join("\n")}\n`
  return { text, changed: text !== source }
}

export function ensureEnvFile(chain: ChainKey, root = process.cwd()): string {
  const path = envFilePath(chain, root)
  const source = existsSync(path) ? readFileSync(path, "utf8") : ""
  const filled = fillEnvDefaults(source, chain)
  if (filled.changed) {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, filled.text, { mode: 0o600 })
    renameSync(tmp, path)
  }
  chmodSync(path, 0o600)
  return path
}

export function migrateRootEnv(root = process.cwd()): void {
  const path = join(root, ".env")
  const source = existsSync(path) ? readFileSync(path, "utf8") : ""
  const values = parseEnvText(source)
  if (values.ENV_FILES_VERSION === "1") return
  const lines = source.length === 0 ? [] : source.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
  let replaced = false
  const next = lines.map((line) => {
    if (!/^CHAIN=/.test(line.trim())) return line
    replaced = true
    return "CHAIN=near-testnet"
  })
  if (!replaced) next.push("CHAIN=near-testnet")
  next.push("ENV_FILES_VERSION=1")
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${next.join("\n")}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
  if (process.env.CHAIN === undefined || process.env.CHAIN === values.CHAIN) process.env.CHAIN = "near-testnet"
}

let loadedFileValues: EnvValues = {}

function compatibleTreasury(chain: ChainKey, value: string): boolean {
  return chain === "near-testnet" ? value.startsWith("ed25519:") : !value.startsWith("ed25519:")
}

export function bootstrapChainEnv(root = process.cwd()): ChainKey {
  migrateRootEnv(root)
  const chain = selectedChain(process.env, root)
  const legacy = readValues(join(root, ".env"))
  for (const [key, value] of Object.entries(legacy)) {
    if (key === "TREASURY_PRIVATE_KEY" && value && !compatibleTreasury(chain, value)) continue
    if (process.env[key] === undefined) process.env[key] = value
  }
  const selected = readValues(ensureEnvFile(chain, root))
  for (const [key, value] of Object.entries(selected)) {
    const current = process.env[key]
    const explicit = current !== undefined && current !== legacy[key] && current !== loadedFileValues[key]
    if (!explicit) {
      if (value === "" && legacy[key] && (key !== "TREASURY_PRIVATE_KEY" || compatibleTreasury(chain, legacy[key]))) continue
      process.env[key] = value
    }
  }
  loadedFileValues = selected
  process.env.CHAIN = chain
  return chain
}
