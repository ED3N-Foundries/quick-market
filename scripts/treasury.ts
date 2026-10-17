import { Database } from "bun:sqlite"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, http, parseAbiItem, type Address } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { base, baseSepolia } from "viem/chains"
import { CHAINS, chainFromEnv, type ChainConfig, type ChainKey } from "../shared/chain"
import { loadMarket, marketPreferences } from "../shared/market"
import { usdcAbi } from "../shared/usdc"
import { loadEnv } from "../server/env"

const ENV_PATH = join(process.cwd(), ".env")
const EXAMPLE_PATH = join(process.cwd(), ".env.example")
const NAME = "TREASURY_PRIVATE_KEY"
const GAS_FLOOR = 50_000_000_000_000n
const HISTORY_LOOKBACK = 10_000n
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")

const EXPLORERS: Record<ChainKey, { api: string; site: string }> = {
  base: { api: "https://base.blockscout.com", site: "https://base.blockscout.com" },
  "base-sepolia": { api: "https://base-sepolia.blockscout.com", site: "https://base-sepolia.blockscout.com" },
}

// Publicnode serves this span. Wider filtered eth_getLogs calls ask for an archive token.
const HISTORY_RPC: Record<ChainKey, string> = {
  base: "https://base-rpc.publicnode.com",
  "base-sepolia": "https://base-sepolia-rpc.publicnode.com",
}

export type TreasuryPlan =
  | { action: "write"; text: string; address: string }
  | { action: "keep"; address: string }
  | { action: "refuse"; address: string }
  | { action: "invalid" }

export type ChainFunds = {
  key: ChainKey
  name: string
  id: number
  configured: boolean
  rpc: string
  usdc: string
  block: bigint | null
  blockTimeMs: number | null
  ethWei: bigint | null
  usdcMicros: bigint | null
  sentTxs: number | null
  error: string | null
  ethError: string | null
  usdcError: string | null
}

export type Movement = {
  chainName: string
  timeMs: number | null
  block: bigint | null
  hash: string
  usdcMicros: bigint
  ethWei: bigint
  parties: string[]
  ok: boolean
  label: string | null
}

export type BookEntry = {
  direction: "in" | "out"
  kind: "deposit" | "withdraw"
  address: string
  amountMicros: number
  txHash: string | null
  status: string
  createdAt: number
}

export type LedgerSnapshot = {
  path: string
  spendableMicros: number
  openStakeMicros: number
  pendingMicros: number
  pendingCount: number
  users: number
  deposits: number
  withdrawals: number
  entries: BookEntry[]
}

export type LedgerView = LedgerSnapshot | { path: string; missing: true } | { path: string; error: string }

export type UsdcLog = {
  block: bigint
  hash: string
  from: string
  to: string
  amount: bigint
  timeMs: number | null
}

export type TreasuryReport = {
  address: string
  configured: ChainConfig
  rpc: string
  chains: ChainFunds[]
  ledger: LedgerView
  movements: Movement[]
  historyNotes: string[]
}

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

export function rpcFor(chain: ChainConfig, configuredKey: ChainKey, override: string | undefined): string {
  const custom = override?.trim() ?? ""
  if (chain.key === configuredKey && custom) return custom
  return chain.rpc
}

function loadSource(): string {
  if (existsSync(ENV_PATH)) return readFileSync(ENV_PATH, "utf8")
  if (existsSync(EXAMPLE_PATH)) return readFileSync(EXAMPLE_PATH, "utf8")
  return ""
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length)
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

function group(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export function formatUsd(micros: bigint): string {
  const neg = micros < 0n
  const amount = abs(micros)
  const whole = amount / 1_000_000n
  const frac = (amount % 1_000_000n).toString().padStart(6, "0")
  const dust = frac.slice(2).replace(/0+$/, "")
  const digits = dust ? `${frac.slice(0, 2)}${dust}` : frac.slice(0, 2)
  const body = `${group(whole)}.${digits}`
  return neg ? `-$${body}` : `$${body}`
}

export function formatEth(wei: bigint): string {
  const neg = wei < 0n
  const amount = abs(wei)
  const whole = amount / 10n ** 18n
  let frac = (amount % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "")
  if (frac.length > 8 && /^0*$/.test(frac.slice(8))) frac = frac.slice(0, 8).replace(/0+$/, "")
  const text = `${group(whole)}.${frac || "0"}`
  return neg && amount !== 0n ? `-${text}` : text
}

function formatToken(micros: bigint): string {
  return formatUsd(abs(micros)).slice(1)
}

function formatStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}Z`
}

function shortAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, " ").trim().slice(0, 180)
}

function displayPath(path: string): string {
  const prefix = `${process.cwd()}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function asNumber(value: unknown): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ledger total does not fit")
    return Number(value)
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  throw new Error("ledger total is not an integer")
}

