import { describe, expect, test } from "bun:test"
import type { Board } from "../../shared/stream"
import {
  acknowledgeOrderTiming,
  completeOrderTiming,
  ORDER_BOOK_TIMEOUT_MS,
  orderTimingExpired,
  startOrderTiming,
} from "./orderLatency"

function board(roundId: number): Board {
  return {
    blockStart: 0,
    blockEnd: 0,
    windowEndsAt: 0,
    phase: "buy-in",
    join: null,
    live: null,
    bands: [{ id: roundId, buyInOpen: 0, strikeAt: 0, settlesAt: 0, strike: null, status: "open", poolUpMicros: 1, poolDownMicros: 0, playersUp: 1, playersDown: 0 }],
  }
}

describe("browser order timing", () => {
  test("measures actual send to ack and ack to a matching book", () => {
    const started = startOrderTiming("request-1", 7, 100)
    expect(completeOrderTiming(started, board(7), 120)).toBeNull()
    const acked = acknowledgeOrderTiming(started, "request-1", 150)!
    expect(acked.ms).toBe(50)
    expect(completeOrderTiming(acked.timing, board(8), 160)).toBeNull()
    expect(completeOrderTiming(acked.timing, board(7), 175)).toBe(25)
  })

  test("rejects stale, duplicate, and backwards reports", () => {
    const started = startOrderTiming("request-1", 7, 100)
    expect(acknowledgeOrderTiming(started, "request-2", 150)).toBeNull()
    expect(acknowledgeOrderTiming(started, "request-1", 90)).toBeNull()
    const acked = acknowledgeOrderTiming(started, "request-1", 150)!
    expect(acknowledgeOrderTiming(acked.timing, "request-1", 160)).toBeNull()
    expect(completeOrderTiming(acked.timing, board(7), 140)).toBeNull()
  })

  test("expires only after an acknowledgement", () => {
    const started = startOrderTiming("request-1", 7, 100)
    expect(orderTimingExpired(started, "request-1", 100_000)).toBe(false)
    const acked = acknowledgeOrderTiming(started, "request-1", 150)!.timing
    expect(orderTimingExpired(acked, "request-2", 150 + ORDER_BOOK_TIMEOUT_MS)).toBe(false)
    expect(orderTimingExpired(acked, "request-1", 150 + ORDER_BOOK_TIMEOUT_MS - 1)).toBe(false)
    expect(orderTimingExpired(acked, "request-1", 150 + ORDER_BOOK_TIMEOUT_MS)).toBe(true)
  })
})
