export const USDC = 1_000_000
export const ONE_USDC = BigInt(USDC)
export const GAS_FLOOR = 50_000_000_000_000n
export const FAUCET_STALE_MS = 2 * 60 * 1000
export const STUCK_STREAK = 3
export const WINDOW_MISSES = 3
const SEEN_CAP = 200

export type Phase = "funding" | "sweeping" | "betting" | "paused" | "stuck"
export type Side = "up" | "down"

export type FlowEvent = {
  key: string
  direction: "in" | "out"
  micros: number
}

export type WalletFlow = {
  inflowMicros: number
  outflowMicros: number
  seen: string[]
  lastLedgerMicros: number | null
  chainSeeded: boolean
}

export type FlowFile = Record<string, WalletFlow>

export type CommandAction = "pause" | "resume" | "pause-all" | "resume-all" | "faucet" | "relogin"

export type ControlCommand = {
  id: string
  action: CommandAction
  address?: string
}

export type ControlFile = {
  paused: string[]
  queue: ControlCommand[]
}

export type StatusRow = {
  index: number
  address: string
  ethWei: string
  chainUsdcMicros: string
  ledgerMicros: number
  inflowMicros: number
  outflowMicros: number
  phase: Phase
  roundId: number | null
  side: Side | null
  error: string | null
  stuck: string | null
  errorStreak: number
  faucetRequestedAt: number | null
  sweepError: boolean
  signInError: boolean
  chainMismatch: boolean
  windowsSinceBet: number
  countedRound: number | null
}

export type StatusFile = {
  updatedAt: number
  chain: string
  rows: StatusRow[]
  applied: string[]
}

export type StuckInput = {
  error: string | null
  errorStreak: number
  cdpConfigured: boolean
  needsFaucet: boolean
  faucetRequestedAt: number | null
  now: number
  sweepError: boolean
  signInError: boolean
  chainMismatch: boolean
  ledgerMicros: number
  windowsSinceBet: number
}

export type RowInput = {
  index: number
  address: string
  ethWei: bigint
  chainUsdcMicros: bigint
  ledgerMicros: number
  inflowMicros: number
  outflowMicros: number
  paused: boolean
  needsFaucet: boolean
  error: string | null
  errorStreak: number
  cdpConfigured: boolean
  faucetRequestedAt: number | null
  now: number
  sweepError: boolean
  signInError: boolean
  chainMismatch: boolean
  windowsSinceBet: number
  countedRound: number | null
  roundId: number | null
  side: Side | null
}

const ACTIONS: CommandAction[] = ["pause", "resume", "pause-all", "resume-all", "faucet", "relogin"]

export function emptyFlow(): WalletFlow {
  return { inflowMicros: 0, outflowMicros: 0, seen: [], lastLedgerMicros: null, chainSeeded: false }
}

export function emptyControl(): ControlFile {
  return { paused: [], queue: [] }
}

export function applyFlow(flow: WalletFlow, events: FlowEvent[]): WalletFlow {
  const seen = new Set(flow.seen)
  let inflowMicros = flow.inflowMicros
  let outflowMicros = flow.outflowMicros
  let nextSeen = flow.seen
  for (const event of events) {
    if (seen.has(event.key)) continue
    if (!Number.isSafeInteger(event.micros) || event.micros <= 0) continue
    if (event.direction === "in") inflowMicros += event.micros
    else outflowMicros += event.micros
    seen.add(event.key)
    const seeds = nextSeen.filter((key) => key.startsWith("seed-"))
    const rest = nextSeen.filter((key) => !key.startsWith("seed-"))
    nextSeen = [...seeds, ...[...rest, event.key].slice(-SEEN_CAP)]
  }
  return { ...flow, inflowMicros, outflowMicros, seen: nextSeen }
}

