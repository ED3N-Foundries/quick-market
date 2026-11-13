import { expect, test } from "bun:test"
import { mergeAccountYou } from "./accountFrame"
import type { You } from "./types"

const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

function you(over: Partial<You> = {}): You {
  return {
    address,
    balanceMicros: 10_000_000,
    grantAt: null,
    grantPending: null,
    openBuyIns: [],
    ...over,
  }
}

test("an account frame updates balance, grant, and buy-ins, and leaves a held buy-in in place", () => {
  const before = you()
  const incoming = you({
    balanceMicros: 12_000_000,
    grantAt: 50,
    grantPending: { startedAt: 40, txHash: "0xabc", seen: 1, confirmations: 3 },
    openBuyIns: [{ roundId: 4, side: "down", stakeMicros: 2_000_000 }],
  })
  expect(mergeAccountYou(before, incoming, null)).toEqual(incoming)

  const held = { roundId: 9, side: "up" as const, stakeMicros: 1_000_000 }
  const merged = mergeAccountYou(before, incoming, held)
  expect(merged.balanceMicros).toBe(11_000_000)
  expect(merged.grantAt).toBe(50)
  expect(merged.grantPending).toEqual(incoming.grantPending)
  expect(merged.openBuyIns).toEqual([
    { roundId: 4, side: "down", stakeMicros: 2_000_000 },
    { roundId: 9, side: "up", stakeMicros: 1_000_000 },
  ])

  const landed = you({
    balanceMicros: 11_000_000,
    grantAt: 50,
    grantPending: incoming.grantPending,
    openBuyIns: [
      { roundId: 4, side: "down", stakeMicros: 2_000_000 },
      { roundId: 9, side: "up", stakeMicros: 1_000_000 },
    ],
  })
  expect(mergeAccountYou(before, landed, held)).toEqual(landed)
})
