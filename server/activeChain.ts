import { AsyncLocalStorage } from "node:async_hooks"
import type { ChainKey } from "../shared/chain"
import { marketPreferences } from "../shared/market"

const slot = new AsyncLocalStorage<ChainKey>()

export function activeChainKey(): ChainKey {
  return slot.getStore() ?? marketPreferences.chain
}

/** Custody timers and requests enter here. The store follows the async call. */
export function withChain<T>(key: ChainKey, run: () => T): T {
  return slot.run(key, run)
}
