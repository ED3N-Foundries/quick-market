import type { Side, You } from "./types"
import { applyBuyIn } from "./buyInIntent"

export type HeldBuy = { roundId: number; side: Side; stakeMicros: number }

function row(you: You, roundId: number) {
  return you.openBuyIns.find((bet) => bet.roundId === roundId) ?? null
}

/** The server copy already includes this in-flight order. */
function serverHasHeld(before: You, incoming: You, held: HeldBuy): boolean {
  const prior = row(before, held.roundId)
  const next = row(incoming, held.roundId)
  if (!next || next.side !== held.side) return false
  const base = prior && prior.side === held.side ? prior.stakeMicros : 0
  return next.stakeMicros >= base + held.stakeMicros
}

/**
 * A private account frame replaces balance, grant, and open buy-ins.
 * An order this page has already applied stays on the list, with its stake
 * still off the spendable balance, until the server copy includes it.
 */
export function mergeAccountYou(before: You, incoming: You, held: HeldBuy | null): You {
  if (!held || incoming.address !== before.address) return incoming
  if (serverHasHeld(before, incoming, held)) return incoming
  return applyBuyIn(incoming, held)
}
