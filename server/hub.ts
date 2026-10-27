import type { ServerWebSocket } from "bun"

const sockets = new Set<ServerWebSocket<unknown>>()

/** Unread bytes past this mean the tab stopped reading. Close it so resume starts from a fresh round. */
export const HUB_BUFFER_LIMIT = 256 * 1024

export type HubPeer = {
  getBufferedAmount(): number
  send(data: string): number | void
  close(): void
}

export function publishTo<T extends HubPeer>(peers: Set<T>, data: string, limit = HUB_BUFFER_LIMIT) {
  for (const peer of [...peers]) {
    let buffered = 0
    try {
      buffered = peer.getBufferedAmount()
    } catch {
      peers.delete(peer)
      try {
        peer.close()
      } catch {
        peers.delete(peer)
      }
      continue
    }
    if (buffered > limit) {
      peers.delete(peer)
      try {
        peer.close()
      } catch {
        peers.delete(peer)
      }
      continue
    }
    try {
      const status = peer.send(data)
      if (status !== 0) continue
    } catch {
      // The socket is already dead. Close it so the page opens a new one.
    }
    peers.delete(peer)
    try {
      peer.close()
    } catch {
      peers.delete(peer)
    }
  }
}

export const hub = {
  add(ws: ServerWebSocket<unknown>) {
    sockets.add(ws)
  },
  remove(ws: ServerWebSocket<unknown>) {
    sockets.delete(ws)
  },
  broadcast(message: unknown) {
    publishTo(sockets, JSON.stringify(message))
  },
}
