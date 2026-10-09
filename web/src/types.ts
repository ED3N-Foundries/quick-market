export type Side = "up" | "down"

export type Config = {
  roundSeconds: number
  feeBps: number
  betCutoffMs: number
  minStakeMicros: number
}

export type TrayRow = {
  address: string
  side: Side
  stakeMicros: number
}

export type RoundSnapshot = {
  id: number
  startsAt: number
  endsAt: number
  strike: string | null
  status: string
  poolUpMicros: number
  poolDownMicros: number
  playersUp: number
  playersDown: number
  tray: TrayRow[]
}

export type You = {
  address: string
  balanceMicros: number
  openBet: null | { roundId: number; side: Side; stakeMicros: number }
}

export type HistoryRound = {
  id: number
  startsAt: number
  endsAt: number
  strike: string | null
  settle: string | null
  status: string
  feeMicros: number
  winningSide: string | null
  resolution: string | null
  poolUpMicros: number
  poolDownMicros: number
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
