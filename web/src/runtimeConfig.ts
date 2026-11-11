import { chainFromEnv, type ChainConfig, type ChainKey } from "../../shared/chain"
import { publicConfigSchema, type PublicConfig } from "../../shared/market"

export type RuntimeConfig = {
  config: PublicConfig
  chain: ChainConfig
}

export const MARKET_STORAGE_KEY = "qm.market"

export type MarketsPayload = {
  defaultChainKey: ChainKey
  markets: PublicConfig[]
}

export function withChainQuery(path: string, chainKey: string): string {
  const hashAt = path.indexOf("#")
  const bare = hashAt === -1 ? path : path.slice(0, hashAt)
  const hash = hashAt === -1 ? "" : path.slice(hashAt)
  const queryAt = bare.indexOf("?")
  const params = new URLSearchParams(queryAt === -1 ? "" : bare.slice(queryAt + 1))
  params.set("chain", chainKey)
  const pathname = queryAt === -1 ? bare : bare.slice(0, queryAt)
  return `${pathname}?${params.toString()}${hash}`
}

/** A stored choice wins when that market is on. Otherwise Near wins when it is on. */
export function chosenMarket(markets: PublicConfig[], stored: string | null, fallback: string): PublicConfig | null {
  if (markets.length === 0) return null
  const storedHit = stored ? markets.find((market) => market.chainKey === stored) : undefined
  if (storedHit) return storedHit
  return markets.find((market) => market.chainKey === fallback) ?? markets[0] ?? null
}

export function runtimeChain(config: PublicConfig): ChainConfig {
  const chain = chainFromEnv(config.chainKey, config.usdc)
  if (chain.id !== config.chainId || chain.name !== config.chainName) {
    throw new Error("The server returned inconsistent chain configuration.")
  }
  return chain
}

export async function fetchMarkets(): Promise<MarketsPayload> {
  const response = await fetch("/api/markets")
  if (!response.ok) throw new Error(`Market configuration returned ${response.status}.`)
  const body = (await response.json()) as { defaultChainKey?: unknown; markets?: unknown }
  const markets = publicConfigSchema.array().parse(body.markets)
  const fallback = typeof body.defaultChainKey === "string" ? body.defaultChainKey : markets[0]?.chainKey
  if (!fallback || !markets.some((market) => market.chainKey === fallback)) {
    throw new Error("The server returned inconsistent chain configuration.")
  }
  return { defaultChainKey: fallback as ChainKey, markets }
}
