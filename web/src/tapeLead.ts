export type TapeLead = "apply" | "wait" | "resync"

/** A tick or book still moves the feed before the snapshot arrives.
 *  A frame from another epoch asks for the snapshot again. Other frames wait. */
export function tapeLead(input: {
  type: string
  needsSnapshot: boolean
  epoch: string | null
  messageEpoch: string | null
}): TapeLead {
  if (input.type !== "tick" && input.type !== "book") return input.needsSnapshot ? "wait" : "apply"
  if (input.epoch && input.messageEpoch !== input.epoch) return "resync"
  return "apply"
}
