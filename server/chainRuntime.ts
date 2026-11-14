import { moneyLabel, requireSepoliaToken, tokenKind, tokenLabel, type ChainConfig, type ChainKey } from "../shared/chain"
import { requireNearToken, type TreasuryReport } from "../shared/near"
import { accountFromSecret } from "../shared/nearKey"
import { withChain } from "./activeChain"
import { mintToTreasury, requestWithdraw, startCustody, treasuryAddress, watchMint } from "./custody"
import { getDb } from "./db"
import { chainConfig, loadEnv, nearTreasurySecret } from "./env"
import { grantSettings, resumePendingGrants } from "./grant"
import {
  assertLedgerChain,
  bootNear,
  currentTreasuryReport,
  mintNearToTreasury,
  requestNearWithdraw,
  startNearCustody,
  watchNearGrant,
} from "./near"
import type { You } from "./rounds"

export type ChainRuntime = {
  chain: ChainConfig
  treasury: string
  token: string
  grantsOpen: boolean
  moneyLabel: string
  tokenKind: ReturnType<typeof tokenKind>
  tokenLabel: string
  mint: (amount: number, report?: (progress: { txHash?: string; seen: number }) => void) => Promise<void>
  withdraw: (
    address: string,
    amount: number,
  ) => Promise<
    | { ok: true; you: You; txHash: string }
    | { ok: false; error: string; you?: You; code?: string; retryAfterMs?: number; coolingUntil?: number | null }
  >
  treasuryReport: () => TreasuryReport | null
}

export async function startChainRuntime(key: ChainKey): Promise<ChainRuntime> {
  return withChain(key, () => startScoped(key))
}

async function startScoped(key: ChainKey): Promise<ChainRuntime> {
  const chain = chainConfig(key)
  const env = loadEnv()
  if (chain.key === "near-testnet") {
    requireNearToken(chain.key, env.tokenAccount)
    const secret = nearTreasurySecret(env)
    const treasury = await accountFromSecret(secret)
    if (!treasury) throw new Error("NEAR_TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
    getDb()
    await bootNear(treasury)
    startNearCustody(treasury)
    const settings = grantSettings()
    void resumePendingGrants({
      chainKey: chain.key,
      amount: settings.amount,
      watch: (hash, report) => withChain(chain.key, () => watchNearGrant(treasury, hash, report)),
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : error)
    })
    return {
      chain,
      treasury,
      token: env.tokenAccount.trim(),
      grantsOpen: true,
      moneyLabel: moneyLabel(chain),
      tokenKind: tokenKind(chain),
      tokenLabel: tokenLabel(chain),
      mint: mintNearToTreasury,
      withdraw: requestNearWithdraw,
      treasuryReport: currentTreasuryReport,
    }
  }

  requireSepoliaToken(chain)
  const settings = grantSettings()
  const treasury = treasuryAddress()
  getDb()
  assertLedgerChain(chain.key, env.dbPath)
  startCustody()
  if (chain.key === "base-sepolia") {
    void resumePendingGrants({
      chainKey: chain.key,
      amount: settings.amount,
      watch: (hash, report) => withChain(chain.key, () => watchMint(hash as `0x${string}`, report)),
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : error)
    })
  }
  return {
    chain,
    treasury,
    token: chain.usdc,
    grantsOpen: chain.key === "base-sepolia",
    moneyLabel: moneyLabel(chain),
    tokenKind: tokenKind(chain),
    tokenLabel: tokenLabel(chain),
    mint: mintToTreasury,
    withdraw: requestWithdraw,
    treasuryReport: () => null,
  }
}
