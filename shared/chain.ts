export type ChainKey = "base" | "base-sepolia"

export type ChainConfig = {
  key: ChainKey
  id: number
  name: string
  usdc: `0x${string}`
  rpc: string
  faucet: boolean
}

/** Circle's Base Sepolia USDC. Sepolia quick-market must not use this contract. */
export const CIRCLE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

export const CHAINS: Record<ChainKey, ChainConfig> = {
  base: {
    key: "base",
    id: 8453,
    name: "Base",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpc: "https://mainnet.base.org",
    faucet: false,
  },
  "base-sepolia": {
    key: "base-sepolia",
    id: 84532,
    name: "Base Sepolia",
    usdc: CIRCLE_SEPOLIA_USDC,
    rpc: "https://sepolia.base.org",
    faucet: true,
  },
}

export function chainFromEnv(value: string | undefined, usdcAddress?: string | null): ChainConfig {
  const chain = chainByKey(value)
  if (chain.key !== "base-sepolia") return chain
  const override = usdcAddress?.trim() ?? ""
  if (!override) return chain
  if (!/^0x[0-9a-fA-F]{40}$/.test(override)) throw new Error("USDC_ADDRESS must be a 20-byte hex address")
  if (override.toLowerCase() === CIRCLE_SEPOLIA_USDC.toLowerCase()) {
    throw new Error("USDC_ADDRESS must be quick-market USDC, not Circle USDC, on Base Sepolia")
  }
  return { ...chain, usdc: override as `0x${string}` }
}

function chainByKey(value: string | undefined): ChainConfig {
  if (value === undefined || value === "") return CHAINS["base-sepolia"]
  if (value === "base" || value === "base-sepolia") return CHAINS[value]
  throw new Error(`Unknown CHAIN "${value}". Use base or base-sepolia.`)
}

export function moneyLabel(chain: Pick<ChainConfig, "key">): string {
  return chain.key === "base" ? "Circle USDC" : "quick-market USDC"
}

/** The running Sepolia server and agent must watch quick-market USDC, never Circle's contract. */
export function requireSepoliaToken(chain: ChainConfig) {
  if (chain.key !== "base-sepolia") return
  if (chain.usdc.toLowerCase() === CIRCLE_SEPOLIA_USDC.toLowerCase()) {
    throw new Error("Set USDC_ADDRESS to the quick-market USDC contract before starting on Base Sepolia.")
  }
}
