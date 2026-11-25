import { beforeEach, expect, test } from "bun:test"
import { CHAINS } from "../shared/chain"
import type { ChainRuntime } from "./chainRuntime"
import {
  NEAR_UNAVAILABLE,
  beginNearRuntimeRetry,
  degradedNearRuntime,
  nearRuntimeRetryDelayMs,
  nearRuntimeSlot,
  resetNearRuntimeSlotForTest,
} from "./nearWatchdog"

beforeEach(() => {
  resetNearRuntimeSlotForTest()
})

test("the NEAR boot retry backoff ramps to a 120 s ceiling", () => {
  expect(nearRuntimeRetryDelayMs(1)).toBe(5_000)
  expect(nearRuntimeRetryDelayMs(2)).toBe(15_000)
  expect(nearRuntimeRetryDelayMs(3)).toBe(30_000)
  expect(nearRuntimeRetryDelayMs(4)).toBe(60_000)
  expect(nearRuntimeRetryDelayMs(5)).toBe(120_000)
  expect(nearRuntimeRetryDelayMs(9)).toBe(120_000)
  expect(nearRuntimeRetryDelayMs(0)).toBe(5_000)
})

test("a failed NEAR boot retries in the background and installs the runtime when it answers", async () => {
  const recovered = degradedNearRuntime({ chain: CHAINS["near-testnet"], treasury: "treasury.near", token: "token.near" })
  let calls = 0
  const installed: ChainRuntime[] = []
  beginNearRuntimeRetry({
    error: new Error("boot exploded"),
    delayMs: () => 1,
    start: async () => {
      calls += 1
      if (calls < 3) throw new Error(`attempt ${calls} failed`)
      return recovered
    },
    onReady: (runtime) => {
      installed.push(runtime)
    },
  })
  const first = nearRuntimeSlot()
  expect(first.state).toBe("failed")
  expect(first.error).toBe("boot exploded")
  expect(first.attempts).toBe(1)
  expect(first.nextRetryAt).not.toBeNull()
  await Bun.sleep(80)
  const ready = nearRuntimeSlot()
  expect(ready.state).toBe("ready")
  expect(ready.error).toBeNull()
  expect(ready.attempts).toBe(0)
  expect(ready.nextRetryAt).toBeNull()
  expect(calls).toBe(3)
  expect(installed).toEqual([recovered])
  // Ready is terminal: no further attempts fire after the recovered runtime lands.
  await Bun.sleep(30)
  expect(calls).toBe(3)
})

test("a reset strands the old watchdog so a stale attempt cannot rearm it", async () => {
  let calls = 0
  beginNearRuntimeRetry({
    error: new Error("boot exploded"),
    delayMs: () => 1,
    start: async () => {
      calls += 1
      throw new Error("still down")
    },
    onReady: () => {},
  })
  await Bun.sleep(20)
  expect(calls).toBeGreaterThan(0)
  resetNearRuntimeSlotForTest()
  const settled = calls
  await Bun.sleep(40)
  expect(calls).toBe(settled)
  expect(nearRuntimeSlot().state).toBe("ready")
})

test("a degraded NEAR runtime closes grants and refuses chain calls with the code", async () => {
  const runtime = degradedNearRuntime({ chain: CHAINS["near-testnet"], treasury: "treasury.near", token: "token.near" })
  expect(runtime.grantsOpen).toBe(false)
  expect(runtime.chain.key).toBe("near-testnet")
  expect(runtime.treasury).toBe("treasury.near")
  expect(runtime.token).toBe("token.near")
  await expect(runtime.mint(1_000)).rejects.toThrow(NEAR_UNAVAILABLE)
  const withdraw = await runtime.withdraw("user.near", 1_000)
  expect(withdraw.ok).toBe(false)
  if (!withdraw.ok) {
    expect(withdraw.code).toBe(NEAR_UNAVAILABLE)
    expect(withdraw.error).toBe("NEAR runtime unavailable")
  }
  expect(() => runtime.treasuryReport()).not.toThrow()
})
