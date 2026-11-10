import { expect, test } from "bun:test"
import { tickerFor } from "../shared/source"
import type { AccountResult, Board, ServerStreamMessage, SettlementEvent, You } from "../shared/stream"
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

function socket(address: string | null, sent: ServerStreamMessage[]): MarketSocket {
  const peer = {
    data: { address },
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
