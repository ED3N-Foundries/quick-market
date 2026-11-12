import { expect, test } from "bun:test"
import { tapeLead } from "./tapeLead"

test("a tick before the snapshot still applies, and a foreign epoch resyncs", () => {
  expect(tapeLead({ type: "tick", needsSnapshot: true, epoch: null, messageEpoch: "a" })).toBe("apply")
  expect(tapeLead({ type: "book", needsSnapshot: true, epoch: null, messageEpoch: "a" })).toBe("apply")
  expect(tapeLead({ type: "tick", needsSnapshot: true, epoch: "a", messageEpoch: "a" })).toBe("apply")
  expect(tapeLead({ type: "tick", needsSnapshot: true, epoch: "a", messageEpoch: "b" })).toBe("resync")
  expect(tapeLead({ type: "settled", needsSnapshot: true, epoch: null, messageEpoch: null })).toBe("wait")
  expect(tapeLead({ type: "settled", needsSnapshot: false, epoch: "a", messageEpoch: "a" })).toBe("apply")
})
