import { createPublicClient, http, type Hash } from "viem"
import { base, baseSepolia } from "viem/chains"
import { confirmationDepth, cappedConfirmations } from "./grantWatch"

/** How many blocks the grant transaction has. 0 before it is mined, or when the RPC misses. */
export async function readGrantConfirmations(hash: string, chainId: number): Promise<number> {
  const chain = chainId === base.id ? base : chainId === baseSepolia.id ? baseSepolia : null
  if (!chain || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return 0
  const client = createPublicClient({ chain, transport: http() })
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