export function seedChain(flow: WalletFlow, address: string, chainUsdcMicros: number): WalletFlow {
  if (flow.chainSeeded) return flow
  const seeded =
    chainUsdcMicros > 0
      ? applyFlow(flow, [{ key: `seed-chain:${address.toLowerCase()}`, direction: "in", micros: chainUsdcMicros }])
      : flow
  return { ...seeded, chainSeeded: true }
}

export function noteLedger(flow: WalletFlow, address: string, ledgerMicros: number, mark: string): WalletFlow {
  if (!Number.isSafeInteger(ledgerMicros) || ledgerMicros < 0) return flow
  if (flow.lastLedgerMicros === null) {
    const seeded =
      ledgerMicros > 0
        ? applyFlow(flow, [{ key: `seed-ledger:${address.toLowerCase()}`, direction: "in", micros: ledgerMicros }])
        : flow
    return { ...seeded, lastLedgerMicros: ledgerMicros }
  }
  if (ledgerMicros > flow.lastLedgerMicros) {
    const updated = applyFlow(flow, [
      {
        key: `ledger:${address.toLowerCase()}:${flow.lastLedgerMicros}->${ledgerMicros}:${mark}`,
        direction: "in",
        micros: ledgerMicros - flow.lastLedgerMicros,
      },
    ])
    return { ...updated, lastLedgerMicros: ledgerMicros }
  }
  return { ...flow, lastLedgerMicros: ledgerMicros }
}

export function stuckReason(input: StuckInput): string | null {
  if (input.chainMismatch) return input.error ?? "Server chain does not match"
  if (input.signInError) {
    if (!input.error || input.error.startsWith("Sign-in")) return input.error ?? "Sign-in failed"
    return `Sign-in failed: ${input.error}`
  }
  if (input.sweepError) {
    if (!input.error || input.error.startsWith("Sweep failed")) return input.error ?? "Sweep failed"
    return `Sweep failed: ${input.error}`
  }
  if (input.needsFaucet && !input.cdpConfigured) return "CDP keys missing"
  if (
    input.needsFaucet &&
    input.faucetRequestedAt !== null &&
    input.now - input.faucetRequestedAt >= FAUCET_STALE_MS
  ) {
    return "Faucet did not fund this wallet"
  }
  if (input.error && input.errorStreak >= STUCK_STREAK) return input.error
  if (input.ledgerMicros >= USDC && input.windowsSinceBet >= WINDOW_MISSES) return "No bet for 3 windows"
  return null
}

export function phaseOf(input: {
  paused: boolean
  stuck: string | null
  needsFaucet: boolean
  chainUsdcMicros: bigint
}): Phase {
  if (input.paused) return "paused"
  if (input.stuck) return "stuck"
  if (input.needsFaucet) return "funding"
  if (input.chainUsdcMicros >= ONE_USDC) return "sweeping"
  return "betting"
}

export function statusRow(input: RowInput): StatusRow {
  const stuck = stuckReason({
    error: input.error,
    errorStreak: input.errorStreak,
    cdpConfigured: input.cdpConfigured,
    needsFaucet: input.needsFaucet,
    faucetRequestedAt: input.faucetRequestedAt,
    now: input.now,
    sweepError: input.sweepError,
    signInError: input.signInError,
    chainMismatch: input.chainMismatch,
    ledgerMicros: input.ledgerMicros,
    windowsSinceBet: input.windowsSinceBet,
  })
  return {
    index: input.index,
    address: input.address,
    ethWei: input.ethWei.toString(),
    chainUsdcMicros: input.chainUsdcMicros.toString(),
    ledgerMicros: input.ledgerMicros,
    inflowMicros: input.inflowMicros,
    outflowMicros: input.outflowMicros,
    phase: phaseOf({
      paused: input.paused,
      stuck,
      needsFaucet: input.needsFaucet,
      chainUsdcMicros: input.chainUsdcMicros,
    }),
    roundId: input.roundId,
    side: input.side,
    error: input.error,
    stuck,
    errorStreak: input.errorStreak,
    faucetRequestedAt: input.faucetRequestedAt,
    sweepError: input.sweepError,
    signInError: input.signInError,
    chainMismatch: input.chainMismatch,
    windowsSinceBet: input.windowsSinceBet,
    countedRound: input.countedRound,
  }
}

