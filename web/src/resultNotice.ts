import type { Board, OpenBuyIn, SettledMessage, Side } from "./types"

/** How long the loading card stays up when the server has not answered. */
export const SETTLING_MS = 15_000
/** How long the result stays up after it replaces the loading card. */
export const RESULT_MS = 4_500

export type ResultTone = "credit" | "debit" | "push" | "void"

export type MarketNotice =
  | { kind: "settling"; roundId: number; side: Side; stakeMicros: number; openedAt: number }
  | { kind: "result"; roundId: number; tone: ResultTone; amountMicros: number; shownAt: number }

export type NoticeState = {
  cards: MarketNotice[]
  /** Rounds that already opened a card, so a tick cannot open a second settling card. */
  seen: number[]
}

export type DueBuyIn = OpenBuyIn & { settlesAt: number }

export function emptyNotices(): NoticeState {
  return { cards: [], seen: [] }
}

function settlesAtOf(board: Board, roundId: number): number | null {
  if (board.live?.id === roundId) return board.live.settlesAt
  if (board.join?.id === roundId) return board.join.settlesAt
  return board.bands.find((band) => band.id === roundId)?.settlesAt ?? null
}

/** Open buy-ins whose settle time is already on the board. */
export function dueBuyIns(board: Board | null, openBuyIns: readonly OpenBuyIn[]): DueBuyIn[] {
  if (!board) return []
  const due: DueBuyIn[] = []
  for (const bet of openBuyIns) {
    const settlesAt = settlesAtOf(board, bet.roundId)
    if (settlesAt == null) continue
    due.push({ roundId: bet.roundId, side: bet.side, stakeMicros: bet.stakeMicros, settlesAt })
  }
  return due
}

export function resultTone(resolution: string, winningSide: string | null, payoutMicros: number): ResultTone {
  if (resolution === "void") return "void"
  if (winningSide === "push") return "push"
  if (payoutMicros <= 0) return "debit"
  return "credit"
}

/** Credited shows the payout. Deducted, push, and void show the stake. */
export function resultAmount(tone: ResultTone, stakeMicros: number, payoutMicros: number): number {
  return tone === "credit" ? payoutMicros : stakeMicros
}

function seenWith(seen: readonly number[], roundId: number): number[] {
  return seen.includes(roundId) ? (seen as number[]) : [...seen, roundId]
}

/**
 * Open one settling card per buy-in once `clockNow` reaches its settle time.
 * `wallNow` stamps the card, because the dismiss timer follows the machine clock.
 * A card that has been up for SETTLING_MS without a result is dropped.
 */
export function tickNotices(state: NoticeState, bets: readonly DueBuyIn[], clockNow: number, wallNow: number): NoticeState {
  let cards = state.cards
  const live = cards.filter((card) => card.kind !== "settling" || wallNow - card.openedAt < SETTLING_MS)
  if (live.length !== cards.length) cards = live
  let seen = state.seen
  for (const bet of bets) {
    if (clockNow < bet.settlesAt) continue
    if (seen.includes(bet.roundId) || cards.some((card) => card.roundId === bet.roundId)) continue
    if (cards === state.cards) cards = cards.slice()
    cards.push({
      kind: "settling",
      roundId: bet.roundId,
      side: bet.side,
      stakeMicros: bet.stakeMicros,
      openedAt: wallNow,
    })
    seen = seenWith(seen, bet.roundId)
  }
  if (cards === state.cards && seen === state.seen) return state
  return { cards, seen }
}

/** The server result replaces a settling card, or stands alone when it arrives first. */
export function settleNotice(state: NoticeState, message: SettledMessage, address: string, wallNow: number): NoticeState {
  const mine = message.payouts.find((payout) => payout.address === address)
  if (!mine) return state
  const existing = state.cards.find((card) => card.roundId === message.roundId)
  if (existing?.kind === "result") return state
  const tone = resultTone(message.resolution, message.winningSide, mine.payoutMicros)
  const result: MarketNotice = {
    kind: "result",
    roundId: message.roundId,
    tone,
    amountMicros: resultAmount(tone, mine.stakeMicros, mine.payoutMicros),
    shownAt: wallNow,
  }
  const cards = existing
    ? state.cards.map((card) => (card.roundId === message.roundId ? result : card))
    : [...state.cards, result]
  return { cards, seen: seenWith(state.seen, message.roundId) }
}

export function dismissRound(state: NoticeState, roundId: number): NoticeState {
  const cards = state.cards.filter((card) => card.roundId !== roundId)
  if (cards.length === state.cards.length) return state
  return { cards, seen: state.seen }
}