function addressOf(value: unknown): string | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value
  if (!value || typeof value !== "object") return null
  const hash = (value as { hash?: unknown }).hash
  if (typeof hash === "string" && /^0x[0-9a-fA-F]{40}$/.test(hash)) return hash
  return null
}

function parseWei(value: unknown): bigint | null {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value !== "string") return null
  const text = value.trim()
  if (/^0x[0-9a-fA-F]+$/.test(text)) return BigInt(text)
  if (/^\d+$/.test(text)) return BigInt(text)
  return null
}

function parseBlock(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= 0n) return value
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value)
  return null
}

function timeMsOf(value: unknown): number | null {
  if (typeof value !== "string") return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function itemsOf(payload: unknown): Record<string, unknown>[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)
      ? (payload as { items: unknown[] }).items
      : []
  return list.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
}

function tokenAddress(token: unknown): string | null {
  if (!token || typeof token !== "object") return null
  const raw = (token as { address_hash?: unknown; address?: unknown }).address_hash ?? (token as { address?: unknown }).address
  return typeof raw === "string" && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null
}

function decimalsOf(item: Record<string, unknown>): number | null {
  const total = item.total
  const token = item.token
  const raw =
    total && typeof total === "object" && "decimals" in total
      ? (total as { decimals?: unknown }).decimals
      : token && typeof token === "object" && "decimals" in token
        ? (token as { decimals?: unknown }).decimals
        : null
  if (typeof raw === "number" && Number.isInteger(raw)) return raw
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw)
  return null
}

function tokenAmount(item: Record<string, unknown>): bigint | null {
  const total = item.total
  if (typeof total === "string" || typeof total === "number" || typeof total === "bigint") return parseWei(total)
  if (total && typeof total === "object" && "value" in total) return parseWei((total as { value?: unknown }).value)
  return null
}

function addParty(parties: string[], seen: Set<string>, value: string | null) {
  if (!value) return
  const key = value.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  parties.push(value)
}

function netUsdc(treasury: string, legs: { from: string | null; to: string | null; amount: bigint }[]) {
  const mine = treasury.toLowerCase()
  let micros = 0n
  const parties: string[] = []
  const seen = new Set<string>()
  for (const leg of legs) {
    const from = leg.from?.toLowerCase() ?? ""
    const to = leg.to?.toLowerCase() ?? ""
    if (to === mine && from !== mine) {
      micros += leg.amount
      addParty(parties, seen, leg.from)
    } else if (from === mine && to !== mine) {
      micros -= leg.amount
      addParty(parties, seen, leg.to)
    }
  }
  return { micros, parties }
}

function signedEth(treasury: string, from: string | null, to: string | null, value: bigint) {
  if (value === 0n) return { wei: 0n, party: null as string | null }
  const mine = treasury.toLowerCase()
  if (to?.toLowerCase() === mine && from?.toLowerCase() !== mine) return { wei: value, party: from }
  if (from?.toLowerCase() === mine && to?.toLowerCase() !== mine) return { wei: -value, party: to }
  return { wei: 0n, party: null }
}

function way(row: Movement): "in" | "out" | "mix" {
  const incoming = [row.usdcMicros, row.ethWei].filter((value) => value !== 0n).map((value) => value > 0n)
  if (incoming.length === 0 || incoming.every((value) => !value)) return "out"
  if (incoming.every(Boolean)) return "in"
  return "mix"
}

export function latestMovements(rows: Movement[], limit = 10): Movement[] {
  return [...rows]
    .sort((a, b) => {
      const at = a.timeMs ?? -1
      const bt = b.timeMs ?? -1
      if (at !== bt) return bt - at
      const ab = a.block ?? -1n
      const bb = b.block ?? -1n
      if (ab === bb) return a.hash < b.hash ? 1 : a.hash > b.hash ? -1 : 0
      return ab > bb ? -1 : 1
    })
    .slice(0, limit)
}

type TokenLeg = { hash: string; timeMs: number | null; block: bigint | null; from: string | null; to: string | null; amount: bigint }