export function summarize(rows: StatusRow[]): {
  wallets: number
  paused: number
  stuck: number
  ledgerMicros: number
  inflowMicros: number
  outflowMicros: number
} {
  return {
    wallets: rows.length,
    paused: rows.filter((row) => row.phase === "paused").length,
    stuck: rows.filter((row) => row.stuck !== null).length,
    ledgerMicros: rows.reduce((sum, row) => sum + row.ledgerMicros, 0),
    inflowMicros: rows.reduce((sum, row) => sum + row.inflowMicros, 0),
    outflowMicros: rows.reduce((sum, row) => sum + row.outflowMicros, 0),
  }
}

export function nextErrorStreak(
  previous: { error: string | null; streak: number },
  error: string | null,
): { error: string | null; streak: number } {
  if (!error) return { error: null, streak: 0 }
  if (error === previous.error) return { error, streak: previous.streak + 1 }
  return { error, streak: 1 }
}

export function nextWindowsSinceBet(
  state: { windowsSinceBet: number; countedRound: number | null },
  roundId: number | null,
  ledgerMicros: number,
  roundHandled: boolean,
  paused: boolean,
): { windowsSinceBet: number; countedRound: number | null } {
  if (roundId === null) return state
  if (paused || ledgerMicros < USDC) return { windowsSinceBet: state.windowsSinceBet, countedRound: roundId }
  if (roundHandled) {
    const missed =
      state.countedRound === null || roundId <= state.countedRound ? 0 : Math.max(0, roundId - state.countedRound - 1)
    return { windowsSinceBet: missed >= WINDOW_MISSES ? missed : 0, countedRound: roundId }
  }
  if (state.countedRound === null || roundId <= state.countedRound) {
    return { windowsSinceBet: state.windowsSinceBet, countedRound: state.countedRound ?? roundId }
  }
  return { windowsSinceBet: state.windowsSinceBet + (roundId - state.countedRound), countedRound: roundId }
}

export function applyCommand(control: ControlFile, command: ControlCommand, addresses: string[]): ControlFile {
  const known = new Set(addresses.map((address) => address.toLowerCase()))
  const paused = new Set(control.paused.map((address) => address.toLowerCase()))
  if (command.action === "pause-all") return { paused: [...known], queue: control.queue }
  if (command.action === "resume-all") return { paused: [], queue: control.queue }
  const address = command.address?.toLowerCase()
  if (!address || !known.has(address)) return control
  if (command.action === "pause") {
    paused.add(address)
    return { paused: [...paused], queue: control.queue }
  }
  if (command.action === "resume") {
    paused.delete(address)
    return { paused: [...paused], queue: control.queue }
  }
  if (command.action !== "faucet" && command.action !== "relogin") return control
  if (!command.id || control.queue.some((item) => item.id === command.id)) return control
  return { paused: [...paused], queue: [...control.queue, { id: command.id, action: command.action, address }] }
}

export function pendingOneShots(control: ControlFile, appliedIds: string[]): ControlCommand[] {
  const applied = new Set(appliedIds)
  return control.queue.filter(
    (item) => !applied.has(item.id) && (item.action === "faucet" || item.action === "relogin") && item.address,
  )
}

export function formatUsdc(micros: number): string {
  const negative = micros < 0
  const abs = Math.abs(Math.trunc(micros))
  const cents = Math.floor((abs + 5_000) / 10_000)
  const whole = Math.floor(cents / 100)
  const frac = String(cents % 100).padStart(2, "0")
  return `${negative && cents > 0 ? "-" : ""}${whole}.${frac}`
}

