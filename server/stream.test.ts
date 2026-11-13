import { expect, test } from "bun:test"
import type { ChainKey } from "../shared/chain"
import { tickerFor } from "../shared/source"
import type { AccountResult, Board, ServerStreamMessage, SettlementEvent, You } from "../shared/stream"
import { withChain } from "./activeChain"
import { hub, type MarketSocket } from "./hub"
import { MarketStream } from "./stream"

const board: Board = {
  blockStart: 0,
  blockEnd: 10_000,
  windowEndsAt: 10_000,
  phase: "buy-in",
  join: null,
  live: null,
  bands: [],
}

const you: You = {
  address: "me",
  balanceMicros: 9_000_000,
  grantAt: null,
  grantPending: null,
  openBuyIns: [{ roundId: 1, side: "up", stakeMicros: 1_000_000 }],
}

function socket(address: string | null, sent: ServerStreamMessage[], chain?: ChainKey): MarketSocket {
  const peer = {
    data: { address, chain },
    send(raw: string) {
      sent.push(JSON.parse(raw) as ServerStreamMessage)
      return 1
    },
    getBufferedAmount: () => 0,
    close() {},
  } as unknown as MarketSocket
  hub.add(peer)
  return peer
}

function stream(results: AccountResult[] = []) {
  return new MarketStream({
    board: () => board,
    tape: () => [{ t: 1, price: "100" }],
    feed: () => "live",
    ticker: () => tickerFor("binance"),
    handoff: () => null,
    youFor: () => you,
    accountResults: () => results,
  })
}

test("snapshots establish sequence and books publish compact deltas", () => {
  const sent: ServerStreamMessage[] = []
  const peer = socket(null, sent)
  const market = stream()
  market.snapshot(peer)
  market.tick("100", 1, 2, "live")
  market.book(3, "live")
  market.book(4, "live")
  expect(sent.map((message) => message.type)).toEqual(["snapshot", "tick", "book", "book"])
  expect(sent.map((message) => "seq" in message && message.seq)).toEqual([0, 1, 2, 3])
  const first = sent[2]
  const second = sent[3]
  expect(first?.type === "book" && "bands" in first.board).toBe(true)
  expect(second?.type === "book" && "bands" in second.board).toBe(false)
  expect(market.metrics().messages.book?.bytes).toBeGreaterThan(0)
  hub.remove(peer)
})

test("a book on one chain does not gap the other", () => {
  const baseSent: ServerStreamMessage[] = []
  const nearSent: ServerStreamMessage[] = []
  const base = socket(null, baseSent, "base-sepolia")
  const near = socket(null, nearSent, "near-testnet")
  const market = stream()
  try {
    market.snapshot(base)
    market.snapshot(near)
    withChain("base-sepolia", () => {
      market.tick("100", 1, 2, "live")
      market.book(3, "live")
    })
    withChain("near-testnet", () => {
      market.book(4, "live")
    })
    withChain("base-sepolia", () => {
      market.tick("101", 5, 6, "live")
    })
    withChain("near-testnet", () => {
      market.tick("101", 5, 7, "live")
      market.book(8, "live")
    })
    const frames = (sent: ServerStreamMessage[]) =>
      sent.filter((message) => message.type === "tick" || message.type === "book").map((message) => message.seq)
    expect(frames(baseSent)).toEqual([1, 2, 3])
    expect(frames(nearSent)).toEqual([1, 2, 3])
    expect(baseSent.map((message) => message.type)).toEqual(["snapshot", "tick", "book", "tick"])
    expect(nearSent.map((message) => message.type)).toEqual(["snapshot", "book", "tick", "book"])
    expect(baseSent[0]).toMatchObject({ type: "snapshot", seq: 0 })
    expect(nearSent[0]).toMatchObject({ type: "snapshot", seq: 0 })
  } finally {
    hub.remove(base)
    hub.remove(near)
  }
})

test("settlement broadcasts no payouts and sends account results privately", () => {
  const publicSent: ServerStreamMessage[] = []
  const mineSent: ServerStreamMessage[] = []
  const otherSent: ServerStreamMessage[] = []
  const market = stream([{ roundId: 1, status: "settled", resolution: "paid", winningSide: "up", strike: "100", settle: "101", feeMicros: 0, side: "up", stakeMicros: 1_000_000, payoutMicros: 2_000_000 }])
  market.snapshot(socket(null, publicSent))
  market.snapshot(socket("me", mineSent))
  market.snapshot(socket("other", otherSent))
  const event: SettlementEvent = {
    roundId: 1,
    status: "settled",
    resolution: "paid",
    winningSide: "up",
    strike: "100",
    settle: "101",
    feeMicros: 0,
    payouts: [{ address: "me", side: "up", stakeMicros: 1_000_000, payoutMicros: 2_000_000 }],
    balances: [{ address: "me", balanceMicros: 10_000_000 }],
  }
  market.settled(event, 10)
  expect(publicSent.some((message) => "payouts" in message || "balances" in message)).toBe(false)
  expect(mineSent.filter((message) => message.type === "account")).toHaveLength(1)
  expect(otherSent.filter((message) => message.type === "account")).toHaveLength(0)
})

test("settlement does not build an account message for a quiet address", () => {
  let calls = 0
  const market = new MarketStream({
    board: () => board,
    tape: () => [{ t: 1, price: "100" }],
    feed: () => "live",
    ticker: () => tickerFor("binance"),
    handoff: () => null,
    youFor: () => {
      calls += 1
      return you
    },
    accountResults: () => [],
  })
  market.settled(
    {
      roundId: 2,
      status: "settled",
      resolution: "paid",
      winningSide: "up",
      strike: "100",
      settle: "101",
      feeMicros: 0,
      payouts: [{ address: "quiet", side: "up", stakeMicros: 1_000_000, payoutMicros: 2_000_000 }],
      balances: [],
    },
    11,
  )
  expect(calls).toBe(0)
})
