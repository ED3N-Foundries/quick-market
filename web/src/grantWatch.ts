export { confirmationDepth } from "../../shared/mint"

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