export function formatEth(wei: string): string {
  let value: bigint
  try {
    value = BigInt(wei)
  } catch {
    return "0.00000"
  }
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / 10n ** 18n
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, 5)
  return `${negative ? "-" : ""}${whole}.${frac}`
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function isCommand(value: unknown): value is ControlCommand {
  if (!value || typeof value !== "object") return false
  const command = value as ControlCommand
  if (typeof command.id !== "string" || command.id === "") return false
  if (!ACTIONS.includes(command.action)) return false
  if (command.address !== undefined && typeof command.address !== "string") return false
  return true
}

export function parseControl(value: unknown): ControlFile {
  if (!value || typeof value !== "object") return emptyControl()
  const record = value as { paused?: unknown; queue?: unknown }
  const paused = Array.isArray(record.paused)
    ? record.paused.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
    : []
  const queue = Array.isArray(record.queue) ? record.queue.filter(isCommand) : []
  return { paused, queue }
}

function isPhase(value: unknown): value is Phase {
  return value === "funding" || value === "sweeping" || value === "betting" || value === "paused" || value === "stuck"
}

function parseRow(value: unknown): StatusRow | null {
  if (!value || typeof value !== "object") return null
  const row = value as Partial<StatusRow>
  if (typeof row.index !== "number" || typeof row.address !== "string" || !isPhase(row.phase)) return null
  if (typeof row.ethWei !== "string" || typeof row.chainUsdcMicros !== "string") return null
  if (typeof row.ledgerMicros !== "number" || typeof row.inflowMicros !== "number" || typeof row.outflowMicros !== "number") {
    return null
  }
  return {
    index: row.index,
    address: row.address,
    ethWei: row.ethWei,
    chainUsdcMicros: row.chainUsdcMicros,
    ledgerMicros: row.ledgerMicros,
    inflowMicros: row.inflowMicros,
    outflowMicros: row.outflowMicros,
    phase: row.phase,
    roundId: typeof row.roundId === "number" ? row.roundId : null,
    side: row.side === "up" || row.side === "down" ? row.side : null,
    error: typeof row.error === "string" ? row.error : null,
    stuck: typeof row.stuck === "string" ? row.stuck : null,
    errorStreak: typeof row.errorStreak === "number" ? row.errorStreak : 0,
    faucetRequestedAt: typeof row.faucetRequestedAt === "number" ? row.faucetRequestedAt : null,
    sweepError: row.sweepError === true,
    signInError: row.signInError === true,
    chainMismatch: row.chainMismatch === true,
    windowsSinceBet: typeof row.windowsSinceBet === "number" ? row.windowsSinceBet : 0,
    countedRound: typeof row.countedRound === "number" ? row.countedRound : null,
  }
}

export function parseStatus(value: unknown): StatusFile | null {
  if (!value || typeof value !== "object") return null
  const record = value as { updatedAt?: unknown; chain?: unknown; rows?: unknown; applied?: unknown }
  if (typeof record.updatedAt !== "number" || typeof record.chain !== "string" || !Array.isArray(record.rows)) return null
  const rows = record.rows.map(parseRow)
  if (rows.some((row) => row === null)) return null
  const applied = Array.isArray(record.applied) ? record.applied.filter((item): item is string => typeof item === "string") : []
  return { updatedAt: record.updatedAt, chain: record.chain, rows: rows as StatusRow[], applied }
}

export function parseFlow(value: unknown): FlowFile {
  if (!value || typeof value !== "object") return {}
  const flows: FlowFile = {}
  for (const [address, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") continue
    const flow = raw as Partial<WalletFlow>
    if (typeof flow.inflowMicros !== "number" || typeof flow.outflowMicros !== "number") continue
    flows[address.toLowerCase()] = {
      inflowMicros: flow.inflowMicros,
      outflowMicros: flow.outflowMicros,
      seen: Array.isArray(flow.seen) ? flow.seen.filter((key): key is string => typeof key === "string") : [],
      lastLedgerMicros: typeof flow.lastLedgerMicros === "number" ? flow.lastLedgerMicros : null,
      chainSeeded: flow.chainSeeded === true,
    }
  }
  return flows
}
