import type { ChainConfig } from "../shared/chain"
import { moneyLabel, tokenKind, tokenLabel } from "../shared/chain"
import type { ChainRuntime } from "./chainRuntime"
import { currentTreasuryReport } from "./near"

export const NEAR_UNAVAILABLE = "NEAR_UNAVAILABLE"
export const NEAR_UNAVAILABLE_MESSAGE = "NEAR runtime unavailable"

export type NearRuntimeState = "starting" | "ready" | "failed"

export type NearRuntimeSlot = {
  state: NearRuntimeState
  error: string | null
  attempts: number
  nextRetryAt: number | null
}

/** Backoff for a failed NEAR boot: 5 s, 15 s, 30 s, 60 s, then 120 s until it answers. */
export const NEAR_RUNTIME_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000]

export function nearRuntimeRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(1, Math.trunc(attempts)) - 1, NEAR_RUNTIME_RETRY_DELAYS_MS.length - 1)
  return NEAR_RUNTIME_RETRY_DELAYS_MS[index]!
}

/**
 * The runtime a failed NEAR boot installs so the market stays servable while the watchdog
 * retries: no grants, no chain calls, the last known treasury report. `liveKeys`,
 * `publicConfig`, and health keep working instead of throwing "Market near-testnet is off".
 */
export function degradedNearRuntime(input: { chain: ChainConfig; treasury: string; token: string }): ChainRuntime {
  const { chain, treasury, token } = input
  return {
    chain,
    treasury,
    token,
    grantsOpen: false,
    moneyLabel: moneyLabel(chain),
    tokenKind: tokenKind(chain),
    tokenLabel: tokenLabel(chain),
    mint: async () => {
      throw new Error(`${NEAR_UNAVAILABLE_MESSAGE} (${NEAR_UNAVAILABLE})`)
    },
    withdraw: async () => ({ ok: false, error: NEAR_UNAVAILABLE_MESSAGE, code: NEAR_UNAVAILABLE }),
    treasuryReport: currentTreasuryReport,
  }
}

let slot: NearRuntimeSlot = { state: "ready", error: null, attempts: 0, nextRetryAt: null }

export function nearRuntimeSlot(): Readonly<NearRuntimeSlot> {
  return { ...slot }
}

type RetryTimer = { stop: () => void }

const watchdogRuntime = globalThis as unknown as { quickMarketNearWatchdog?: RetryTimer }

let generation = 0

function stopNearRuntimeRetry(): void {
  generation += 1
  watchdogRuntime.quickMarketNearWatchdog?.stop()
  watchdogRuntime.quickMarketNearWatchdog = undefined
}

function slotErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 300)
  return String(error).slice(0, 300)
}

/**
 * Retry a failed NEAR boot in the background. The slot reports state for health; onReady
 * installs the recovered runtime. One watchdog at a time: starting again, or resetting for
 * a test, stops the previous timer and strands any in-flight attempt.
 */
export function beginNearRuntimeRetry(input: {
  error: unknown
  start: () => Promise<ChainRuntime>
  onReady: (runtime: ChainRuntime) => void
  /** Overridden in tests to shrink the backoff. */
  delayMs?: (attempts: number) => number
}): void {
  stopNearRuntimeRetry()
  const mine = generation
  slot = { state: "failed", error: slotErrorText(input.error), attempts: 1, nextRetryAt: null }
  const delayFor = input.delayMs ?? nearRuntimeRetryDelayMs
  const schedule = (): void => {
    if (mine !== generation) return
    const delay = Math.max(0, delayFor(slot.attempts))
    slot = { ...slot, nextRetryAt: Date.now() + delay }
    const timer = setTimeout(() => void attempt(), delay)
    timer.unref?.()
    watchdogRuntime.quickMarketNearWatchdog = {
      stop: () => clearTimeout(timer),
    }
  }
  const attempt = async (): Promise<void> => {
    if (mine !== generation || slot.state === "ready") return
    slot = { ...slot, state: "starting", nextRetryAt: null }
    try {
      const runtime = await input.start()
      if (mine !== generation) return
      slot = { state: "ready", error: null, attempts: 0, nextRetryAt: null }
      input.onReady(runtime)
    } catch (error) {
      if (mine !== generation) return
      slot = { state: "failed", error: slotErrorText(error), attempts: slot.attempts + 1, nextRetryAt: null }
      console.error(`near runtime boot retry ${slot.attempts} failed: ${slot.error}`)
      schedule()
    }
  }
  schedule()
}

export function resetNearRuntimeSlotForTest(): void {
  stopNearRuntimeRetry()
  slot = { state: "ready", error: null, attempts: 0, nextRetryAt: null }
}
