import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, createWalletClient, http, type Address } from "viem"
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import { base, baseSepolia } from "viem/chains"
import { chainFromEnv, type ChainConfig } from "../shared/chain"
import { loginMessage } from "../shared/login"
import { usdcAbi } from "../shared/usdc"
import {
  GAS_FLOOR,
  ONE_USDC,
  USDC,
  applyFlow,
  emptyFlow,
  nextErrorStreak,
  nextWindowsSinceBet,
  noteLedger,
  parseControl,
  parseFlow,
  parseStatus,
  pendingOneShots,
  seedChain,
  statusRow,
  type FlowFile,
  type StatusRow,
  type WalletFlow,
} from "./status"
import { CONTROL_PATH, FLOW_PATH, STATUS_PATH, readJson, writeJsonAtomic } from "./store"

const KEYS_PATH = join(process.cwd(), "agent", "keys.json")
const FAUCET_WAIT_MS = 10 * 60 * 1000

export type StoredKey = { address: string; privateKey: `0x${string}` }

export function planKeys(existing: StoredKey[], count: number): StoredKey[] {
  const keys: StoredKey[] = []
  for (const row of existing) {
    if (keys.length >= count) break
    if (!/^0x[0-9a-fA-F]{64}$/.test(row.privateKey)) continue
    const account = privateKeyToAccount(row.privateKey)
    keys.push({ address: account.address, privateKey: row.privateKey })
  }
  while (keys.length < count) {
    const privateKey = generatePrivateKey()
    keys.push({ address: privateKeyToAccount(privateKey).address, privateKey })
  }
  return keys
}

export function sideFor(index: number, roundId: number, address: string): "up" | "down" {
  if (index === 0) return "up"
  if (index === 1) return "down"
  let hash = roundId
  for (let i = 0; i < address.length; i++) hash = Math.imul(hash, 33) ^ address.charCodeAt(i)
  return (hash >>> 0) % 2 === 0 ? "up" : "down"
}

export function needsFaucet(faucet: boolean, eth: bigint, usdc: bigint): { eth: boolean; usdc: boolean } {
  if (!faucet) return { eth: false, usdc: false }
  return { eth: eth < GAS_FLOOR, usdc: usdc < ONE_USDC }
}

type State = {
  config: { chainId: number; treasury: Address; usdc: Address }
  you: { balanceMicros: number } | null
  board: { join: { id: number } | null }
}

type Memory = {
  error: string | null
  errorStreak: number
  faucetRequestedAt: number | null
  sweepError: boolean
  signInError: boolean
  chainMismatch: boolean
  windowsSinceBet: number
  countedRound: number | null
  roundId: number | null
  side: "up" | "down" | null
  eth: bigint
  chainUsdc: bigint
  ledgerMicros: number
}

function agentCount(): number {
  const count = Number(process.env.AGENT_COUNT ?? 8)
  if (!Number.isInteger(count) || count < 1 || count > 40) return 8
  return count
}

function loadKeys(): StoredKey[] {
  if (!existsSync(KEYS_PATH)) return []
  const parsed = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as StoredKey[]
  return Array.isArray(parsed) ? parsed : []
}

function saveKeys(keys: StoredKey[]) {
  writeFileSync(KEYS_PATH, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 })
  chmodSync(KEYS_PATH, 0o600)
}

function viemChain(chain: ChainConfig) {
  return chain.id === base.id ? base : baseSepolia
}

function microsOf(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
}

function freshMemory(): Memory {
  return {
    error: null,
    errorStreak: 0,
    faucetRequestedAt: null,
    sweepError: false,
    signInError: false,
    chainMismatch: false,
    windowsSinceBet: 0,
    countedRound: null,
    roundId: null,
    side: null,
    eth: 0n,
    chainUsdc: 0n,
    ledgerMicros: 0,
  }
}

function memoryFromRow(row: StatusRow): Memory {
  return {
    error: row.error,
    errorStreak: row.errorStreak,
    faucetRequestedAt: row.faucetRequestedAt,
    sweepError: row.sweepError,
    signInError: row.signInError,
    chainMismatch: row.chainMismatch,
    windowsSinceBet: row.windowsSinceBet,
    countedRound: row.countedRound,
    roundId: row.roundId,
    side: row.side,
    eth: BigInt(row.ethWei),
    chainUsdc: BigInt(row.chainUsdcMicros),
    ledgerMicros: row.ledgerMicros,
  }
}

