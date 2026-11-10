import type { Handoff, Ticker } from "../shared/source"
import {
  boardPatch,
  type AccountResult,
  type Board,
  type FeedState,
  type ServerStreamMessage,
  type SettlementEvent,
  type WireTapePoint,
  type You,
} from "../shared/stream"
import { hub, type MarketSocket, type PublishReport } from "./hub"

type StreamDeps = {
  board(): Board
  tape(): WireTapePoint[]
  feed(): FeedState
  ticker(): Ticker
  handoff(): Handoff | null
  youFor(address: string): You | null
  accountResults(address: string): AccountResult[]
}

type MessageMetric = { messages: number; bytes: number; sentBytes: number }

export type StreamMetricSnapshot = {
  messages: Record<string, MessageMetric>
  peers: { sent: number; coalesced: number; recovered: number; closed: number }
  boardBuilds: { count: number; totalMs: number; maxMs: number; lastMs: number }
}

export class MarketStream {
  readonly epoch = crypto.randomUUID()
  private seq = 0
  private previousBoard: Board | null = null
  private messages = new Map<string, MessageMetric>()
  private peers = { sent: 0, coalesced: 0, recovered: 0, closed: 0 }
  private boardBuilds = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 }

  constructor(private deps: StreamDeps) {}

  snapshot(peer: MarketSocket) {
    const address = peer.data.address
    const message: ServerStreamMessage = {
      type: "snapshot",
      epoch: this.epoch,
      seq: this.seq,
      serverNow: Date.now(),
      feed: this.deps.feed(),
      ticker: this.deps.ticker(),
      handoff: this.deps.handoff(),
      board: this.buildBoard(),
      tape: this.deps.tape(),
      ...(address ? { you: this.deps.youFor(address), results: this.deps.accountResults(address) } : {}),
    }
    this.note("snapshot", hub.send(peer, message))
  }

  account(peer: MarketSocket, unauthorized = false) {
    const address = peer.data.address
    const message: ServerStreamMessage = {
      type: "account",
      serverNow: Date.now(),
      you: address && !unauthorized ? this.deps.youFor(address) : null,
      ...(unauthorized ? { unauthorized: true } : address ? { results: this.deps.accountResults(address) } : {}),
    }
    this.note("account", hub.send(peer, message))
  }

  tick(price: string, exchangeTs: number, serverNow: number, feed: FeedState) {
    this.broadcast({ type: "tick", price, exchangeTs, serverNow, feed })
  }

  book(serverNow: number, feed: FeedState) {
    const next = this.buildBoard()
    const message = {
      type: "book" as const,
      serverNow,
      feed,
      ticker: this.deps.ticker(),
      handoff: this.deps.handoff(),
      board: boardPatch(this.previousBoard, next),
    }
    this.previousBoard = next
    this.broadcast(message)
  }

  settled(event: SettlementEvent, serverNow: number) {
    const { payouts, balances: _balances, ...result } = event
    this.broadcast({ type: "settled", serverNow, ...result })
    for (const payout of payouts) {
      const you = this.deps.youFor(payout.address)
      if (!you) continue
      const message: ServerStreamMessage = {
        type: "account",
        serverNow,
        you,
        result: {
          ...result,
          side: payout.side,
          stakeMicros: payout.stakeMicros,
          payoutMicros: payout.payoutMicros,
        },
      }
      this.note("account", hub.sendTo(payout.address, message, (peer) => this.snapshot(peer)))
    }
  }

  metrics(): StreamMetricSnapshot {
    return {
      messages: Object.fromEntries(this.messages),
      peers: { ...this.peers },
      boardBuilds: { ...this.boardBuilds },
    }
  }

  private buildBoard(): Board {
    const started = performance.now()
    const board = this.deps.board()
    const elapsed = performance.now() - started
    this.boardBuilds.count += 1
    this.boardBuilds.totalMs += elapsed
    this.boardBuilds.maxMs = Math.max(this.boardBuilds.maxMs, elapsed)
    this.boardBuilds.lastMs = elapsed
    return board
  }

  private broadcast<T extends { type: string; serverNow: number }>(message: T) {
    const framed = { ...message, epoch: this.epoch, seq: ++this.seq }
    this.note(message.type, hub.broadcast(framed, (peer) => this.snapshot(peer)))
  }

  private note(type: string, report: PublishReport) {
    const current = this.messages.get(type) ?? { messages: 0, bytes: 0, sentBytes: 0 }
    current.messages += 1
    current.bytes += report.bytes
    current.sentBytes += report.sentBytes
    this.messages.set(type, current)
    this.peers.sent += report.sent
    this.peers.coalesced += report.coalesced
    this.peers.recovered += report.recovered
    this.peers.closed += report.closed
  }
}
