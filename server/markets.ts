import type { ChainKey } from "../shared/chain"

const KEYS: readonly ChainKey[] = ["base", "base-sepolia", "near-testnet"]

export function isChainKey(value: string | null): value is ChainKey {
  return value !== null && (KEYS as readonly string[]).includes(value)
}

export function pickChain(input: {
  raw: string | null
  sessionChain: ChainKey | null
  live: ChainKey[]
  agent: boolean
}): { ok: true; chain: ChainKey } | { ok: false; status: number; error: string } {
  if (input.live.length === 0) return { ok: false, status: 503, error: "No market is on" }
  if (input.raw !== null && !isChainKey(input.raw)) return { ok: false, status: 400, error: "Chain is invalid" }
  const asked = input.raw !== null && isChainKey(input.raw) ? input.raw : null
  if (asked && !input.live.includes(asked)) return { ok: false, status: 404, error: "That market is off" }
  if (asked && input.sessionChain && asked !== input.sessionChain) {
    return { ok: false, status: 401, error: "Sign in on this market" }
  }
  if (asked) return { ok: true, chain: asked }
  if (input.sessionChain && input.live.includes(input.sessionChain)) return { ok: true, chain: input.sessionChain }
  if (input.agent && input.live.includes("base-sepolia")) return { ok: true, chain: "base-sepolia" }
  if (input.live.includes("near-testnet")) return { ok: true, chain: "near-testnet" }
  return { ok: true, chain: input.live[0]! }
}
