import { expect, test } from "bun:test"
import {
  dismissRound,
  dueBuyIns,
  emptyNotices,
  resultAmount,
  resultTone,
  stakeCameBack,
  settleNotice,
  SETTLING_MS,
  tickNotices,
} from "./resultNotice"
import type { Board, SettledMessage } from "./types"

function bet(roundId: number, settlesAt: number, stakeMicros = 10_000_000) {
  return { roundId, side: "up" as const, stakeMicros, settlesAt }
}

function message(over: Partial<SettledMessage> = {}): SettledMessage {
  return {
    type: "settled",
    serverNow: 20_000,
    roundId: 1,
    status: "settled",
    resolution: "paid",
    winningSide: "up",
    strike: "100",
    settle: "101",
    feeMicros: 0,
    payouts: [{ address: "me", side: "up", stakeMicros: 10_000_000, payoutMicros: 18_500_000 }],
    balances: [],
    ...over,
  }
}

function board(): Board {
  const band = {
    id: 1,
    buyInOpen: 0,
    strikeAt: 10_000,
    settlesAt: 20_000,
    strike: "100",
    status: "open",
    poolUpMicros: 10,
    poolDownMicros: 10,
    playersUp: 1,
    playersDown: 1,
  }
  return {
    blockStart: 10_000,
    blockEnd: 20_000,
    windowEndsAt: 20_000,
    phase: "market",
    join: null,
    live: { ...band, tray: [] },
    bands: [band],
  }
}

test("a buy-in opens one settling card at its settle time and not before", () => {
  const bets = [bet(1, 20_000)]
  const early = tickNotices(emptyNotices(), bets, 19_999, 19_999)
  expect(early.cards).toEqual([])
  const opened = tickNotices(early, bets, 20_000, 50_000)
  expect(opened.cards).toEqual([
    { kind: "settling", roundId: 1, side: "up", stakeMicros: 10_000_000, openedAt: 50_000 },
  ])
  const again = tickNotices(opened, bets, 21_000, 51_000)
  expect(again).toBe(opened)
})

test("a result replaces the settling card and a fast result never shows the loading line", () => {
  const bets = [bet(1, 20_000)]
  const opened = tickNotices(emptyNotices(), bets, 20_000, 50_000)
  const replaced = settleNotice(opened, message(), "me", 51_000)
  expect(replaced.cards).toEqual([
    {
      kind: "result",
      roundId: 1,
      tone: "credit",
      amountMicros: 8_500_000,
      signed: true,
      stakeReturned: true,
      shownAt: 51_000,
    },
  ])
  const lateTick = tickNotices(replaced, bets, 22_000, 52_000)
  expect(lateTick).toBe(replaced)

  const first = settleNotice(emptyNotices(), message(), "me", 19_000)
  expect(first.cards.map((card) => card.kind)).toEqual(["result"])
  const after = tickNotices(first, bets, 20_000, 20_000)
  expect(after).toBe(first)
})

test("two rounds get two cards, and a dismissed settling card does not reopen", () => {
  const bets = [bet(1, 20_000), bet(2, 20_000, 5_000_000)]
  const opened = tickNotices(emptyNotices(), bets, 20_000, 50_000)
  expect(opened.cards.map((card) => card.roundId)).toEqual([1, 2])
  const closed = dismissRound(opened, 1)
  expect(closed.cards.map((card) => card.roundId)).toEqual([2])
  const kept = tickNotices(closed, bets, 21_000, 51_000)
  expect(kept.cards.map((card) => card.roundId)).toEqual([2])
})

test("a settling card drops after the wait, and a late result still shows", () => {
  const opened = tickNotices(emptyNotices(), [bet(1, 20_000)], 20_000, 50_000)
  const dropped = tickNotices(opened, [bet(1, 20_000)], 20_000 + SETTLING_MS, 50_000 + SETTLING_MS)
  expect(dropped.cards).toEqual([])
  const late = settleNotice(
    dropped,
    message({
      resolution: "paid",
      winningSide: "down",
      payouts: [{ address: "me", side: "up", stakeMicros: 10_000_000, payoutMicros: 0 }],
    }),
    "me",
    70_000,
  )
  expect(late.cards).toEqual([
    { kind: "result", roundId: 1, tone: "debit", amountMicros: 10_000_000, signed: false, stakeReturned: false, shownAt: 70_000 },
  ])
})

test("a win shows the gain, and push, void, and a loss show the stake", () => {
  expect(resultTone("void", null, 10_000_000)).toBe("void")
  expect(resultTone("refund", "push", 10_000_000)).toBe("push")
  expect(resultTone("paid", "up", 18_500_000)).toBe("credit")
  expect(resultAmount("credit", 10_000_000, 18_500_000)).toBe(8_500_000)
  expect(resultAmount("credit", 10_000_000, 10_000_000)).toBe(10_000_000)
  expect(resultAmount("debit", 10_000_000, 0)).toBe(10_000_000)
  expect(resultAmount("push", 10_000_000, 10_000_000)).toBe(10_000_000)
  expect(stakeCameBack(10_000_000, 18_500_000)).toBe(true)
  expect(stakeCameBack(10_000_000, 10_000_000)).toBe(true)
  expect(stakeCameBack(10_000_000, 0)).toBe(false)
  const state = emptyNotices()
  expect(
    settleNotice(
      state,
      message({
        resolution: "void",
        status: "void",
        winningSide: null,
        payouts: [{ address: "me", side: "up", stakeMicros: 10_000_000, payoutMicros: 10_000_000 }],
      }),
      "me",
      1,
    ).cards[0],
  ).toMatchObject({ tone: "void", amountMicros: 10_000_000, signed: false, stakeReturned: true })
  expect(
    settleNotice(
      state,
      message({
        resolution: "refund",
        winningSide: "push",
        payouts: [{ address: "me", side: "up", stakeMicros: 10_000_000, payoutMicros: 10_000_000 }],
      }),
      "me",
      1,
    ).cards[0],
  ).toMatchObject({ tone: "push", amountMicros: 10_000_000, signed: false, stakeReturned: true })
  expect(settleNotice(state, message(), "other", 1)).toBe(state)
})

test("due buy-ins take the settle time from the live card, the join card, or a band", () => {
  const current = board()
  expect(dueBuyIns(current, [{ roundId: 1, side: "down", stakeMicros: 2_000_000 }])).toEqual([
    { roundId: 1, side: "down", stakeMicros: 2_000_000, settlesAt: 20_000 },
  ])
  const joinOnly = board()
  joinOnly.live = null
  joinOnly.join = { ...joinOnly.bands[0]!, id: 4, settlesAt: 40_000, tray: [] }
  joinOnly.bands = []
  expect(dueBuyIns(joinOnly, [{ roundId: 4, side: "up", stakeMicros: 3 }])).toEqual([
    { roundId: 4, side: "up", stakeMicros: 3, settlesAt: 40_000 },
  ])
  const bandOnly = board()
  bandOnly.live = null
  bandOnly.bands[0]!.id = 7
  bandOnly.bands[0]!.settlesAt = 70_000
  expect(dueBuyIns(bandOnly, [{ roundId: 7, side: "down", stakeMicros: 4 }])).toEqual([
    { roundId: 7, side: "down", stakeMicros: 4, settlesAt: 70_000 },
  ])
  expect(dueBuyIns(current, [{ roundId: 9, side: "up", stakeMicros: 1 }])).toEqual([])
  expect(dueBuyIns(null, [{ roundId: 1, side: "up", stakeMicros: 1 }])).toEqual([])
})