function failureKind(message: string): "chain" | "signin" | "sweep" | "other" {
  if (message.startsWith("Server chain")) return "chain"
  if (message.startsWith("Sign-in") || message === "Sign in again") return "signin"
  if (message.startsWith("Sweep failed")) return "sweep"
  return "other"
}

async function main() {
  const chain = chainFromEnv(process.env.CHAIN)
  if (!chain.faucet && process.env.AGENT_MAINNET !== "1") {
    console.error("CHAIN=base spends real USDC. Set AGENT_MAINNET=1 to run agents on mainnet.")
    process.exit(1)
  }
  if (!process.env.AGENT_SECRET) console.error("AGENT_SECRET is unset, so agents keep the one-bet lock")

  const keys = planKeys(loadKeys(), agentCount())
  saveKeys(keys)
  const accounts = keys.map((key) => privateKeyToAccount(key.privateKey))
  console.log(accounts.map((account, index) => `${index} ${account.address}`).join("\n"))

  const transport = http(process.env.RPC_URL || chain.rpc)
  const publicClient = createPublicClient({ chain: viemChain(chain), transport })
  const api = process.env.API_URL ?? "http://127.0.0.1:3001"
  const cdpConfigured = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET)
  const tokens = new Map<string, string>()
  const betOn = new Map<string, number>()
  const faucetAt = new Map<string, number>()
  const once = new Set<string>()
  const reportOnce = (address: string, message: string) => {
    const key = `${address}:${message}`
    if (once.has(key)) return
    once.add(key)
    console.error(address, message)
  }
  const previous = parseStatus(readJson(STATUS_PATH))
  const memories = new Map<string, Memory>()
  for (const row of previous?.rows ?? []) memories.set(row.address, memoryFromRow(row))
  let applied = previous?.applied ?? []

  async function readUsdc(address: Address): Promise<bigint> {
    return publicClient.readContract({
      address: chain.usdc,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [address],
    })
  }

  async function claim(address: Address, token: "eth" | "usdc"): Promise<`0x${string}` | "missing-keys"> {
    if (!chain.faucet) return "missing-keys"
    if (!cdpConfigured) return "missing-keys"
    const { CdpClient } = await import("@coinbase/cdp-sdk")
    const cdp = new CdpClient()
    const result = await cdp.evm.requestFaucet({ address, network: "base-sepolia", token })
    await publicClient.waitForTransactionReceipt({ hash: result.transactionHash })
    console.log(`${address} faucet ${token} ${result.transactionHash}`)
    return result.transactionHash
  }

  async function sweep(account: PrivateKeyAccount, treasury: Address, amount: bigint): Promise<`0x${string}`> {
    try {
      const wallet = createWalletClient({ account, chain: viemChain(chain), transport })
      const hash = await wallet.writeContract({
        address: chain.usdc,
        abi: usdcAbi,
        functionName: "transfer",
        args: [treasury, amount],
      })
      await publicClient.waitForTransactionReceipt({ hash })
      console.log(`${account.address} deposited ${hash}`)
      return hash
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(message.startsWith("Sweep failed") ? message : `Sweep failed: ${message}`)
    }
  }

  async function session(account: PrivateKeyAccount): Promise<string> {
    const cached = tokens.get(account.address)
    if (cached) return cached
    const issued = Date.now()
    const signature = await account.signMessage({ message: loginMessage(chain.id, account.address, issued) })
    const response = await fetch(`${api}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: account.address,
        signature,
        issued,
        botSecret: process.env.AGENT_SECRET,
      }),
    })
    const body = (await response.json()) as { token?: string; error?: string }
    if (!response.ok || !body.token) {
      const detail = body.error ?? "no token"
      throw new Error(detail.startsWith("Sign-in") ? detail : `Sign-in failed: ${detail}`)
    }
    tokens.set(account.address, body.token)
    return body.token
  }

  async function getState(token: string): Promise<State> {
    const response = await fetch(`${api}/api/state`, { headers: { authorization: `Bearer ${token}` } })
    if (response.status === 401) throw new Error("Sign in again")
    if (!response.ok) throw new Error("State failed")
    return (await response.json()) as State
  }

  async function step(
    index: number,
    account: PrivateKeyAccount,
    paused: boolean,
    faucetNow: boolean,
    flow: WalletFlow,
    memory: Memory,
  ): Promise<{ memory: Memory; flow: WalletFlow; faucetHandled: boolean }> {
    let next = memory
    let current = flow
    let faucetHandled = false
    let eth = memory.eth
    let chainUsdc = memory.chainUsdc
    let ledgerMicros = memory.ledgerMicros
    let roundId = memory.roundId
    let side = memory.side
    let observedRound = false
    try {
      eth = await publicClient.getBalance({ address: account.address })
      chainUsdc = await readUsdc(account.address)
      let need = needsFaucet(chain.faucet, eth, chainUsdc)
      current = seedChain(current, account.address, microsOf(chainUsdc))
      const waited = Date.now() - (faucetAt.get(account.address) ?? 0)
      const short = need.eth || need.usdc
      if (!paused && faucetNow && !short) faucetHandled = true
      if (!paused && short && (faucetNow || waited > FAUCET_WAIT_MS)) {
        faucetAt.set(account.address, Date.now())
        faucetHandled = true
        let loggedMissing = false
        const noteMissing = () => {
          if (loggedMissing) return
          loggedMissing = true
          reportOnce(account.address, "CDP keys missing")
        }
        if (need.eth) {
          const hash = await claim(account.address, "eth")
          if (hash === "missing-keys") noteMissing()
          else {
            eth = await publicClient.getBalance({ address: account.address })
            next = { ...next, faucetRequestedAt: Date.now() }
          }
        }
        if (need.usdc) {
          const before = chainUsdc
          const hash = await claim(account.address, "usdc")
          if (hash === "missing-keys") noteMissing()
          else {
            chainUsdc = await readUsdc(account.address)
            if (chainUsdc > before) {
              current = applyFlow(current, [{ key: `faucet:${hash}`, direction: "in", micros: microsOf(chainUsdc - before) }])
            }
            next = { ...next, faucetRequestedAt: Date.now() }
          }
        }
      }

      need = needsFaucet(chain.faucet, eth, chainUsdc)
      if (!need.eth && !need.usdc) next = { ...next, faucetRequestedAt: null }

      const token = await session(account)
      const state = await getState(token)
      if (state.config.chainId !== chain.id) {
        throw new Error(`Server chain ${state.config.chainId} does not match ${chain.key}`)
      }
      ledgerMicros = state.you?.balanceMicros ?? 0
      current = noteLedger(current, account.address, ledgerMicros, String(state.board.join?.id ?? "none"))
      const joinId = state.board.join?.id
      roundId = joinId ?? null
      observedRound = true
      if (!paused && chainUsdc >= ONE_USDC) {
        const amount = chainUsdc
        const hash = await sweep(account, state.config.treasury, amount)
        current = applyFlow(current, [{ key: `sweep:${hash}`, direction: "out", micros: microsOf(amount) }])
        chainUsdc = 0n
      }
      const spendable = state.you?.balanceMicros ?? 0
      let roundHandled = joinId !== undefined && betOn.get(account.address) === joinId
      if (roundHandled) side = sideFor(index, joinId!, account.address)
      if (!paused && joinId !== undefined && spendable >= USDC && !roundHandled) {
        const picked = sideFor(index, joinId, account.address)
        const response = await fetch(`${api}/api/bets`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ side: picked, stake: "1" }),
        })
        if (response.status === 401) {
          tokens.delete(account.address)
          throw new Error("Sign in again")
        }
        const body = (await response.json()) as { error?: string }
        if (!response.ok) {
          if (body.error === "You are already on the other side") {
            betOn.set(account.address, joinId)
            roundHandled = true
            side = picked === "up" ? "down" : "up"
          } else {
            throw new Error(body.error ?? "Bet failed")
          }
        } else {
          betOn.set(account.address, joinId)
          roundHandled = true
          side = picked
          current = applyFlow(current, [{ key: `bet:${account.address.toLowerCase()}:${joinId}`, direction: "out", micros: USDC }])
        }
      }
      const windows = nextWindowsSinceBet(
        { windowsSinceBet: next.windowsSinceBet, countedRound: next.countedRound },
        roundId,
        spendable,
        roundHandled,
        paused,
      )
      const cleared = !paused || next.signInError || next.chainMismatch
      next = {
        ...next,
        ...windows,
        error: cleared ? null : next.error,
        errorStreak: cleared ? 0 : next.errorStreak,
        sweepError: paused ? next.sweepError : false,
        signInError: false,
        chainMismatch: false,
        roundId,
        side: roundHandled ? side : null,
        eth,
        chainUsdc,
        ledgerMicros,
      }
      return { memory: next, flow: current, faucetHandled }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const kind = failureKind(message)
      const streak = nextErrorStreak({ error: next.error, streak: next.errorStreak }, message)
      if (streak.streak === 1) console.error(account.address, message)
      if (kind === "signin") tokens.delete(account.address)
      const windows = observedRound
        ? nextWindowsSinceBet(
            { windowsSinceBet: next.windowsSinceBet, countedRound: next.countedRound },
            roundId,
            ledgerMicros,
            false,
            paused,
          )
        : { windowsSinceBet: next.windowsSinceBet, countedRound: next.countedRound }
      return {
        memory: {
          ...next,
          ...windows,
          error: streak.error,
          errorStreak: streak.streak,
          sweepError: kind === "sweep",
          signInError: kind === "signin",
          chainMismatch: kind === "chain",
          eth,
          chainUsdc,
          ledgerMicros,
          roundId,
          side,
        },
        flow: current,
        faucetHandled,
      }
    }
  }

  function publish(rows: StatusRow[], flows: FlowFile) {
    writeJsonAtomic(STATUS_PATH, { updatedAt: Date.now(), chain: chain.key, rows, applied })
    writeJsonAtomic(FLOW_PATH, flows)
  }

  function view(index: number, account: PrivateKeyAccount, flow: WalletFlow, paused: boolean, now: number): StatusRow {
    const memory = memories.get(account.address) ?? freshMemory()
    const need = needsFaucet(chain.faucet, memory.eth, memory.chainUsdc)
    return statusRow({
      index,
      address: account.address,
      ethWei: memory.eth,
      chainUsdcMicros: memory.chainUsdc,
      ledgerMicros: memory.ledgerMicros,
      inflowMicros: flow.inflowMicros,
      outflowMicros: flow.outflowMicros,
      paused,
      needsFaucet: need.eth || need.usdc,
      error: memory.error,
      errorStreak: memory.errorStreak,
      cdpConfigured,
      faucetRequestedAt: memory.faucetRequestedAt,
      now,
      sweepError: memory.sweepError,
      signInError: memory.signInError,
      chainMismatch: memory.chainMismatch,
      windowsSinceBet: memory.windowsSinceBet,
      countedRound: memory.countedRound,
      roundId: memory.roundId,
      side: memory.side,
    })
  }

  for (;;) {
    const control = parseControl(readJson(CONTROL_PATH))
    const flows = parseFlow(readJson(FLOW_PATH))
    const queue = pendingOneShots(control, applied)
    const done: string[] = []
    const now = Date.now()
    const rows = accounts.map((account, index) =>
      view(index, account, flows[account.address.toLowerCase()] ?? emptyFlow(), control.paused.includes(account.address.toLowerCase()), now),
    )
    publish(rows, flows)

    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index]!
      const key = account.address.toLowerCase()
      const paused = control.paused.includes(key)
      for (const command of queue) {
        if (command.action === "relogin" && command.address === key) {
          tokens.delete(account.address)
          done.push(command.id)
        }
      }
      const faucetNow = queue.some((command) => command.action === "faucet" && command.address === key)
      const memory = memories.get(account.address) ?? freshMemory()
      const result = await step(index, account, paused, faucetNow, flows[key] ?? emptyFlow(), memory)
      if (result.faucetHandled) {
        for (const command of queue) {
          if (command.action === "faucet" && command.address === key) done.push(command.id)
        }
      }
      memories.set(account.address, result.memory)
      flows[key] = result.flow
      const fresh = done.filter((id) => !applied.includes(id))
      applied = [...applied, ...fresh].slice(-100)
      rows[index] = view(index, account, result.flow, paused, Date.now())
      publish(rows, flows)
    }

    await Bun.sleep(1_000)
  }
}

if (import.meta.main) await main()