function usdcLegs(payload: unknown, usdc: string): TokenLeg[] {
  const legs: TokenLeg[] = []
  for (const item of itemsOf(payload)) {
    const token = tokenAddress(item.token)
    if (!token || token.toLowerCase() !== usdc.toLowerCase()) continue
    const decimals = decimalsOf(item)
    if (decimals !== null && decimals !== 6) continue
    const amount = tokenAmount(item)
    const hash = typeof item.transaction_hash === "string" ? item.transaction_hash : typeof item.hash === "string" ? item.hash : ""
    if (amount === null || !/^0x[0-9a-fA-F]{64}$/.test(hash)) continue
    legs.push({
      hash,
      timeMs: timeMsOf(item.timestamp),
      block: parseBlock(item.block_number),
      from: addressOf(item.from),
      to: addressOf(item.to),
      amount,
    })
  }
  return legs
}

// A deposit calls USDC, so the treasury is not the transaction's from or to. Token transfers carry those.
export function movementsFromFeeds(input: {
  chainName: string
  treasury: string
  usdc: string
  transactions: unknown
  transfers: unknown
}): Movement[] {
  const legs = usdcLegs(input.transfers, input.usdc)
  const byHash = new Map<string, TokenLeg[]>()
  for (const leg of legs) {
    const list = byHash.get(leg.hash) ?? []
    list.push(leg)
    byHash.set(leg.hash, list)
  }
  const seen = new Set<string>()
  const rows: Movement[] = []
  for (const item of itemsOf(input.transactions)) {
    const hash = typeof item.hash === "string" ? item.hash : ""
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) continue
    seen.add(hash)
    const value = parseWei(item.value) ?? 0n
    const from = addressOf(item.from)
    const to = addressOf(item.to)
    const eth = signedEth(input.treasury, from, to, value)
    const usdc = netUsdc(
      input.treasury,
      (byHash.get(hash) ?? []).map((leg) => ({ from: leg.from, to: leg.to, amount: leg.amount })),
    )
    const ok = item.status !== "error"
    if (ok && usdc.micros === 0n && eth.wei === 0n) continue
    const parties = [...usdc.parties]
    const seenParty = new Set(parties.map((party) => party.toLowerCase()))
    addParty(parties, seenParty, eth.party)
    const method = typeof item.method === "string" && item.method ? item.method : null
    rows.push({
      chainName: input.chainName,
      timeMs: timeMsOf(item.timestamp),
      block: parseBlock(item.block_number),
      hash,
      usdcMicros: usdc.micros,
      ethWei: eth.wei,
      parties,
      ok,
      label: method,
    })
  }
  for (const [hash, groupLegs] of byHash) {
    if (seen.has(hash)) continue
    const usdc = netUsdc(
      input.treasury,
      groupLegs.map((leg) => ({ from: leg.from, to: leg.to, amount: leg.amount })),
    )
    if (usdc.micros === 0n) continue
    rows.push({
      chainName: input.chainName,
      timeMs: groupLegs.reduce<number | null>((max, leg) => (leg.timeMs === null ? max : max === null || leg.timeMs > max ? leg.timeMs : max), null),
      block: groupLegs.reduce<bigint | null>((max, leg) => (leg.block === null ? max : max === null || leg.block > max ? leg.block : max), null),
      hash,
      usdcMicros: usdc.micros,
      ethWei: 0n,
      parties: usdc.parties,
      ok: true,
      label: null,
    })
  }
  return rows
}

export function movementsFromUsdcLogs(chainName: string, treasury: string, logs: UsdcLog[]): Movement[] {
  const byHash = new Map<string, UsdcLog[]>()
  for (const log of logs) {
    const list = byHash.get(log.hash) ?? []
    list.push(log)
    byHash.set(log.hash, list)
  }
  const rows: Movement[] = []
  for (const [hash, legs] of byHash) {
    const usdc = netUsdc(
      treasury,
      legs.map((leg) => ({ from: leg.from, to: leg.to, amount: leg.amount })),
    )
    if (usdc.micros === 0n) continue
    rows.push({
      chainName,
      timeMs: legs.reduce<number | null>((max, leg) => (leg.timeMs === null ? max : max === null || leg.timeMs > max ? leg.timeMs : max), null),
      block: legs.reduce((max, leg) => (leg.block > max ? leg.block : max), 0n),
      hash,
      usdcMicros: usdc.micros,
      ethWei: 0n,
      parties: usdc.parties,
      ok: true,
      label: null,
    })
  }
  return rows
}

