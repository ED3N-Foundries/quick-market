import type { Handoff, Ticker } from "../shared/source"
import {
  boardPatch,
  type AccountResult,
  type Board,
  type FeedState,
  type NearFunding,
  type ServerStreamMessage,
  type SettlementEvent,
  type WireTapePoint,
  type You,
} from "../shared/stream"
import type { ChainKey } from "../shared/chain"
import { activeChainKey, withChain } from "./activeChain"
import { hub, type MarketSocket, type PublishReport } from "./hub"

type StreamDeps = {
  board(): Board
  tape(): WireTapePoint[]
  feed(): FeedState
  ticker(): Ticker
  handoff(): Handoff | null
  youFor(address: string): You | null
  accountResults(address: string): AccountResult[]
  nearFunding(): NearFunding
}

type MessageMetric = { messages: number; bytes: number; sentBytes: number }

export type StreamMetricSnapshot = {
  messages: Record<string, MessageMetric>
  peers: { sent: number; coalesced: number; recovered: number; closed: number }
  boardBuilds: { count: number; totalMs: number; maxMs: number; lastMs: number }
}

export class MarketStream {
  readonly epoch = crypto.randomUUID()
  /** Book, tick, and settlement frames for one chain share a counter. A NEAR frame must not open a gap on a Base socket. */
  private seqs = new Map<ChainKey, number>()
  private previousBoards = new Map<ChainKey, Board | null>()
  private messages = new Map<string, MessageMetric>()
  private peers = { sent: 0, coalesced: 0, recovered: 0, closed: 0 }
  private boardBuilds = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 }

  constructor(private deps: StreamDeps) {}

  snapshot(peer: MarketSocket) {
    if (peer.data.chain) return withChain(peer.data.chain, () => this.writeSnapshot(peer))
    return this.writeSnapshot(peer)
  }

  private writeSnapshot(peer: MarketSocket) {
    const address = peer.data.address
    const message: ServerStreamMessage = {
      type: "snapshot",
      epoch: this.epoch,
      seq: this.currentSeq(activeChainKey()),
      serverNow: Date.now(),
      feed: this.deps.feed(),
      ticker: this.deps.ticker(),
      handoff: this.deps.handoff(),
      board: this.buildBoard(),
      tape: this.deps.tape(),
      nearFunding: this.deps.nearFunding(),
      ...(address ? { you: this.deps.youFor(address), results: this.deps.accountResults(address) } : {}),
    }
    this.note("snapshot", hub.send(peer, message))
  }

  account(peer: MarketSocket, unauthorized = false) {
    if (peer.data.chain) return withChain(peer.data.chain, () => this.writeAccount(peer, unauthorized))
    return this.writeAccount(peer, unauthorized)
  }

  private writeAccount(peer: MarketSocket, unauthorized = false) {
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
    this.broadcast({ type: "tick", price, exchangeTs, serverNow, feed }, activeChainKey())
  }

  book(serverNow: number, feed: FeedState) {
    const chain = activeChainKey()
    const next = this.buildBoard()
    const message = {
      type: "book" as const,
      serverNow,
      feed,
      ticker: this.deps.ticker(),
      handoff: this.deps.handoff(),
      board: boardPatch(this.previousBoards.get(chain) ?? null, next),
    }
    this.previousBoards.set(chain, next)
    this.broadcast(message, chain)
  }

  settled(event: SettlementEvent, serverNow: number) {
    const { payouts, balances: _balances, ...result } = event
    const chain = activeChainKey()
    this.broadcast({ type: "settled", serverNow, ...result }, chain)
    for (const payout of payouts) {
      if (!hub.connected(payout.address, chain)) continue
      const message: ServerStreamMessage = {
        type: "account",
        serverNow,
        you: null,
        result: {
          ...result,
          side: payout.side,
          stakeMicros: payout.stakeMicros,
          payoutMicros: payout.payoutMicros,
          ...(typeof payout.balanceMicros === "number" ? { balanceMicros: payout.balanceMicros } : {}),
        },
      }
      this.note("account", hub.sendTo(payout.address, message, (peer) => this.snapshot(peer), activeChainKey(), true))
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

  private currentSeq(chain: ChainKey): number {
    return this.seqs.get(chain) ?? 0
  }

  private bumpSeq(chain: ChainKey): number {
    const next = this.currentSeq(chain) + 1
    this.seqs.set(chain, next)
    return next
  }

  private broadcast<T extends { type: string; serverNow: number }>(message: T, chain: ChainKey | null) {
    const key = chain ?? activeChainKey()
    const framed = { ...message, epoch: this.epoch, seq: this.bumpSeq(key) }
    this.note(
      message.type,
      hub.broadcast(framed, (peer) => this.snapshot(peer), (peer) => peer.data.chain == null || peer.data.chain === key),
    )
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
