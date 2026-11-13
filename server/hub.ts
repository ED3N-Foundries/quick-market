import type { ServerWebSocket } from "bun"
import type { ChainKey } from "../shared/chain"

export const HUB_BUFFER_LIMIT = 256 * 1024
const RECOVER_BUFFER_LIMIT = 16 * 1024
const COALESCE_BUFFER_LIMIT = 64 * 1024

export type SocketData = { address: string | null; chain: ChainKey }
export type MarketSocket = ServerWebSocket<SocketData>

export type HubPeer = {
  data?: SocketData
  getBufferedAmount(): number
  send(data: string, compress?: boolean): number | void
  close(): void
}

export type PublishReport = {
  bytes: number
  sentBytes: number
  sent: number
  coalesced: number
  recovered: number
  closed: number
}

type PublishOptions = {
  limit?: number
  compress?: boolean
  recover?: (peer: MarketSocket) => void
  filter?: (peer: MarketSocket) => boolean
  /** Deliver this frame even while ticks are being coalesced. A credit must not wait on a snapshot. */
  priority?: boolean
}

const recovery = new WeakMap<HubPeer, boolean>()

function report(bytes: number): PublishReport {
  return { bytes, sentBytes: 0, sent: 0, coalesced: 0, recovered: 0, closed: 0 }
}

function closePeer<T extends HubPeer>(peers: Set<T>, peer: T, result: PublishReport) {
  peers.delete(peer)
  recovery.delete(peer)
  result.closed += 1
  try {
    peer.close()
  } catch {
    peers.delete(peer)
  }
}

export function publishTo<T extends HubPeer>(peers: Set<T>, data: string, options: PublishOptions = {}): PublishReport {
  const result = report(Buffer.byteLength(data))
  const limit = options.limit ?? HUB_BUFFER_LIMIT
  const compress = options.compress ?? result.bytes >= 1024
  for (const peer of [...peers]) {
    if (options.filter && !options.filter(peer as T & MarketSocket)) continue
    let buffered = 0
    try {
      buffered = peer.getBufferedAmount()
    } catch {
      closePeer(peers, peer, result)
      continue
    }
    if (buffered > limit) {
      closePeer(peers, peer, result)
      continue
    }
    if (!options.priority && recovery.get(peer)) {
      if (buffered > RECOVER_BUFFER_LIMIT || !options.recover) {
        result.coalesced += 1
        continue
      }
      recovery.delete(peer)
      result.recovered += 1
      options.recover(peer as T & MarketSocket)
      continue
    }
    if (!options.priority && buffered > COALESCE_BUFFER_LIMIT) {
      recovery.set(peer, true)
      result.coalesced += 1
      continue
    }
    try {
      const status = peer.send(data, compress)
      if (status === 0 && !options.priority) {
        recovery.set(peer, true)
        result.coalesced += 1
        continue
      }
      if (status === 0) {
        result.coalesced += 1
        continue
      }
      result.sent += 1
      result.sentBytes += result.bytes
    } catch {
      closePeer(peers, peer, result)
    }
  }
  return result
}

const sockets = new Set<MarketSocket>()

export const hub = {
  add(ws: MarketSocket) {
    sockets.add(ws)
  },
  remove(ws: MarketSocket) {
    sockets.delete(ws)
    recovery.delete(ws)
  },
  broadcast(message: unknown, recover: (peer: MarketSocket) => void, filter?: (peer: MarketSocket) => boolean) {
    return publishTo(sockets, JSON.stringify(message), { recover, filter })
  },
  send(ws: MarketSocket, message: unknown, priority = false) {
    return publishTo(new Set([ws]), JSON.stringify(message), priority ? { priority: true } : {})
  },
  sockets() {
    return [...sockets]
  },
  sendTo(address: string, message: unknown, recover: (peer: MarketSocket) => void, chain?: ChainKey, priority = false) {
    return publishTo(sockets, JSON.stringify(message), {
      recover,
      priority,
      filter: (peer) => sameAccount(peer, address, chain),
    })
  },
  connected(address: string, chain?: ChainKey) {
    for (const peer of sockets) {
      if (sameAccount(peer, address, chain)) return true
    }
    return false
  },
}

function sameAccount(peer: MarketSocket, address: string, chain?: ChainKey): boolean {
  return peer.data.address === address && (chain === undefined || peer.data.chain == null || peer.data.chain === chain)
}
