import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

const ENV_PATH = join(process.cwd(), ".env")
const EXAMPLE_PATH = join(process.cwd(), ".env.example")
const NAME = "TREASURY_PRIVATE_KEY"

export type TreasuryPlan =
  | { action: "write"; text: string; address: string }
  | { action: "keep"; address: string }
  | { action: "refuse"; address: string }
  | { action: "invalid" }

function normalizeKey(raw: string): `0x${string}` | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return null
  return hex as `0x${string}`
}

function firstValue(source: string): string {
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith(`${NAME}=`)) continue
    const value = line.slice(NAME.length + 1).trim()
    if (value) return value
  }
  return ""
}

function sameKey(left: string, right: string): boolean {
  const a = normalizeKey(left)
  const b = normalizeKey(right)
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
}

function fillTreasuryLine(source: string, key: `0x${string}`): string {
  const lines = source.split(/\r?\n/)
  let replaced = false
  const next = lines.map((line) => {
    if (replaced || !line.startsWith(`${NAME}=`)) return line
    if (line.slice(NAME.length + 1).trim() !== "") return line
    replaced = true
    return `${NAME}=${key}`
  })
  if (replaced) {
    const joined = next.join("\n")
    return joined.endsWith("\n") ? joined : `${joined}\n`
  }
  const body = source.length === 0 || source.endsWith("\n") ? source : `${source}\n`
  return `${body}${NAME}=${key}\n`
}

export function planTreasury(source: string, envKey: string | undefined, generated: `0x${string}`): TreasuryPlan {
  const fileRaw = firstValue(source)
  const envRaw = envKey?.trim() ?? ""
  if (envRaw && !sameKey(envRaw, fileRaw)) {
    const key = normalizeKey(envRaw)
    if (!key) return { action: "invalid" }
    return { action: "refuse", address: privateKeyToAccount(key).address }
  }
  if (fileRaw) {
    const key = normalizeKey(fileRaw)
    if (!key) return { action: "invalid" }
    return { action: "keep", address: privateKeyToAccount(key).address }
  }
  const key = normalizeKey(generated)
  if (!key) return { action: "invalid" }
  return { action: "write", text: fillTreasuryLine(source, key), address: privateKeyToAccount(key).address }
}

function loadSource(): string {
  if (existsSync(ENV_PATH)) return readFileSync(ENV_PATH, "utf8")
  if (existsSync(EXAMPLE_PATH)) return readFileSync(EXAMPLE_PATH, "utf8")
  return ""
}

function main() {
  const source = loadSource()
  const decision = planTreasury(source, process.env.TREASURY_PRIVATE_KEY, generatePrivateKey())
  if (decision.action === "invalid") {
    console.error("TREASURY_PRIVATE_KEY must be a 32-byte hex string")
    process.exit(1)
  }
  console.log(`treasury ${decision.address}`)
  if (decision.action === "write") {
    writeFileSync(ENV_PATH, decision.text, { mode: 0o600 })
    chmodSync(ENV_PATH, 0o600)
    console.log("wrote TREASURY_PRIVATE_KEY to .env")
  } else if (decision.action === "refuse") {
    console.log("TREASURY_PRIVATE_KEY is already set. .env was not changed.")
  }
  console.log("This address needs a little ETH for withdrawal gas.")
}

if (import.meta.main) main()