function ledgerFile(): string {
  return loadEnv().dbPath
}

function one(db: Database, sql: string): number {
  const row = db.query(sql).get() as { n: number | bigint } | null
  if (!row) throw new Error("ledger query returned nothing")
  return asNumber(row.n)
}

// Read-only. Opening the server database runs the custody migration and zeros balances.
export function readLedger(path: string): LedgerView {
  if (!existsSync(path)) return { path, missing: true }
  let db: Database | null = null
  try {
    db = new Database(path, { readonly: true })
    const spendableMicros = one(db, "SELECT COALESCE(SUM(balance_micros), 0) AS n FROM users")
    const openStakeMicros = one(
      db,
      `SELECT COALESCE(SUM(b.stake_micros), 0) AS n
       FROM bets b JOIN rounds r ON r.id = b.round_id
       WHERE r.status = 'open'`,
    )
    const pendingMicros = one(db, "SELECT COALESCE(SUM(amount_micros), 0) AS n FROM withdrawals WHERE status = 'pending'")
    const pendingCount = one(db, "SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'")
    const users = one(db, "SELECT COUNT(*) AS n FROM users")
    const deposits = one(db, "SELECT COUNT(*) AS n FROM deposits")
    const withdrawals = one(db, "SELECT COUNT(*) AS n FROM withdrawals")
    const rows = db
      .query(
        `SELECT direction, kind, address, amount_micros, tx_hash, status, created_at
         FROM (
           SELECT 'in' AS direction, 'deposit' AS kind, address, amount_micros, tx_hash, 'credited' AS status, created_at
           FROM deposits
           UNION ALL
           SELECT 'out', 'withdraw', address, amount_micros, tx_hash, status, created_at
           FROM withdrawals
         )
         ORDER BY created_at DESC
         LIMIT 10`,
      )
      .all() as {
      direction: string
      kind: string
      address: string
      amount_micros: number | bigint
      tx_hash: string | null
      status: string
      created_at: number | bigint
    }[]
    const entries: BookEntry[] = rows.map((row) => ({
      direction: row.direction === "out" ? "out" : "in",
      kind: row.kind === "withdraw" ? "withdraw" : "deposit",
      address: row.address,
      amountMicros: asNumber(row.amount_micros),
      txHash: row.tx_hash,
      status: row.status,
      createdAt: asNumber(row.created_at),
    }))
    return {
      path,
      spendableMicros,
      openStakeMicros,
      pendingMicros,
      pendingCount,
      users,
      deposits,
      withdrawals,
      entries,
    }
  } catch (error) {
    return { path, error: oneLine(error) }
  } finally {
    db?.close()
  }
}

function field(label: string, value: string): string {
  return `  ${pad(label, 14)} ${value}`
}

function movementAmount(row: Movement): string {
  if (way(row) === "mix") {
    const parts: string[] = []
    if (row.usdcMicros !== 0n) parts.push(`${row.usdcMicros > 0n ? "in" : "out"} ${formatToken(row.usdcMicros)} USDC`)
    if (row.ethWei !== 0n) parts.push(`${row.ethWei > 0n ? "in" : "out"} ${formatEth(row.ethWei)} ETH`)
    const text = parts.join(", ")
    return row.ok ? text : `failed ${text}`
  }
  const parts: string[] = []
  if (row.usdcMicros !== 0n) parts.push(`${formatToken(row.usdcMicros)} USDC`)
  if (row.ethWei !== 0n) parts.push(`${formatEth(row.ethWei)} ETH`)
  const text = parts.length ? parts.join(" and ") : (row.label ?? "transaction").slice(0, 40)
  return row.ok ? text : `failed ${text}`
}

function who(parties: string[]): string {
  if (parties.length === 0) return "—"
  if (parties.length === 1) return shortAddress(parties[0] ?? "")
  if (parties.length === 2) return `${shortAddress(parties[0] ?? "")} ${shortAddress(parties[1] ?? "")}`
  return `${shortAddress(parties[0] ?? "")} +${parties.length - 1}`
}

function when(row: Movement): string {
  if (row.timeMs !== null) return formatStamp(row.timeMs)
  if (row.block !== null) return `block ${row.block}`
  return "unknown time"
}

