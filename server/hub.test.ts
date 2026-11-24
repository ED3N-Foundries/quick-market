import { expect, test } from "bun:test"
import { HUB_BUFFER_LIMIT, publishTo, WS_COMPRESS_MIN_BYTES, type HubPeer, type MarketSocket } from "./hub"

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
    peer("b", HUB_BUFFER_LIMIT + 1),
    peer("c", HUB_BUFFER_LIMIT, () => {
      sent.push("c")
      return 1
    }),
  ])
  publishTo(peers, "tick")
  expect(sent).toEqual(["a"])
  expect(closed).toEqual(["b"])
  expect([...peers].map((item) => item.id)).toEqual(["a", "c"])
})

test("a dropped frame is coalesced and recovered with a snapshot", () => {
  closed = []
  let sent = 0
  const slow = peer("slow", 0, () => {
    sent += 1
    return sent === 1 ? 0 : 1
  })
  const peers = new Set([slow])
  let recovered = 0
  const recover = () => {
    recovered += 1
  }
  expect(publishTo(peers, "one", { recover }).coalesced).toBe(1)
  expect(publishTo(peers, "two", { recover }).recovered).toBe(1)
  expect(recovered).toBe(1)
  expect(sent).toBe(1)
  expect(publishTo(peers, "three", { recover }).sent).toBe(1)
  expect(closed).toEqual([])
})

test("a buffered slow reader skips deltas until its recovery snapshot", () => {
  closed = []
  let buffered = 70_000
  const sent: string[] = []
  const slow = peer("slow", 0, (data) => {
    sent.push(data)
    return 1
  })
  slow.getBufferedAmount = () => buffered
  const peers = new Set([slow])
  const recover = (target: MarketSocket) => {
    expect(target).toBe(slow as unknown as MarketSocket)
    buffered = 0
  }
  expect(publishTo(peers, "one", { recover }).coalesced).toBe(1)
  buffered = 10_000
  expect(publishTo(peers, "two", { recover }).recovered).toBe(1)
  expect(sent).toEqual([])
})

test("a priority frame is sent while ticks are coalesced", () => {
  closed = []
  let calls = 0
  const sent: string[] = []
  const slow = peer("slow", 70_000, (data) => {
    calls += 1
    sent.push(data)
    return 1
  })
  const peers = new Set([slow])
  let recovered = 0
  const recover = () => {
    recovered += 1
  }
  expect(publishTo(peers, "tick", { recover }).coalesced).toBe(1)
  expect(publishTo(peers, "credit", { recover, priority: true }).sent).toBe(1)
  expect(sent).toEqual(["credit"])
  expect(recovered).toBe(0)
  slow.getBufferedAmount = () => 0
  expect(publishTo(peers, "tick-2", { recover }).recovered).toBe(1)
  expect(recovered).toBe(1)
  expect(sent).toEqual(["credit"])
})

test("a send failure closes only that client", () => {
  closed = []
  const peers = new Set<HubPeer & { id: string }>([
    peer("a", 0, () => {
      throw new Error("closed")
    }),
    peer("b", 0, () => 4),
  ])
  const result = publishTo(peers, "tick")
  expect(closed).toEqual(["a"])
  expect(result.sent).toBe(1)
  expect([...peers].map((item) => item.id)).toEqual(["b"])
})

test("compression is offered only at the configured threshold", () => {
  closed = []
  const offered: boolean[] = []
  const peers = new Set([
    peer("a", 0, (_data, compress) => {
      offered.push(Boolean(compress))
      return 1
    }),
  ])
  publishTo(peers, "x".repeat(WS_COMPRESS_MIN_BYTES - 1))
  publishTo(peers, "x".repeat(WS_COMPRESS_MIN_BYTES))
  expect(offered).toEqual([false, true])
})
