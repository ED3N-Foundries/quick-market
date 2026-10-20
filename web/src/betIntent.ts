import type { Side, You } from "./types"

/** Local bet applied on the click. The server response replaces or restores it. */
export function applyBet(you: You, input: { side: Side; stakeMicros: number; roundId: number }): You {
  const matched = you.openBets.some((bet) => bet.roundId === input.roundId)
  const openBets = you.openBets.map((bet) =>
    bet.roundId === input.roundId ? { ...bet, stakeMicros: bet.stakeMicros + input.stakeMicros } : { ...bet },
  )
  if (!matched) {
    openBets.push({ roundId: input.roundId, side: input.side, stakeMicros: input.stakeMicros })
    openBets.sort((left, right) => left.roundId - right.roundId)
  }
  return {
    address: you.address,
    balanceMicros: you.balanceMicros - input.stakeMicros,
    grantAt: you.grantAt,
    openBets,
  }
}
