import { expect, test } from "bun:test"
import { applyBet } from "./betIntent"
import type { You } from "./types"

function you(over: Partial<You> = {}): You {
  return {
    address: "0xabc",
    balanceMicros: 5_000_000,
    grantAt: null,
    openBets: [],
    ...over,
  }
}

test("a new bet subtracts the stake and opens that side", () => {
  const snapshot = you()
  const next = applyBet(snapshot, { side: "up", stakeMicros: 1_000_000, roundId: 3 })
  expect(next.balanceMicros).toBe(4_000_000)
  expect(next.openBets).toEqual([{ roundId: 3, side: "up", stakeMicros: 1_000_000 }])
  expect(snapshot.balanceMicros).toBe(5_000_000)
  expect(snapshot.openBets).toEqual([])
})

test("a same-side add increases the open stake", () => {
  const snapshot = you({ openBets: [{ roundId: 3, side: "up", stakeMicros: 1_000_000 }] })
  const next = applyBet(snapshot, { side: "up", stakeMicros: 2_000_000, roundId: 3 })
  expect(next.balanceMicros).toBe(3_000_000)
  expect(next.openBets).toEqual([{ roundId: 3, side: "up", stakeMicros: 3_000_000 }])
  expect(snapshot.openBets[0]?.stakeMicros).toBe(1_000_000)
})

test("reverting uses the snapshot the apply left untouched", () => {
  const snapshot = you({ openBets: [{ roundId: 2, side: "down", stakeMicros: 1_000_000 }] })
  const next = applyBet(snapshot, { side: "up", stakeMicros: 1_000_000, roundId: 4 })
  const restored = snapshot
  expect(restored.openBets).toEqual([{ roundId: 2, side: "down", stakeMicros: 1_000_000 }])
  expect(restored.balanceMicros).toBe(5_000_000)
  expect(next.openBets.map((bet) => bet.roundId)).toEqual([2, 4])
})
