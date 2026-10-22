import type { Side, You } from "./types"

/** Local bet applied on the click. The server response replaces or restores it. */
export function applyBuyIn(you: You, input: { side: Side; stakeMicros: number; roundId: number }): You {
  const matched = you.openBuyIns.some((bet) => bet.roundId === input.roundId)
  const openBuyIns = you.openBuyIns.map((bet) =>
    bet.roundId === input.roundId ? { ...bet, stakeMicros: bet.stakeMicros + input.stakeMicros } : { ...bet },
  )
  if (!matched) {
    openBuyIns.push({ roundId: input.roundId, side: input.side, stakeMicros: input.stakeMicros })
    openBuyIns.sort((left, right) => left.roundId - right.roundId)
  }
  return {
    address: you.address,
    balanceMicros: you.balanceMicros - input.stakeMicros,
    grantAt: you.grantAt,
    grantPending: you.grantPending,
    openBuyIns,
  }
}
