import { expect, test } from "bun:test"
import { applyBuyIn } from "./buyInIntent"
import type { You } from "./types"

function you(over: Partial<You> = {}): You {
  return {
    address: "0xabc",
    balanceMicros: 5_000_000,
    grantAt: null,
    grantPending: null,
    openBuyIns: [],
    ...over,
  }
}

test("a new bet subtracts the stake and opens that side", () => {
  const snapshot = you()
  const next = applyBuyIn(snapshot, { side: "up", stakeMicros: 1_000_000, roundId: 3 })
  expect(next.balanceMicros).toBe(4_000_000)
  expect(next.openBuyIns).toEqual([{ roundId: 3, side: "up", stakeMicros: 1_000_000 }])
  expect(snapshot.balanceMicros).toBe(5_000_000)
  expect(snapshot.openBuyIns).toEqual([])
})

test("a same-side add increases the open stake", () => {
  const snapshot = you({ openBuyIns: [{ roundId: 3, side: "up", stakeMicros: 1_000_000 }] })
  const next = applyBuyIn(snapshot, { side: "up", stakeMicros: 2_000_000, roundId: 3 })
  expect(next.balanceMicros).toBe(3_000_000)
  expect(next.openBuyIns).toEqual([{ roundId: 3, side: "up", stakeMicros: 3_000_000 }])
  expect(snapshot.openBuyIns[0]?.stakeMicros).toBe(1_000_000)
})

test("a bet keeps the in-flight grant", () => {
  const pending = { startedAt: 5, txHash: null, seen: 0, confirmations: 1 }
  const next = applyBuyIn(you({ grantPending: pending }), { side: "up", stakeMicros: 1_000_000, roundId: 3 })
  expect(next.grantPending).toEqual(pending)
})

test("reverting uses the snapshot the apply left untouched", () => {
  const snapshot = you({ openBuyIns: [{ roundId: 2, side: "down", stakeMicros: 1_000_000 }] })
  const next = applyBuyIn(snapshot, { side: "up", stakeMicros: 1_000_000, roundId: 4 })
  const restored = snapshot
  expect(restored.openBuyIns).toEqual([{ roundId: 2, side: "down", stakeMicros: 1_000_000 }])
  expect(restored.balanceMicros).toBe(5_000_000)
  expect(next.openBuyIns.map((bet) => bet.roundId)).toEqual([2, 4])
})
