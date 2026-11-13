import type { ChainKey } from "../shared/chain"
import type { You } from "../shared/stream"
import { withChain } from "./activeChain"
import { accountDirtyCount, dropAccountDirty, resetAccountDirty, retainAccountDirty, takeAccountDirty } from "./accountDirty"
import { pushSessions, type PushSession } from "./accountPush"
import { hub, type MarketSocket } from "./hub"
import { youFor } from "./rounds"

/** One private account frame per chain. A quiet slot sends nothing. */
export const KEYFRAME_MS = 1_000
export const KEYFRAME_CAP = 32

const lastPump = new Map<ChainKey, number>()
const socketFp = new WeakMap<MarketSocket, { address: string; fp: string }>()

export function resetAccountKeyframe(): void {
  lastPump.clear()
  resetAccountDirty()
}

/** Balance, grant, and open buy-ins. Address is the listener key, not part of the body. */
export function accountFingerprint(you: You): string {
  const pending = you.grantPending
  const grant = pending ? `${pending.startedAt}\t${pending.txHash ?? ""}\t${pending.seen}\t${pending.confirmations}` : ""
  const bets = [...you.openBuyIns]
    .map((bet) => `${bet.roundId}:${bet.side}:${bet.stakeMicros}`)
    .sort()
    .join(",")
  return `${you.balanceMicros}|${you.grantAt ?? ""}|${grant}|${bets}`
}

function listens(peer: MarketSocket, address: string, chain: ChainKey): boolean {
  return peer.data.address === address && (peer.data.chain == null || peer.data.chain === chain)
}

type Item = {
  address: string
  you: You
  fp: string
  sockets: MarketSocket[]
  sessions: PushSession[]
}

function deliverSocket(peer: MarketSocket, you: You, now: number): boolean {
  const report = hub.send(peer, { type: "account", serverNow: now, you }, true)
  return report.sent === 1
}

/**
 * Send one account now. Grant progress must not wait for the one-second keyframe.
 * A failed send stays dirty so the keyframe retries it.
 */
export function pushAccountNow(chain: ChainKey, address: string, now = Date.now()): void {
  withChain(chain, () => {
    const sockets = hub.sockets().filter((peer) => listens(peer, address, chain))
    const sessions = pushSessions(chain).filter((session) => session.addresses().includes(address))
    if (sockets.length === 0 && sessions.length === 0) return
    let you: You | null
    try {
      you = youFor(address)
    } catch (error) {
      console.error(error)
      return
    }
    if (!you) {
      dropAccountDirty(chain, address)
      return
    }
    const fp = accountFingerprint(you)
    let failed = false
    for (const peer of sockets) {
      const prior = socketFp.get(peer)
      if (prior && prior.address === address && prior.fp === fp) continue
      if (!deliverSocket(peer, you, now)) {
        failed = true
        continue
      }
      socketFp.set(peer, { address, fp })
    }
    for (const session of sessions) {
      if (session.fingerprint(address) === fp) continue
      let accepted = false
      try {
        accepted = session.notify({ serverNow: now, yous: [you] })
      } catch (error) {
        console.error(error)
      }
      if (!accepted) failed = true
      else session.remember(address, fp)
    }
    if (failed) retainAccountDirty(chain, [address])
    else dropAccountDirty(chain, address)
  })
}

/**
 * Read dirty accounts that have a listener and send each a private `account` frame.
 * At most once a second, and at most {@link KEYFRAME_CAP} reads, so settlement is not stalled.
 * The frame has no public sequence number.
 */
export function pumpAccountKeyframe(chain: ChainKey, now: number): void {
  withChain(chain, () => {
    if (accountDirtyCount(chain) === 0) return
    const last = lastPump.get(chain)
    if (last !== undefined && now - last < KEYFRAME_MS) return
    lastPump.set(chain, now)

    const sockets = hub.sockets()
    const sessions = pushSessions(chain)
    const bySession = new Map<string, PushSession[]>()
    for (const session of sessions) {
      for (const address of session.addresses()) {
        const list = bySession.get(address)
        if (list) list.push(session)
        else bySession.set(address, [session])
      }
    }
    const hasListener = (address: string) =>
      bySession.has(address) || sockets.some((peer) => listens(peer, address, chain))
    const taken = takeAccountDirty(chain, hasListener, KEYFRAME_CAP)
    const failed = new Set<string>()
    const items: Item[] = []
    for (const address of taken) {
      let you: You | null
      try {
        you = youFor(address)
      } catch (error) {
        console.error(error)
        failed.add(address)
        continue
      }
      if (!you) continue
      const fp = accountFingerprint(you)
      const bound = sockets.filter((peer) => listens(peer, address, chain))
      const interested = bySession.get(address) ?? []
      const pendingSockets = bound.filter((peer) => {
        const prior = socketFp.get(peer)
        return !prior || prior.address !== address || prior.fp !== fp
      })
      const pendingSessions = interested.filter((session) => session.fingerprint(address) !== fp)
      if (pendingSockets.length === 0 && pendingSessions.length === 0) continue
      items.push({ address, you, fp, sockets: pendingSockets, sessions: pendingSessions })
    }

    for (const item of items) {
      for (const peer of item.sockets) {
        if (!deliverSocket(peer, item.you, now)) {
          failed.add(item.address)
          continue
        }
        socketFp.set(peer, { address: item.address, fp: item.fp })
      }
    }

    const groups = new Map<PushSession, Item[]>()
    for (const item of items) {
      for (const session of item.sessions) {
        const list = groups.get(session)
        if (list) list.push(item)
        else groups.set(session, [item])
      }
    }
    for (const [session, batch] of groups) {
      let accepted = false
      try {
        accepted = session.notify({ serverNow: now, yous: batch.map((item) => item.you) })
      } catch (error) {
        console.error(error)
        accepted = false
      }
      if (!accepted) {
        for (const item of batch) failed.add(item.address)
        continue
      }
      for (const item of batch) session.remember(item.address, item.fp)
    }
    retainAccountDirty(chain, failed)
  })
}
