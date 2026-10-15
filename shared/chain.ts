export type ChainKey = "base" | "base-sepolia"

export type ChainConfig = {
  key: ChainKey
  id: number
  name: string
  usdc: `0x${string}`
  rpc: string
  faucet: boolean
}

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
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpc: "https://sepolia.base.org",
    faucet: true,
  },
}

export function chainFromEnv(value: string | undefined): ChainConfig {
  if (value === undefined || value === "") return CHAINS["base-sepolia"]
  if (value === "base" || value === "base-sepolia") return CHAINS[value]
  throw new Error(`Unknown CHAIN "${value}". Use base or base-sepolia.`)
}
