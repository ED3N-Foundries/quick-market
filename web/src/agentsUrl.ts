export const AGENT_CHAINS = ["base-sepolia", "near-testnet"] as const

/** Connector for one market. The token is only attached for the market this page is signed into. */
export function connectorUrl(origin: string, chainKey: string, token: string | null): string {
  const url = new URL("/mcp", origin)
  url.searchParams.set("chain", chainKey)
  if (token) url.searchParams.set("token", token)
  return url.toString()
}
