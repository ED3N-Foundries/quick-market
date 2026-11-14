import type { Handoff, Ticker } from "./source"

export type Side = "up" | "down"
export type FeedState = "live" | "stale"

export type TrayRow = {
  address: string
  side: Side
  stakeMicros: number
}

export type Band = {
  id: number
  buyInOpen: number
  strikeAt: number
  settlesAt: number
  strike: string | null
  status: "open" | "settled" | "void"
  poolUpMicros: number
  poolDownMicros: number
  playersUp: number
  playersDown: number
}

export type PoolCard = Band & { tray: TrayRow[] }

export type Board = {
  blockStart: number
  blockEnd: number
  windowEndsAt: number
  phase: "buy-in" | "market"
  join: PoolCard | null
  live: PoolCard | null
  bands: Band[]
}

export type BoardPatch = Pick<Board, "blockStart" | "blockEnd" | "windowEndsAt" | "phase"> & {
  join?: PoolCard | null
  live?: PoolCard | null
  bands?: Band[]
  removeBandIds?: number[]
}

export type OpenBuyIn = { roundId: number; side: Side; stakeMicros: number }

export type GrantPending = {
  startedAt: number
  txHash: string | null
  /** How many of `confirmations` the server has seen. 0 as soon as the grant is claimed. */
  seen: number
  confirmations: number
}

export type You = {
  address: string
  balanceMicros: number
  grantAt: number | null
  grantPending: GrantPending | null
  openBuyIns: OpenBuyIn[]
}

export type WireTapePoint = { t: number; price: string }

export type PublicSettlement = {
  roundId: number
  status: "settled" | "void"
  resolution: "paid" | "refund" | "void"
  winningSide: Side | "push" | null
  strike: string | null
  settle: string | null
  feeMicros: number
}

export type SettlementPayout = {
  address: string
  side: Side
  stakeMicros: number
  payoutMicros: number
  /** New spendable balance after this payout. Private account frames only. */
  balanceMicros?: number
}

export type SettlementEvent = PublicSettlement & {
  payouts: SettlementPayout[]
  balances: { address: string; balanceMicros: number }[]
}

export type AccountResult = PublicSettlement & {
  side: Side
  stakeMicros: number
  payoutMicros: number
  /** Spendable balance after this round. Set on the settlement push. */
  balanceMicros?: number
}

type PublicFrame = {
  epoch: string
  seq: number
  serverNow: number
}

export type SnapshotMessage = PublicFrame & {
  type: "snapshot"
  feed: FeedState
  ticker: Ticker
  handoff: Handoff | null
  board: Board
  tape: WireTapePoint[]
  you?: You | null
  results?: AccountResult[]
}

export type TickMessage = PublicFrame & {
  type: "tick"
  price: string
  exchangeTs: number
  feed: FeedState
}

export type BookMessage = PublicFrame & {
  type: "book"
  feed: FeedState
  ticker: Ticker
  handoff: Handoff | null
  board: BoardPatch
}

export type SettledMessage = PublicFrame & {
  type: "settled"
} & PublicSettlement

export type AccountMessage = {
  type: "account"
  serverNow: number
  you: You | null
  unauthorized?: boolean
  result?: AccountResult
  results?: AccountResult[]
}

export type BuyInResultMessage = {
  type: "buy-in-result"
  requestId: string
  ok: boolean
  you?: You
  error?: string
  code?: string
}

export type ServerStreamMessage =
  | SnapshotMessage
  | TickMessage
  | BookMessage
  | SettledMessage
  | AccountMessage
  | BuyInResultMessage
  | { type: "lag"; t: number; serverRecv: number; serverNow: number }

export type ClientStreamMessage =
  | { type: "hello"; token?: string }
  | { type: "resync" }
  | { type: "account" }
  | { type: "lag"; t: number }
  | { type: "order-latency"; requestId: string; kind: "ack" | "book" | "missing"; ms?: number }
  | { type: "buy-in"; requestId: string; side: Side; stake: string; roundId: number }

export function boardPatch(previous: Board | null, next: Board): BoardPatch {
  const patch: BoardPatch = {
    blockStart: next.blockStart,
    blockEnd: next.blockEnd,
    windowEndsAt: next.windowEndsAt,
    phase: next.phase,
  }
  if (!previous || JSON.stringify(previous.join) !== JSON.stringify(next.join)) patch.join = next.join
  if (!previous || JSON.stringify(previous.live) !== JSON.stringify(next.live)) patch.live = next.live
  const oldBands = new Map((previous?.bands ?? []).map((band) => [band.id, band]))
  const changed = next.bands.filter((band) => JSON.stringify(oldBands.get(band.id)) !== JSON.stringify(band))
  if (changed.length > 0 || !previous) patch.bands = changed
  const nextIds = new Set(next.bands.map((band) => band.id))
  const removed = (previous?.bands ?? []).filter((band) => !nextIds.has(band.id)).map((band) => band.id)
  if (removed.length > 0) patch.removeBandIds = removed
  return patch
}
