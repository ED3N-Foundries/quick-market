import { expect, test } from "bun:test"
import { comparePrice } from "./money"
import { settleRound, type BuyInInput } from "./settle"

const USDC = 1_000_000

function bet(address: string, side: "up" | "down", stake: number): BuyInInput {
  return { address, side, stakeMicros: stake }
}

test("comparePrice treats trailing zeros as equal", () => {
  expect(comparePrice("100.10", "100.1")).toBe(0)
  expect(comparePrice("100.11", "100.1")).toBe(1)
  expect(comparePrice("99.9", "100")).toBe(-1)
})

test("winners split the pot after a 25 bps fee", () => {
  const result = settleRound({
    bets: [bet("you", "up", 50 * USDC), bet("other", "up", 50 * USDC), bet("down", "down", 100 * USDC)],
    strike: "100",
    settle: "101",
    feeBps: 25,
    stale: false,
  })
  expect(result.resolution).toBe("paid")
  expect(result.winningSide).toBe("up")
  expect(result.feeMicros).toBe(0.5 * USDC)
  const you = result.payouts.find((payout) => payout.address === "you")
  expect(you?.payoutMicros).toBe(99.75 * USDC)
  expect(result.payouts.find((payout) => payout.address === "down")?.payoutMicros).toBe(0)
  const paid = result.payouts.reduce((sum, payout) => sum + payout.payoutMicros, 0)
  expect(paid + result.feeMicros).toBe(200 * USDC)
})

test("a single winner takes the other side minus the fee", () => {
  const result = settleRound({
    bets: [bet("up", "up", 100 * USDC), bet("down", "down", 50 * USDC)],
    strike: "100",
    settle: "99",
    feeBps: 25,
    stale: false,
  })
  expect(result.winningSide).toBe("down")
  expect(result.feeMicros).toBe(375_000)
  expect(result.payouts.find((payout) => payout.side === "down")?.payoutMicros).toBe(150_000_000 - 375_000)
  expect(result.payouts.find((payout) => payout.side === "up")?.payoutMicros).toBe(0)
})

test("a tie refunds both sides with no fee", () => {
  const result = settleRound({
    bets: [bet("up", "up", 10 * USDC), bet("down", "down", 4 * USDC)],
    strike: "100.10",
    settle: "100.1",
    feeBps: 25,
    stale: false,
  })
  expect(result.resolution).toBe("refund")
  expect(result.winningSide).toBe("push")
  expect(result.feeMicros).toBe(0)
  expect(result.payouts.every((payout) => payout.payoutMicros === payout.stakeMicros)).toBe(true)
})

test("an empty side refunds the other side", () => {
  const result = settleRound({
    bets: [bet("up", "up", 10 * USDC)],
    strike: "100",
    settle: "110",
    feeBps: 25,
    stale: false,
  })
  expect(result.resolution).toBe("refund")
  expect(result.winningSide).toBe("up")
  expect(result.feeMicros).toBe(0)
  expect(result.payouts[0]?.payoutMicros).toBe(10 * USDC)
})

test("a stale print voids the round", () => {
  const result = settleRound({
    bets: [bet("up", "up", 10 * USDC), bet("down", "down", 10 * USDC)],
    strike: "100",
    settle: "110",
    feeBps: 25,
    stale: true,
  })
  expect(result.resolution).toBe("void")
  expect(result.winningSide).toBeNull()
  expect(result.settle).toBeNull()
  expect(result.payouts.every((payout) => payout.payoutMicros === payout.stakeMicros)).toBe(true)
})

test("rounding dust stays unpaid", () => {
  const result = settleRound({
    bets: [
      bet("a", "up", 1),
      bet("b", "up", 1),
      bet("c", "up", 1),
      bet("d", "down", 7),
    ],
    strike: "1",
    settle: "2",
    feeBps: 0,
    stale: false,
  })
  const paid = result.payouts.reduce((sum, payout) => sum + payout.payoutMicros, 0)
  expect(result.feeMicros).toBe(0)
  expect(paid).toBe(9)
  expect(10 - paid - result.feeMicros).toBe(1)
})
