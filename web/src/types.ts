export type { PriceSource, PublicConfig as Config } from "../../shared/market"

export type Side = "up" | "down"

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
  status: string
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

export type OpenBuyIn = { roundId: number; side: Side; stakeMicros: number }

export type GrantPending = {
  startedAt: number
  txHash: string | null
  confirmations: number
}

export type You = {
  address: string
  balanceMicros: number
  grantAt: number | null
  grantPending: GrantPending | null
  openBuyIns: OpenBuyIn[]
}

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

export type SettledMessage = {
  type: "settled"
  serverNow: number
  roundId: number
  status: "settled" | "void"
  resolution: "paid" | "refund" | "void"
  winningSide: Side | "push" | null
  strike: string | null
  settle: string | null
  feeMicros: number
  payouts: { address: string; side: Side; stakeMicros: number; payoutMicros: number }[]
  balances: { address: string; balanceMicros: number }[]
}
