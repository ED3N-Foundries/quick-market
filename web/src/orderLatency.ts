import type { Board } from "../../shared/stream"

export const ORDER_BOOK_TIMEOUT_MS = 5_000

export type OrderTiming = {
  requestId: string
  roundId: number
  sentAt: number
  ackAt: number | null
}

export function startOrderTiming(requestId: string, roundId: number, sentAt: number): OrderTiming {
  return { requestId, roundId, sentAt, ackAt: null }
}

export function acknowledgeOrderTiming(
  current: OrderTiming | null,
  requestId: string,
  now: number,
): { timing: OrderTiming; ms: number } | null {
  if (!current || current.requestId !== requestId || current.ackAt !== null || now < current.sentAt) return null
  return { timing: { ...current, ackAt: now }, ms: now - current.sentAt }
}

export function boardHasRound(board: Board, roundId: number): boolean {
  return board.join?.id === roundId || board.live?.id === roundId || board.bands.some((band) => band.id === roundId)
}

export function completeOrderTiming(current: OrderTiming | null, board: Board, now: number): number | null {
  if (!current || current.ackAt === null || !boardHasRound(board, current.roundId) || now < current.ackAt) return null
  return now - current.ackAt
}

export function orderTimingExpired(current: OrderTiming | null, requestId: string, now: number): boolean {
  return current?.requestId === requestId && current.ackAt !== null && now - current.ackAt >= ORDER_BOOK_TIMEOUT_MS
}
