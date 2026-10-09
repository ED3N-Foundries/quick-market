import type { ServerWebSocket } from "bun"

const sockets = new Set<ServerWebSocket<unknown>>()

export const hub = {
  add(ws: ServerWebSocket<unknown>) {
    sockets.add(ws)
  },
  remove(ws: ServerWebSocket<unknown>) {
    sockets.delete(ws)
  },
  broadcast(message: unknown) {
    const data = JSON.stringify(message)
    for (const ws of sockets) {
      try {
        ws.send(data)
      } catch {
        sockets.delete(ws)
      }
    }
  },
}