function chainTitle(chain: ChainFunds): string {
  return chain.configured ? `${chain.name} (${chain.id})  configured` : `${chain.name} (${chain.id})`
}

function balanceNotes(report: TreasuryReport): string[] {
  const notes: string[] = []
  const configured = report.chains.find((chain) => chain.configured)
  if (configured?.ethWei === 0n) notes.push(`${configured.name} has no ETH for withdrawal gas.`)
  else if (configured?.ethWei != null && configured.ethWei < GAS_FLOOR) {
    notes.push(`ETH on ${configured.name} is under 0.00005.`)
  }
  for (const chain of report.chains) {
    if (chain.configured) continue
    const held: string[] = []
    if (chain.ethWei != null && chain.ethWei > 0n) held.push(`${formatEth(chain.ethWei)} ETH`)
    if (chain.usdcMicros != null && chain.usdcMicros > 0n) held.push(`${formatToken(chain.usdcMicros)} USDC`)
    if (held.length) notes.push(`${chain.name} holds ${held.join(" and ")}. This process uses ${report.configured.name}.`)
  }
  return notes
}

function isSnapshot(ledger: LedgerView): ledger is LedgerSnapshot {
  return !("missing" in ledger) && !("error" in ledger)
}

export function renderTreasury(report: TreasuryReport): string {
  const lines = [
    "Treasury summary",
    `${pad("Address", 16)} ${report.address}`,
    `${pad("Process chain", 16)} ${report.configured.name} (${report.configured.id})`,
    `${pad("RPC", 16)} ${report.rpc}`,
    "",
    "Networks",
  ]
  for (const chain of report.chains) {
    lines.push(chainTitle(chain))
    if (chain.error && chain.block === null) lines.push(`  unavailable: ${chain.error}`)
    else {
      lines.push(field("ETH", chain.ethWei === null ? `unavailable${chain.ethError ? `: ${chain.ethError}` : ""}` : formatEth(chain.ethWei)))
      lines.push(
        field(
          "USDC",
          chain.usdcMicros === null
            ? `unavailable${chain.usdcError ? `: ${chain.usdcError}` : ""}`
            : `${formatToken(chain.usdcMicros)}   ${chain.usdc}`,
        ),
      )
      if (chain.block !== null) {
        const stamped = chain.blockTimeMs === null ? "" : `   ${formatStamp(chain.blockTimeMs)}`
        lines.push(field("Block", `${chain.block}${stamped}`))
      }
      if (chain.sentTxs !== null) lines.push(field("Outgoing", String(chain.sentTxs)))
    }
    lines.push(field("RPC", chain.rpc))
    lines.push(field("Explorer", `${EXPLORERS[chain.key].site}/address/${report.address}`))
  }

  lines.push("", `Ledger  ${displayPath(report.ledger.path)}`)
  if ("missing" in report.ledger) lines.push("  No ledger file yet.")
  else if ("error" in report.ledger) lines.push(`  Could not read the ledger: ${report.ledger.error}`)
  else {
    const owed = BigInt(report.ledger.spendableMicros) + BigInt(report.ledger.openStakeMicros)
    const configured = report.chains.find((chain) => chain.configured)
    lines.push(field("Users", String(report.ledger.users)))
    lines.push(field("Spendable", formatUsd(BigInt(report.ledger.spendableMicros))))
    lines.push(field("Open stakes", formatUsd(BigInt(report.ledger.openStakeMicros))))
    lines.push(field("Owed", formatUsd(owed)))
    if (!configured || configured.usdcMicros === null) {
      lines.push(field("On-chain USDC", `unavailable on ${report.configured.name}`))
    } else {
      const delta = configured.usdcMicros - owed
      const compared = delta === 0n ? "Even with owed" : delta > 0n ? "Ahead of owed" : "Short of owed"
      lines.push(field("On-chain USDC", `${formatUsd(configured.usdcMicros)} on ${configured.name}`))
      lines.push(field(compared, formatUsd(delta)))
    }
    lines.push(field("Deposits", String(report.ledger.deposits)))
    lines.push(field("Withdrawals", String(report.ledger.withdrawals)))
    lines.push(field("Pending", `${report.ledger.pendingCount}  ${formatUsd(BigInt(report.ledger.pendingMicros))}`))
    if (report.ledger.pendingCount > 0) {
      lines.push("  Pending withdrawals are already removed from spendable and may still be in the wallet.")
    }
    lines.push("", "  Last 10 book entries")
    if (report.ledger.entries.length === 0) lines.push("  No deposits or withdrawals.")
    for (const entry of report.ledger.entries) {
      const amount = pad(`${formatToken(BigInt(entry.amountMicros))} USDC`, 16)
      lines.push(
        `  ${formatStamp(entry.createdAt)}  ${pad(entry.direction, 3)}  ${amount}  ${pad(entry.status, 9)}  ${pad(shortAddress(entry.address), 13)}  ${entry.txHash ?? "—"}`,
      )
    }
  }

  lines.push("", "Last 10 transfers")
  for (const note of report.historyNotes) lines.push(`  ${note}`)
  const movements = latestMovements(report.movements)
  if (movements.length === 0) lines.push("  No transfers found.")
  for (const row of movements) {
    lines.push(`  ${pad(when(row), 20)}  ${pad(row.chainName, 12)}  ${pad(way(row), 3)}  ${pad(movementAmount(row), 28)}  ${pad(who(row.parties), 13)}  ${row.hash}`)
  }

  const notes = balanceNotes(report)
  if (notes.length) {
    lines.push("", "Notes")
    for (const note of notes) lines.push(`  ${note}`)
  }
  return lines.join("\n")
}

