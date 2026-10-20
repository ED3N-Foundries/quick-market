import { getPublicClient } from "wagmi/actions"
import type { Hash } from "viem"
import { confirmationDepth, cappedConfirmations } from "./grantWatch"
import { wagmiConfig } from "./wallet"

/** How many blocks the grant transaction has. 0 before it is mined, or when the RPC misses. */
export async function readGrantConfirmations(hash: string, chainId: number): Promise<number> {
  if (!wagmiConfig || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return 0
  const client = getPublicClient(wagmiConfig, { chainId: chainId as 8453 | 84532 })
  if (!client) return 0
  try {
    const [receipt, head] = await Promise.all([
      client.getTransactionReceipt({ hash: hash as Hash }).catch(() => null),
      client.getBlockNumber(),
    ])
    return cappedConfirmations(confirmationDepth(head, receipt?.blockNumber ?? null))
  } catch {
    return 0
  }
}
