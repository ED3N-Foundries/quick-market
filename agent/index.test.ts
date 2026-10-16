import { expect, test } from "bun:test"
import { handleKey, renderDashboard } from "./dashboard"
import { needsFaucet, planKeys, sideFor, type StoredKey } from "./index"
import {
  USDC,
  applyCommand,
  applyFlow,
  emptyControl,
  emptyFlow,
  nextErrorStreak,
  nextWindowsSinceBet,
  noteLedger,
  parseControl,
  parseStatus,
  pendingOneShots,
  seedChain,
  statusRow,
  stuckReason,
  type RowInput,
  type StatusFile,
} from "./status"

test("planKeys keeps existing keys and fills up to the count", () => {
  const first = planKeys([], 2)
  expect(planKeys(first, 2)).toEqual(first)
  const more = planKeys(first, 3)
  expect(more.slice(0, 2)).toEqual(first)
  expect(more).toHaveLength(3)
  expect(more[2]!.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
  expect(more[2]!.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
})

test("planKeys skips a damaged key", () => {
  const broken = [{ address: "0x0", privateKey: "0x123" }] as StoredKey[]
  const keys = planKeys(broken, 1)
  expect(keys).toHaveLength(1)
  expect(keys[0]!.privateKey).not.toBe("0x123")
})

test("sideFor pins the first two wallets and stays stable", () => {
  const address = `0x${"ab".repeat(20)}`
  expect(sideFor(0, 1, address)).toBe("up")
  expect(sideFor(1, 1, address)).toBe("down")
  expect(sideFor(2, 9, address)).toBe(sideFor(2, 9, address))
  expect(["up", "down"]).toContain(sideFor(2, 9, address))
})

test("needsFaucet is only on a faucet chain and only when the wallet is short", () => {
  expect(needsFaucet(false, 0n, 0n)).toEqual({ eth: false, usdc: false })
  expect(needsFaucet(true, 0n, 0n)).toEqual({ eth: true, usdc: true })
  expect(needsFaucet(true, 10n ** 16n, 2_000_000n)).toEqual({ eth: false, usdc: false })
})

const ADDRESS = `0x${"ab".repeat(20)}`
const OTHER = `0x${"cd".repeat(20)}`

function row(overrides: Partial<RowInput> = {}) {
  return statusRow({
    index: 0,
    address: ADDRESS,
    ethWei: 10n ** 16n,
    chainUsdcMicros: 0n,
    ledgerMicros: 2 * USDC,
    inflowMicros: 5 * USDC,
    outflowMicros: 3 * USDC,
    paused: false,
    needsFaucet: false,
    error: null,
    errorStreak: 0,
    cdpConfigured: true,
    faucetRequestedAt: null,
    now: 10_000,
    sweepError: false,
    signInError: false,
    chainMismatch: false,
    windowsSinceBet: 0,
    countedRound: null,
    roundId: 12,
    side: "up",
    ...overrides,
  })
}

function board(rows: ReturnType<typeof row>[]): StatusFile {
  return { updatedAt: 10_000, chain: "base-sepolia", rows, applied: [] }
}

test("flow counts each faucet, sweep, stake, and ledger credit once", () => {
  let flow = seedChain(emptyFlow(), ADDRESS, 400_000)
  flow = seedChain(flow, ADDRESS, 9_000_000)
  flow = applyFlow(flow, [{ key: "faucet:0x1", direction: "in", micros: USDC }])
  flow = applyFlow(flow, [{ key: "faucet:0x1", direction: "in", micros: USDC }])
  flow = noteLedger(flow, ADDRESS, 0, "1")
  flow = applyFlow(flow, [{ key: "sweep:0x2", direction: "out", micros: 1_400_000 }])
  flow = applyFlow(flow, [{ key: `bet:${ADDRESS}:1`, direction: "out", micros: USDC }])
  flow = noteLedger(flow, ADDRESS, 1_400_000, "2")
  flow = noteLedger(flow, ADDRESS, 1_400_000, "3")
  expect(flow.inflowMicros).toBe(400_000 + USDC + 1_400_000)
  expect(flow.outflowMicros).toBe(1_400_000 + USDC)
  expect(flow.chainSeeded).toBe(true)
  expect(flow.lastLedgerMicros).toBe(1_400_000)
})

test("stuckReason names the failed step and stays quiet when the wallet is healthy", () => {
  const healthy = {
    error: null,
    errorStreak: 0,
    cdpConfigured: true,
    needsFaucet: false,
    faucetRequestedAt: null,
    now: 200_000,
    sweepError: false,
    signInError: false,
    chainMismatch: false,
    ledgerMicros: USDC,
    windowsSinceBet: 0,
  }
  expect(stuckReason(healthy)).toBeNull()
  expect(stuckReason({ ...healthy, chainMismatch: true, error: "Server chain 1 does not match base-sepolia", errorStreak: 3 })).toBe(
    "Server chain 1 does not match base-sepolia",
  )
  expect(stuckReason({ ...healthy, signInError: true, error: "Sign-in failed: no token" })).toBe("Sign-in failed: no token")
  expect(stuckReason({ ...healthy, sweepError: true, error: "Sweep failed: denied" })).toBe("Sweep failed: denied")
  expect(stuckReason({ ...healthy, needsFaucet: true, cdpConfigured: false })).toBe("CDP keys missing")
  expect(stuckReason({ ...healthy, needsFaucet: true, faucetRequestedAt: 80_000, now: 199_999 })).toBeNull()
  expect(stuckReason({ ...healthy, needsFaucet: true, faucetRequestedAt: 80_000, now: 200_000 })).toBe("Faucet did not fund this wallet")
  expect(stuckReason({ ...healthy, windowsSinceBet: 3 })).toBe("No bet for 3 windows")
  expect(stuckReason({ ...healthy, windowsSinceBet: 3, ledgerMicros: USDC - 1 })).toBeNull()
  expect(stuckReason({ ...healthy, error: "Price feed is delayed", errorStreak: 2 })).toBeNull()
  expect(stuckReason({ ...healthy, error: "Price feed is delayed", errorStreak: 3 })).toBe("Price feed is delayed")
})

test("phase follows pause, then stuck, funding, sweeping, and betting", () => {
  expect(row({ paused: true, needsFaucet: true, cdpConfigured: false }).phase).toBe("paused")
  expect(row({ paused: true, needsFaucet: true, cdpConfigured: false }).stuck).toBe("CDP keys missing")
  expect(row({ needsFaucet: true }).phase).toBe("funding")
  expect(row({ chainUsdcMicros: BigInt(USDC) }).phase).toBe("sweeping")
  expect(row().phase).toBe("betting")
  expect(row({ error: "Bet failed", errorStreak: 3 }).phase).toBe("stuck")
})

test("missed windows count the gap and a bet clears a short gap", () => {
  let state = { windowsSinceBet: 0, countedRound: null as number | null }
  state = nextWindowsSinceBet(state, 1, USDC, false, false)
  state = nextWindowsSinceBet(state, 1, USDC, false, false)
  expect(state).toEqual({ windowsSinceBet: 0, countedRound: 1 })
  state = nextWindowsSinceBet(state, 2, USDC, false, false)
  state = nextWindowsSinceBet(state, 3, USDC, false, false)
  state = nextWindowsSinceBet(state, 4, USDC, false, false)
  expect(state).toEqual({ windowsSinceBet: 3, countedRound: 4 })
  expect(nextWindowsSinceBet(state, 5, USDC, true, false)).toEqual({ windowsSinceBet: 0, countedRound: 5 })
  expect(nextWindowsSinceBet({ windowsSinceBet: 0, countedRound: 10 }, 14, USDC, true, false)).toEqual({
    windowsSinceBet: 3,
    countedRound: 14,
  })
  expect(nextWindowsSinceBet({ windowsSinceBet: 2, countedRound: 4 }, 8, USDC, false, true)).toEqual({
    windowsSinceBet: 2,
    countedRound: 8,
  })
  expect(nextErrorStreak({ error: "Bet failed", streak: 1 }, "Bet failed")).toEqual({ error: "Bet failed", streak: 2 })
  expect(nextErrorStreak({ error: "Bet failed", streak: 2 }, null)).toEqual({ error: null, streak: 0 })
})

test("commands pause one wallet or every wallet and queue one faucet", () => {
  const addresses = [ADDRESS, OTHER]
  let control = applyCommand(emptyControl(), { id: "1", action: "pause", address: ADDRESS }, addresses)
  expect(control.paused).toEqual([ADDRESS])
  control = applyCommand(control, { id: "2", action: "faucet", address: "0xnot-a-wallet" }, addresses)
  expect(control.queue).toEqual([])
  control = applyCommand(control, { id: "3", action: "faucet", address: OTHER }, addresses)
  control = applyCommand(control, { id: "3", action: "faucet", address: OTHER }, addresses)
  expect(control.queue).toEqual([{ id: "3", action: "faucet", address: OTHER }])
  expect(pendingOneShots(control, ["3"])).toEqual([])
  control = applyCommand(control, { id: "4", action: "pause-all" }, addresses)
  expect(control.paused).toEqual([ADDRESS, OTHER])
  control = applyCommand(control, { id: "5", action: "resume", address: ADDRESS }, addresses)
  expect(control.paused).toEqual([OTHER])
  control = applyCommand(control, { id: "6", action: "resume-all" }, addresses)
  expect(control.paused).toEqual([])
  expect(parseControl({ paused: ["0xAb"], queue: [{ id: "", action: "faucet" }, { id: "9", action: "relogin", address: "0xAb" }] })).toEqual({
    paused: ["0xab"],
    queue: [{ id: "9", action: "relogin", address: "0xAb" }],
  })
})

test("the dashboard toggles pause, asks the faucet, and renders the board", () => {
  const status = board([
    row(),
    row({
      index: 1,
      address: OTHER,
      paused: true,
      ledgerMicros: USDC,
      inflowMicros: USDC,
      outflowMicros: 0,
      roundId: null,
      side: null,
      error: "Sweep failed: denied",
      errorStreak: 1,
      sweepError: true,
    }),
  ])
  let control = { paused: [OTHER], queue: [] }
  let selected = 0
  const press = (key: string) => {
    const next = handleKey({ key, selected, status, control, commandId: key })
    control = next.control
    selected = next.selected
    return next.quit
  }
  press("j")
  expect(selected).toBe(1)
  press("p")
  expect(control.paused).toEqual([])
  press("P")
  expect(control.paused).toEqual([ADDRESS, OTHER])
  press("k")
  press("f")
  press("s")
  expect(control.queue.map((command) => command.action)).toEqual(["faucet", "relogin"])
  expect(press("q")).toBe(true)
  const screen = renderDashboard(status, 1, 120, 10_000)
  expect(screen).toContain("base-sepolia · 2 wallets · 1 paused · 1 stuck")
  expect(screen).toContain("ledger 3.00 · in 6.00 · out 3.00")
  expect(screen).toContain("Sweep failed: denied")
  expect(screen).toContain("0xabab…abab")
  expect(renderDashboard(status, 0, 80, 40_000)).toContain("agent quiet")
  expect(renderDashboard(null, 0)).toContain("Waiting for bun run agent")
  expect(parseStatus({ updatedAt: 1, chain: "base-sepolia", rows: [{ index: 0 }], applied: [] })).toBeNull()
})