function viemChain(config: ChainConfig) {
  return config.id === base.id ? base : baseSepolia
}

function chainsFor(configured: ChainConfig): ChainConfig[] {
  return [configured, ...Object.values(CHAINS).filter((chain) => chain.key !== configured.key)]
}

async function loadChain(config: ChainConfig, address: Address, rpc: string, configured: boolean): Promise<ChainFunds> {
  const row: ChainFunds = {
    key: config.key,
    name: config.name,
    id: config.id,
    configured,
    rpc,
    usdc: config.usdc,
    block: null,
    blockTimeMs: null,
    ethWei: null,
    usdcMicros: null,
    sentTxs: null,
    error: null,
    ethError: null,
    usdcError: null,
  }
  try {
    const client = createPublicClient({ chain: viemChain(config), transport: http(rpc, { timeout: 12_000 }) })
    const block = await client.getBlock()
    row.block = block.number
    row.blockTimeMs = Number(block.timestamp) * 1000
    const [eth, usdc, sent] = await Promise.allSettled([
      client.getBalance({ address, blockNumber: block.number }),
      client.readContract({
        address: config.usdc,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [address],
        blockNumber: block.number,
      }),
      client.getTransactionCount({ address, blockNumber: block.number }),
    ])
    if (eth.status === "fulfilled") row.ethWei = eth.value
    else row.ethError = oneLine(eth.reason)
    if (usdc.status === "fulfilled") row.usdcMicros = usdc.value
    else row.usdcError = oneLine(usdc.reason)
    if (sent.status === "fulfilled") row.sentTxs = typeof sent.value === "bigint" ? Number(sent.value) : sent.value
    return row
  } catch (error) {
    row.error = oneLine(error)
    return row
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "quick-market" },
    signal: AbortSignal.timeout(8_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) throw new Error("response was not JSON")
  return JSON.parse(trimmed) as unknown
}

async function recentUsdc(config: ChainConfig, treasury: Address): Promise<Movement[]> {
  const client = createPublicClient({
    chain: viemChain(config),
    transport: http(HISTORY_RPC[config.key], { timeout: 20_000 }),
  })
  const head = await client.getBlockNumber()
  const fromBlock = head > HISTORY_LOOKBACK ? head - HISTORY_LOOKBACK : 0n
  const [incoming, outgoing] = await Promise.all([
    client.getLogs({ address: config.usdc, event: transferEvent, args: { to: treasury }, fromBlock, toBlock: head }),
    client.getLogs({ address: config.usdc, event: transferEvent, args: { from: treasury }, fromBlock, toBlock: head }),
  ])
  const seen = new Set<string>()
  const logs: UsdcLog[] = []
  for (const log of [...incoming, ...outgoing]) {
    const from = log.args.from
    const to = log.args.to
    const amount = log.args.value
    if (!from || !to || amount === undefined || !log.transactionHash || log.logIndex == null) continue
    const key = `${log.transactionHash}:${log.logIndex}`
    if (seen.has(key)) continue
    seen.add(key)
    logs.push({ block: log.blockNumber ?? 0n, hash: log.transactionHash, from, to, amount, timeMs: null })
  }
  const latest = latestMovements(movementsFromUsdcLogs(config.name, treasury, logs))
  await Promise.all(
    latest.map(async (row) => {
      if (row.block === null) return
      try {
        const block = await client.getBlock({ blockNumber: row.block })
        row.timeMs = Number(block.timestamp) * 1000
      } catch {
        // The row still shows, dated by block number.
      }
    }),
  )
  return latest
}

