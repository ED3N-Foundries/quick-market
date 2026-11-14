import type { Database } from "bun:sqlite"
import { createPublicClient, http, type Address } from "viem"
import { base, baseSepolia } from "viem/chains"
import type { ChainConfig, ChainKey } from "../shared/chain"
import { formatQm, formatToken, type TreasuryReport } from "../shared/near"
import { usdcAbi } from "../shared/usdc"

/** 0.00005 ETH. Below this, a withdraw has no gas. */
export const GAS_FLOOR_WEI = 50_000_000_000_000n
const WEI = 1_000_000_000_000_000_000n

export type FundingAsset = {
  symbol: string
  have: string
  need: string
  short: boolean
}

export type FundingAgent = {
  account: string
  near: string
  need: string
  missing: boolean
}

export type FundingCooling = {
  cooling: boolean
  retryAfterMs: number
  untilMs: number | null
  reason: string | null
}

export type FundingChain = {
  chainKey: ChainKey
  chainName: string
  chainId: number
  treasury: string
  token: string
  tokenLabel: string
  native: FundingAsset
  tokenBalance: FundingAsset
  explorer: string
  lines: string[]
  shortAgents: FundingAgent[]
  error: string | null
  cooling: FundingCooling | null
}

export type FundingReport = {
  at: number
  chains: FundingChain[]
}

export type EvmBalances = {
  nativeWei: bigint | null
  tokenMicros: bigint | null
  error: string | null
}

export type FundingSource = {
  chain: ChainConfig
  treasury: string
  token: string
  tokenLabel: string
  near: TreasuryReport | null
  cooling?: FundingCooling | null
}

function asBig(value: number | bigint | null | undefined): bigint {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value))
  return 0n
}

function one(db: Database, sql: string, chainKey: string): bigint {
  const row = db.query(sql).get(chainKey) as { n: number | bigint | null } | null
  return asBig(row?.n)
}

export function ledgerOwed(db: Database, chainKey: string): { spendableMicros: bigint; openStakeMicros: bigint } {
  const spendableMicros = one(db, "SELECT COALESCE(SUM(balance_micros), 0) AS n FROM users WHERE chain_key = ?", chainKey)
  const openStakeMicros = one(
    db,
    `SELECT COALESCE(SUM(b.stake_micros), 0) AS n
     FROM buy_ins b JOIN rounds r ON r.chain_key = b.chain_key AND r.id = b.round_id
     WHERE b.chain_key = ? AND r.status = 'open'`,
    chainKey,
  )
  return { spendableMicros, openStakeMicros }
}

/** Decimal strings from the NEAR report. Missing or non-numeric values are not short. */
export function decimalLess(have: string, need: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(have) || !/^\d+(\.\d+)?$/.test(need)) return false
  const [hw, hf = ""] = have.split(".")
  const [nw, nf = ""] = need.split(".")
  const scale = Math.max(hf.length, nf.length)
  return BigInt((hw ?? "0") + hf.padEnd(scale, "0")) < BigInt((nw ?? "0") + nf.padEnd(scale, "0"))
}

export function explorerUrl(chain: Pick<ChainConfig, "key">, treasury: string): string {
  if (chain.key === "base") return `https://basescan.org/address/${treasury}`
  if (chain.key === "near-testnet") return `https://testnet.nearblocks.io/address/${treasury}`
  return `https://sepolia.basescan.org/address/${treasury}`
}

export function describeEvm(input: {
  chain: ChainConfig
  treasury: string
  token: string
  tokenLabel: string
  balances: EvmBalances
  spendableMicros: bigint
  openStakeMicros: bigint
  cooling?: FundingCooling | null
}): FundingChain {
  const owed = input.spendableMicros + input.openStakeMicros
  const nativeHave = input.balances.nativeWei === null ? "unavailable" : formatToken(input.balances.nativeWei, WEI, 6)
  const tokenHave = input.balances.tokenMicros === null ? "unavailable" : formatQm(input.balances.tokenMicros)
  return {
    chainKey: input.chain.key,
    chainName: input.chain.name,
    chainId: input.chain.id,
    treasury: input.treasury,
    token: input.token,
    tokenLabel: input.tokenLabel,
    native: {
      symbol: "ETH",
      have: nativeHave,
      need: formatToken(GAS_FLOOR_WEI, WEI, 6),
      short: input.balances.nativeWei !== null && input.balances.nativeWei < GAS_FLOOR_WEI,
    },
    tokenBalance: {
      symbol: input.tokenLabel,
      have: tokenHave,
      need: formatQm(owed),
      short: input.balances.tokenMicros !== null && input.balances.tokenMicros < owed,
    },
    explorer: explorerUrl(input.chain, input.treasury),
    lines: [],
    shortAgents: [],
    error: input.balances.error,
    cooling: input.cooling ?? null,
  }
}

