import type { Side } from "../../shared/stream"

export type { PriceSource, PublicConfig as Config } from "../../shared/market"
export type {
  AccountMessage,
  AccountResult,
  Band,
  Board,
  BoardPatch,
  BookMessage,
  BuyInResultMessage,
  FeedState,
  NearFunding,
  OpenBuyIn,
  PoolCard,
  ServerStreamMessage,
  SettledMessage,
  Side,
  SnapshotMessage,
  TickMessage,
  TrayRow,
  GrantPending,
  You,
} from "../../shared/stream"

export type HistoryRound = {
  id: number
  startsAt: number
  endsAt: number
  strike: string | null
  settle: string | null
  status: string
  winningSide: string | null
  resolution: string | null
  poolUpMicros: number
  poolDownMicros: number
  source: string | null
  mySide?: Side
  myStakeMicros?: number
  myPayoutMicros?: number | null
}