type HistoryNote = { chainKey: ChainKey; kind: "fallback-empty" | "other"; text: string }

async function loadHistory(config: ChainConfig, treasury: Address): Promise<{ movements: Movement[]; note: HistoryNote | null }> {
  const explorer = EXPLORERS[config.key]
  const txUrl = `${explorer.api}/api/v2/addresses/${treasury}/transactions`
  const transferUrl = `${explorer.api}/api/v2/addresses/${treasury}/token-transfers?type=ERC-20&token=${config.usdc}`
  const [transactions, transfers] = await Promise.allSettled([fetchJson(txUrl), fetchJson(transferUrl)])
  if (transactions.status === "rejected" && transfers.status === "rejected") {
    try {
      const movements = await recentUsdc(config, treasury)
      const coverage = `the last ${HISTORY_LOOKBACK} blocks`
      const empty = movements.length === 0
      return {
        movements,
        note: {
          chainKey: config.key,
          kind: empty ? "fallback-empty" : "other",
          text: empty
            ? `${config.name} explorer unavailable (${oneLine(transactions.reason)}). No USDC logs in ${coverage}.`
            : `${config.name} explorer unavailable (${oneLine(transactions.reason)}). ${config.name} rows from that search are USDC logs in ${coverage}.`,
        },
      }
    } catch {
      return {
        movements: [],
        note: { chainKey: config.key, kind: "other", text: `${config.name} transfers unavailable: ${oneLine(transactions.reason)}.` },
      }
    }
  }
  const text =
    transactions.status === "rejected"
      ? `${config.name} transaction list unavailable: ${oneLine(transactions.reason)}.`
      : transfers.status === "rejected"
        ? `${config.name} token transfers unavailable: ${oneLine(transfers.reason)}.`
        : null
  const note = text ? { chainKey: config.key, kind: "other" as const, text } : null
  return {
    movements: movementsFromFeeds({
      chainName: config.name,
      treasury,
      usdc: config.usdc,
      transactions: transactions.status === "fulfilled" ? transactions.value : { items: [] },
      transfers: transfers.status === "fulfilled" ? transfers.value : { items: [] },
    }),
    note,
  }
}

async function main() {
  try {
    loadMarket()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
  const source = loadSource()
  const decision = planTreasury(source, process.env.TREASURY_PRIVATE_KEY, generatePrivateKey())
  if (decision.action === "invalid") {
    console.error("TREASURY_PRIVATE_KEY must be a 32-byte hex string")
    process.exit(1)
  }
  if (decision.action === "write") {
    writeFileSync(ENV_PATH, decision.text, { mode: 0o600 })
    chmodSync(ENV_PATH, 0o600)
    console.log("wrote TREASURY_PRIVATE_KEY to .env")
  } else if (decision.action === "refuse") {
    console.log("TREASURY_PRIVATE_KEY is already set. .env was not changed.")
  }

  let configured: ChainConfig
  let rpc = ""
  try {
    const env = loadEnv()
    rpc = env.rpcUrl
    configured = chainFromEnv(marketPreferences.chain, env.usdcAddress)
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unknown CHAIN")
    process.exit(1)
  }

  const address = decision.address as Address
  const chains = chainsFor(configured)
  const ledger = readLedger(ledgerFile())
  const [funds, histories] = await Promise.all([
    Promise.all(chains.map((chain) => loadChain(chain, address, rpcFor(chain, configured.key, rpc), chain.key === configured.key))),
    Promise.all(chains.map((chain) => loadHistory(chain, address))),
  ])
  console.log(
    renderTreasury({
      address,
      configured,
      rpc: rpcFor(configured, configured.key, rpc),
      chains: funds,
      ledger,
      movements: histories.flatMap((history) => history.movements),
      historyNotes: histories.flatMap((history) => {
        const note = history.note
        if (!note) return []
        if (note.kind === "fallback-empty") {
          const chain = funds.find((row) => row.key === note.chainKey)
          if (chain?.ethWei === 0n && chain.usdcMicros === 0n) return []
        }
        return [note.text]
      }),
    }),
  )
}

if (import.meta.main) void main()