export function describeNear(input: {
  chain: ChainConfig
  treasury: string
  token: string
  tokenLabel: string
  report: TreasuryReport | null
  cooling?: FundingCooling | null
}): FundingChain {
  const report = input.report
  if (!report) {
    return {
      chainKey: input.chain.key,
      chainName: input.chain.name,
      chainId: input.chain.id,
      treasury: input.treasury,
      token: input.token,
      tokenLabel: input.tokenLabel,
      native: { symbol: "NEAR", have: "unavailable", need: "0.5", short: false },
      tokenBalance: { symbol: input.tokenLabel, have: "unavailable", need: "0", short: false },
      explorer: explorerUrl(input.chain, input.treasury),
      lines: [],
      shortAgents: [],
      error: "NEAR treasury report is not ready",
      cooling: input.cooling ?? null,
    }
  }
  return {
    chainKey: input.chain.key,
    chainName: input.chain.name,
    chainId: input.chain.id,
    treasury: input.treasury,
    token: input.token,
    tokenLabel: input.tokenLabel,
    native: {
      symbol: "NEAR",
      have: report.near,
      need: report.nearNeed,
      short: decimalLess(report.near, report.nearNeed),
    },
    tokenBalance: {
      symbol: input.tokenLabel,
      have: report.token,
      need: report.tokenNeed,
      short: decimalLess(report.token, report.tokenNeed),
    },
    explorer: explorerUrl(input.chain, input.treasury),
    lines: report.lines,
    shortAgents: report.shortAgents.map((agent) => ({
      account: agent.account,
      near: agent.near,
      need: agent.need,
      missing: agent.missing,
    })),
    error: null,
    cooling: input.cooling ?? null,
  }
}

export async function readEvmBalances(rpc: string, chainId: number, treasury: Address, token: Address): Promise<EvmBalances> {
  const chain = chainId === base.id ? base : baseSepolia
  const client = createPublicClient({ chain, transport: http(rpc, { timeout: 4_000 }) })
  const native = client.getBalance({ address: treasury }).then(
    (value) => ({ value, error: null as string | null }),
    (error: unknown) => ({ value: null, error: error instanceof Error ? error.message : "eth balance failed" }),
  )
  const tokenBalance = client.readContract({ address: token, abi: usdcAbi, functionName: "balanceOf", args: [treasury] }).then(
    (value) => ({ value, error: null as string | null }),
    (error: unknown) => ({ value: null, error: error instanceof Error ? error.message : "token balance failed" }),
  )
  const [eth, coin] = await Promise.all([native, tokenBalance])
  const error = [eth.error, coin.error].filter((item) => item).join("; ")
  return { nativeWei: eth.value, tokenMicros: coin.value, error: error || null }
}

export async function collectFunding(input: {
  chains: FundingSource[]
  db: Database
  readEvm?: typeof readEvmBalances
  now?: number
}): Promise<FundingReport> {
  const readEvm = input.readEvm ?? readEvmBalances
  const chains: FundingChain[] = []
  for (const source of input.chains) {
    if (source.chain.key === "near-testnet") {
      chains.push(describeNear({
        chain: source.chain,
        treasury: source.treasury,
        token: source.token,
        tokenLabel: source.tokenLabel,
        report: source.near,
        cooling: source.cooling ?? null,
      }))
      continue
    }
    let owed = { spendableMicros: 0n, openStakeMicros: 0n }
    let ledgerError: string | null = null
    try {
      owed = ledgerOwed(input.db, source.chain.key)
    } catch (error) {
      ledgerError = error instanceof Error ? error.message : "ledger unreadable"
    }
    let balances: EvmBalances = { nativeWei: null, tokenMicros: null, error: "treasury address is not an EVM address" }
    if (/^0x[0-9a-fA-F]{40}$/.test(source.treasury) && /^0x[0-9a-fA-F]{40}$/.test(source.token)) {
      try {
        balances = await readEvm(source.chain.rpc, source.chain.id, source.treasury as Address, source.token as Address)
      } catch (error) {
        balances = { nativeWei: null, tokenMicros: null, error: error instanceof Error ? error.message : "rpc failed" }
      }
    }
    if (ledgerError) balances = { ...balances, error: balances.error ? `${balances.error}; ${ledgerError}` : ledgerError }
    chains.push(describeEvm({
      chain: source.chain,
      treasury: source.treasury,
      token: source.token,
      tokenLabel: source.tokenLabel,
      balances,
      spendableMicros: owed.spendableMicros,
      openStakeMicros: owed.openStakeMicros,
      cooling: source.cooling ?? null,
    }))
  }
  return { at: input.now ?? Date.now(), chains }
}
