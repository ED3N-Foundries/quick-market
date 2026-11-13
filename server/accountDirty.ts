import type { ChainKey } from "../shared/chain"

const dirty = new Map<ChainKey, Set<string>>()

/** The ledger changed for this account. The next keyframe reads it if someone is listening. */
export function markAccountDirty(chain: ChainKey, address: string): void {
  if (!address) return
  let set = dirty.get(chain)
  if (!set) {
    set = new Set()
    dirty.set(chain, set)
  }
  set.add(address)
}

export function dropAccountDirty(chain: ChainKey, address: string): void {
  const set = dirty.get(chain)
  if (!set) return
  set.delete(address)
  if (set.size === 0) dirty.delete(chain)
}

export function accountIsDirty(chain: ChainKey, address: string): boolean {
  return dirty.get(chain)?.has(address) ?? false
}

export function accountDirtyCount(chain: ChainKey): number {
  return dirty.get(chain)?.size ?? 0
}

/**
 * Drop addresses nobody is listening to. Return at most `limit` that have a listener.
 * The rest stay dirty so a burst cannot fill this slot.
 */
export function takeAccountDirty(
  chain: ChainKey,
  hasListener: (address: string) => boolean,
  limit: number,
): string[] {
  const set = dirty.get(chain)
  if (!set || set.size === 0) return []
  const taken: string[] = []
  for (const address of set) {
    if (!hasListener(address)) {
      set.delete(address)
      continue
    }
    if (taken.length >= limit) continue
    set.delete(address)
    taken.push(address)
  }
  if (set.size === 0) dirty.delete(chain)
  return taken
}

/** A send that did not land. The address is read again on a later keyframe. */
export function retainAccountDirty(chain: ChainKey, addresses: Iterable<string>): void {
  let set = dirty.get(chain)
  for (const address of addresses) {
    if (!address) continue
    if (!set) {
      set = new Set()
      dirty.set(chain, set)
    }
    set.add(address)
  }
}

export function resetAccountDirty(): void {
  dirty.clear()
}
