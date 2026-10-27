import { expect, test } from "bun:test"
import { HUB_BUFFER_LIMIT, publishTo, type HubPeer } from "./hub"

let closed: string[] = []

function peer(id: string, buffered: number, send: HubPeer["send"] = () => 1): HubPeer & { id: string } {
  return {
    id,
    getBufferedAmount: () => buffered,
    send,
    close() {
      closed.push(id)
    },
  }
}

test("a paused reader is closed and the others still get the message", () => {
  closed = []
  const sent: string[] = []
  const peers = new Set<HubPeer & { id: string }>([
    peer("a", 0, () => {
      sent.push("a")
      return 1
    }),
    peer("b", HUB_BUFFER_LIMIT + 1, () => {
      sent.push("b")
      return 1
    }),
    peer("c", HUB_BUFFER_LIMIT, () => {
      sent.push("c")
      return 1
    }),
  ])
  publishTo(peers, "tick")
  expect(sent).toEqual(["a", "c"])
  expect(closed).toEqual(["b"])
  expect([...peers].map((item) => item.id)).toEqual(["a", "c"])
})

test("a dropped frame closes that client", () => {
  closed = []
  const peers = new Set<HubPeer & { id: string }>([
    peer("a", 0, () => 0),
    peer("b", 0, () => {
      throw new Error("closed")
    }),
    peer("c", 0, () => 4),
  ])
  publishTo(peers, "tick")
  expect(closed).toEqual(["a", "b"])
  expect([...peers].map((item) => item.id)).toEqual(["c"])
})
