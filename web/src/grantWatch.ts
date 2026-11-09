import { MINT_CONFIRMATIONS } from "../../shared/mint"

/** Blocks a mined grant transaction has, including the block it landed in. */
export function confirmationDepth(head: bigint | null, minedAt: bigint | null): number {
  if (head === null || minedAt === null || head < minedAt) return 0
  const depth = head - minedAt + 1n
  if (depth > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(depth)
}

export function grantLanded(before: number | null, next: number | null): boolean {
  if (next === null || !Number.isSafeInteger(next)) return false
  if (before === null || !Number.isSafeInteger(before)) return true
  return next > before
}

export function grantTxUrl(chainId: number, hash: string, chainKey?: string): string | null {
  if (chainKey === "near-testnet") {
    if (!hash || hash.startsWith("0x")) return null
    return `https://testnet.nearblocks.io/txns/${hash}`
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${hash}`
  if (chainId === 8453) return `https://basescan.org/tx/${hash}`
  return null
}

export function cappedConfirmations(seen: number): number {
  if (!Number.isFinite(seen) || seen <= 0) return 0
  return Math.min(MINT_CONFIRMATIONS, Math.floor(seen))
}
