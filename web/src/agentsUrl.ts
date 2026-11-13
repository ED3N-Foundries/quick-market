import { CHAINS, type ChainKey } from "../../shared/chain"

export const AGENT_CHAINS = ["base-sepolia", "near-testnet"] as const

/** Same key wallet.tsx writes when a market sign-in succeeds. */
function sessionStorageKey(chainKey: string) {
  return `qm.session.${chainKey}`
}

function isChainKey(value: string): value is ChainKey {
  return value === "base" || value === "base-sepolia" || value === "near-testnet"
}

function defaultRead(key: string): string | null {
  if (typeof sessionStorage === "undefined") return null
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

/** Session token already stored for this market, or null when that sign-in is gone. */
export function storedSessionToken(chainKey: string, read: (key: string) => string | null = defaultRead): string | null {
  if (!isChainKey(chainKey)) return null
  const raw = read(sessionStorageKey(chainKey))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; address?: unknown; chainId?: unknown }
    if (parsed.chainId !== CHAINS[chainKey].id) return null
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null
    if (typeof parsed.address !== "string" || parsed.address.length === 0) return null
    return parsed.token
  } catch {
    return null
  }
}

/** Connector for one market. A token is attached only for that market's own session. */
export function connectorUrl(origin: string, chainKey: string, token: string | null): string {
  const url = new URL("/mcp", origin)
  url.searchParams.set("chain", chainKey)
  if (token) url.searchParams.set("token", token)
  return url.toString()
}

/** Host, path, and chain. The session token is left out so the row can stay short. */
export function connectorLinkLabel(url: string): string {
  const parsed = new URL(url)
  const chain = parsed.searchParams.get("chain")
  return `${parsed.host}${parsed.pathname}${chain ? `?chain=${chain}` : ""}`
}

/** The session token in full, or null when this connector has none. */
export function connectorSessionToken(url: string): string | null {
  const token = new URL(url).searchParams.get("token")
  return token && token.length > 0 ? token : null
}

/**
 * One paste for the agent: the setup ask, then each signed-in session URL.
 * Markets with no URL are left out, so a single sign-in stays a single link.
 */
export function agentSetupText(ask: string, markets: { label: string; url: string }[]): string {
  const parts = [ask.trim()]
  for (const market of markets) {
    const label = market.label.trim()
    const url = market.url.trim()
    if (!url) continue
    parts.push(label ? `${label}\n${url}` : url)
  }
  return parts.filter((part) => part.length > 0).join("\n\n")
}

/** One signed-in connector per market. Markets with no stored session are left out. */
export function agentConnectors(
  origin: string,
  page: { chainKey: string; token: string | null },
  read: (key: string) => string | null = defaultRead,
): { chainKey: (typeof AGENT_CHAINS)[number]; url: string }[] {
  return AGENT_CHAINS.flatMap((chainKey) => {
    const token = chainKey === page.chainKey && page.token ? page.token : storedSessionToken(chainKey, read)
    if (!token) return []
    return [{ chainKey, url: connectorUrl(origin, chainKey, token) }]
  })
}
