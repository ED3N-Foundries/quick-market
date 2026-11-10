import { chainFromEnv, type ChainConfig } from "../../shared/chain"
import { publicConfigSchema, type PublicConfig } from "../../shared/market"

export type RuntimeConfig = {
  config: PublicConfig
  chain: ChainConfig
}

export function runtimeChain(config: PublicConfig): ChainConfig {
  const chain = chainFromEnv(config.chainKey, config.usdc)
  if (chain.id !== config.chainId || chain.name !== config.chainName) {
    throw new Error("The server returned inconsistent chain configuration.")
  }
  return chain
}

export async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  const response = await fetch("/api/config")
  if (!response.ok) throw new Error(`Market configuration returned ${response.status}.`)
  const config = publicConfigSchema.parse(await response.json())
  return { config, chain: runtimeChain(config) }
}
