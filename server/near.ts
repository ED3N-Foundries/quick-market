import bs58 from "bs58"
import { activeChainKey, withChain } from "./activeChain"
import { loadEnv, nearTreasurySecret } from "./env"
import { getDb } from "./db"
import { normalizeAccount } from "./money"
import { credit, withdraw, youFor, type You } from "./rounds"
import {
  describeTreasury,
  isNearAccountId,
  ledgerChainConflict,
  ledgerChainMessage,
  planSeed,
  type AgentHolding,
  type Holding,
  type TreasuryReport,
} from "../shared/near"
import { MINT_CONFIRMATIONS, MINT_RECEIPT_TIMEOUT_MS } from "../shared/mint"
import { accountFromSecret, parseNearPublicKey, publicKeyBytes } from "../shared/nearKey"
import { encodeFunctionCall, jsonArgs, signTransaction } from "./nearTx"

/** A missing key or invalid NEAR token stops the process before it listens. */
export class NearConfigError extends Error {}

const GAS = 30_000_000_000_000n
const ONE_YOCTO = 1n

export type ParsedDeposit = {
  txHash: string
  logIndex: number
  from: string
  amountMicros: number
  timestamp: bigint
}

let latest: TreasuryReport | null = null
let polling = false
/** Nonce allocation. A broadcast must not sit in front of the next signature. */
let signQueue: Promise<void> = Promise.resolve()
/** In-order submission. The next transaction can already be signed. */
let broadcastQueue: Promise<void> = Promise.resolve()
let broadcasts = 0

function enqueueSign<T>(job: () => Promise<T>): Promise<T> {
  const run = signQueue.then(job, job)
  signQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function enqueueBroadcast<T>(job: () => Promise<T>): Promise<T> {
  broadcasts += 1
  const run = broadcastQueue.then(job, job)
  const done = run.finally(() => {
    broadcasts -= 1
  })
  broadcastQueue = done.then(
    () => undefined,
    () => undefined,
  )
  return done
}

export function currentTreasuryReport(): TreasuryReport | null {
  return latest
}

export function nearRpcUrl(): string {
  return nearRpcEndpoints()[0]?.url ?? NEAR_FALLBACK_RPC
}

function signingKey(): string {
  return nearTreasurySecret()
}

export function nearFaultMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  if (
    message.includes("not enough balance") ||
    message.includes("insufficient") ||
    message.includes("lackbalance") ||
    message.includes("does not have enough balance")
  ) {
    return "Treasury needs NEAR for gas."
  }
  return "Treasury could not prepare the withdraw"
}

function rpcErrorText(error: { message?: string; data?: unknown; name?: string; cause?: unknown }): string {
  if (typeof error.data === "string" && error.data) return error.data
  if (error.data !== undefined && error.data !== null) {
    const encoded = JSON.stringify(error.data)
    if (encoded && encoded !== "{}" && encoded !== "null") return encoded
  }
  const name = typeof error.name === "string" ? error.name : ""
  if (error.cause !== undefined && error.cause !== null) {
    const encoded = JSON.stringify(error.cause)
    if (encoded && encoded !== "{}" && encoded !== "null") return name ? `${name} ${encoded}` : encoded
  }
  if (name) return error.message ? `${name} ${error.message}` : name
  return error.message || "NEAR RPC failed"
}

/** Official public testnet node. About 30 calls a minute, so it is not a default hop. */
export const NEAR_PUBLIC_RPC = "https://rpc.testnet.near.org"
/** Free FastNear testnet node. Patient enough for a send that waits to be included. */
export const NEAR_FALLBACK_RPC = "https://test.rpc.fastnear.com"
/** dRPC's free tier cuts a call off at 2 seconds. Stay under that. */
export const NEAR_DRPC = "https://near-testnet.drpc.org"

export const NEAR_RPC_SLOTS = 4

export type NearRpcEndpoint = {
  url: string
  /** Ceiling for a read. A caller can ask for less. */
  timeoutMs: number
  /** Ceiling for send_tx. A node that cuts the socket early stays short. */
  sendTimeoutMs: number
  /** How long a busy endpoint stays out of the next call. */
  backoffMs: number
}

/** Preference order when NEAR_RPC_1..4 are unset. The official node is omitted on purpose. */
export const DEFAULT_NEAR_RPCS: readonly NearRpcEndpoint[] = [
  { url: NEAR_DRPC, timeoutMs: 1_800, sendTimeoutMs: 1_800, backoffMs: 1_000 },
  { url: NEAR_FALLBACK_RPC, timeoutMs: 4_000, sendTimeoutMs: 20_000, backoffMs: 1_500 },
  { url: "https://api.zan.top/near-testnet", timeoutMs: 4_000, sendTimeoutMs: 8_000, backoffMs: 1_500 },
  { url: "https://testnet-rpc.intea.rs", timeoutMs: 4_000, sendTimeoutMs: 8_000, backoffMs: 2_000 },
]

/** A send that waits for inclusion starts on an endpoint at least this patient. */
const PATIENT_SEND_MS = 8_000

/** A status read should return quickly. send_tx may wait to be included, on a patient endpoint. */
const STATUS_FETCH_MS = 8_000
const SEND_FETCH_MS = 20_000
/** Signing only needs a recent block hash. */
const SIGN_FETCH_MS = 2_000
/** A NEAR block hash stays valid for about a minute. Refresh well inside that. */
export const NONCE_TTL_MS = 30_000
const STATUS_POLL_MS = 1_500
const NEAR_GRANT_POLL_MS = 300
/** dRPC answers 403 to an empty user agent. */
const NEAR_RPC_USER_AGENT = "quick-market"

const NEAR_RPC_LINE = /^(https?:\/\/\S+)\s+(\d+)\s+(\d+)\s+(\d+)$/

const quietUntil = new Map<string, number>()

type NearRpcAttempt = {
  attempts: number
  successes: number
  failures: number
  lastAttemptAt: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastMs: number
  lastMethod: string
  lastError: string | null
}

const rpcAttempts = new Map<string, NearRpcAttempt>()

export type NearRpcEndpointStatus = NearRpcEndpoint & {
  state: "ready" | "cooling" | "error" | "unused"
  attempts: number
  successes: number
  failures: number
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastMs: number | null
  lastMethod: string | null
  lastError: string | null
  quietForMs: number
}

export function nearRpcStatus(now = Date.now(), endpoints = nearRpcEndpoints()): NearRpcEndpointStatus[] {
  return endpoints.map((endpoint) => {
    const attempt = rpcAttempts.get(endpoint.url)
    const quietForMs = Math.max(0, (quietUntil.get(endpoint.url) ?? 0) - now)
    const state = quietForMs > 0 ? "cooling" : attempt?.lastError ? "error" : attempt ? "ready" : "unused"
    return {
      ...endpoint,
      state,
      attempts: attempt?.attempts ?? 0,
      successes: attempt?.successes ?? 0,
      failures: attempt?.failures ?? 0,
      lastAttemptAt: attempt?.lastAttemptAt ?? null,
      lastSuccessAt: attempt?.lastSuccessAt ?? null,
      lastFailureAt: attempt?.lastFailureAt ?? null,
      lastMs: attempt?.lastMs ?? null,
      lastMethod: attempt?.lastMethod ?? null,
      lastError: attempt?.lastError ?? null,
      quietForMs,
    }
  })
}

export function resetNearRpcQuiet(): void {
  quietUntil.clear()
  rpcAttempts.clear()
}

function blankEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** `url timeout_ms send_timeout_ms backoff_ms`. Timeouts are capped so one hop cannot stall the book. */
export function parseNearRpcLine(line: string): NearRpcEndpoint {
  const match = line.trim().match(NEAR_RPC_LINE)
  if (!match) throw new Error("NEAR_RPC must be a url, a timeout in ms, a send timeout in ms, and a backoff in ms")
  const timeoutMs = Number(match[2])
  const sendTimeoutMs = Number(match[3])
  const backoffMs = Number(match[4])
  if (!Number.isInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 30_000) {
    throw new Error("NEAR_RPC timeout must be between 200 and 30000 ms")
  }
  if (!Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 200 || sendTimeoutMs > 30_000) {
    throw new Error("NEAR_RPC send timeout must be between 200 and 30000 ms")
  }
  if (!Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > 120_000) {
    throw new Error("NEAR_RPC backoff must be between 0 and 120000 ms")
  }
  return { url: match[1].replace(/\/$/, ""), timeoutMs, sendTimeoutMs, backoffMs }
}

/** NEAR_RPC_1..4 replace the default list. A legacy NEAR RPC_URL is one endpoint. Base URLs are ignored. */
export function nearRpcEndpoints(env: Record<string, string | undefined> = process.env): NearRpcEndpoint[] {
  for (const key of Object.keys(env)) {
    const slot = /^NEAR_RPC_(\d+)$/.exec(key)
    if (slot && Number(slot[1]) > NEAR_RPC_SLOTS && blankEnv(env[key])) throw new Error("NEAR RPC list holds 4 endpoints")
  }
  const lines = [1, 2, 3, 4]
    .map((slot) => blankEnv(env[`NEAR_RPC_${slot}`]))
    .filter((line): line is string => line !== undefined)
  if (lines.length > 0) return lines.map(parseNearRpcLine)
  const custom = blankEnv(env.RPC_URL)
  if (custom && custom.includes("near")) {
    return [{ url: custom.replace(/\/$/, ""), timeoutMs: STATUS_FETCH_MS, sendTimeoutMs: SEND_FETCH_MS, backoffMs: 1_000 }]
  }
  return DEFAULT_NEAR_RPCS.map((endpoint) => ({ ...endpoint }))
}

/** Prefer ready endpoints, but keep cooling endpoints available as fallbacks within the same call. */
export function nearRpcOrder(
  endpoints: readonly NearRpcEndpoint[],
  now: number,
  quiet: ReadonlyMap<string, number>,
): NearRpcEndpoint[] {
  const ready = endpoints.filter((endpoint) => (quiet.get(endpoint.url) ?? 0) <= now)
  const cooling = endpoints
    .filter((endpoint) => (quiet.get(endpoint.url) ?? 0) > now)
    .sort((a, b) => (quiet.get(a.url) ?? 0) - (quiet.get(b.url) ?? 0))
  return [...ready, ...cooling]
}

/** A waiting send starts on a patient endpoint. A broadcast (NONE) keeps preference order, so dRPC can accept it. */
export function nearSendOrder(endpoints: readonly NearRpcEndpoint[], waitUntil: string | undefined): NearRpcEndpoint[] {
  if (!waitUntil || waitUntil === "NONE") return [...endpoints]
  const patient = endpoints.filter((endpoint) => endpoint.sendTimeoutMs >= PATIENT_SEND_MS)
  const quick = endpoints.filter((endpoint) => endpoint.sendTimeoutMs < PATIENT_SEND_MS)
  return patient.length > 0 ? [...patient, ...quick] : [...endpoints]
}

function waitUntilOf(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || !("wait_until" in params)) return undefined
  const value = (params as { wait_until?: unknown }).wait_until
  return typeof value === "string" ? value : undefined
}

/** A timed-out, refused, or unreachable call can move to the next endpoint. An execution failure cannot. */
export function nearRpcBusy(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError" || error.name === "SyntaxError")
  ) {
    return true
  }
  const text = nearErrorText(error)
  if (text === "Server error" || text.startsWith("NEAR RPC returned")) return true
  const lower = text.toLowerCase()
  if (lower.includes("timeout_error") || lower.includes("timed out") || lower.includes("timeout")) return true
  if (historyMissingText(lower)) return true
  return (
    lower.includes("fetch failed") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("unable to connect") ||
    lower.includes("socket")
  )
}

function nearErrorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") return rpcErrorText(error as { message?: string; data?: unknown; name?: string; cause?: unknown })
  return ""
}

async function rpcOnce(url: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": NEAR_RPC_USER_AGENT },
    body: JSON.stringify({ jsonrpc: "2.0", id: "quick-market", method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  // A pruned block comes back as HTTP 422 from dRPC and FastNear, with the reason in the JSON body.
  const body = (await response.json().catch(() => null)) as {
    result?: unknown
    error?: { message?: string; data?: unknown; name?: string; cause?: unknown }
  } | null
  if (body?.error) throw new Error(rpcErrorText(body.error))
  if (!response.ok || !body) throw new Error(`NEAR RPC returned ${response.status}`)
  return body.result
}

/**
 * Walk the list once. A busy hop is parked for its backoff and the call tries the next.
 * send_tx hops share one budget, the longest send timeout, so a 2-second node cannot stack into a minute.
 */
export async function callNearRpc(
  endpoints: readonly NearRpcEndpoint[],
  method: string,
  params: unknown,
  options?: { timeoutMs?: number },
): Promise<unknown> {
  const send = method === "send_tx"
  let ordered = nearRpcOrder(endpoints, Date.now(), quietUntil)
  if (send) ordered = nearSendOrder(ordered, waitUntilOf(params))
  const budget = send ? Math.max(0, ...endpoints.map((endpoint) => endpoint.sendTimeoutMs)) : 0
  const started = Date.now()
  let last = "NEAR RPC failed"
  for (const endpoint of ordered) {
    const remaining = budget - (Date.now() - started)
    if (send && remaining < 200) break
    const timeoutMs = send
      ? Math.min(endpoint.sendTimeoutMs, remaining)
      : Math.min(endpoint.timeoutMs, options?.timeoutMs ?? endpoint.timeoutMs)
    const attemptStarted = Date.now()
    const previous = rpcAttempts.get(endpoint.url)
    try {
      const result = await rpcOnce(endpoint.url, method, params, timeoutMs)
      quietUntil.delete(endpoint.url)
      rpcAttempts.set(endpoint.url, {
        attempts: (previous?.attempts ?? 0) + 1,
        successes: (previous?.successes ?? 0) + 1,
        failures: previous?.failures ?? 0,
        lastAttemptAt: attemptStarted,
        lastSuccessAt: Date.now(),
        lastFailureAt: previous?.lastFailureAt ?? null,
        lastMs: Date.now() - attemptStarted,
        lastMethod: method,
        lastError: null,
      })
      return result
    } catch (error) {
      last = rpcFailureText(error)
      rpcAttempts.set(endpoint.url, {
        attempts: (previous?.attempts ?? 0) + 1,
        successes: previous?.successes ?? 0,
        failures: (previous?.failures ?? 0) + 1,
        lastAttemptAt: attemptStarted,
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        lastFailureAt: Date.now(),
        lastMs: Date.now() - attemptStarted,
        lastMethod: method,
        lastError: last.slice(0, 300),
      })
      if (!nearRpcBusy(error) && !nearRpcBusy(new Error(last))) break
      quietUntil.set(endpoint.url, Date.now() + endpoint.backoffMs)
    }
  }
  throw new Error(last)
}

async function rpc(
  method: string,
  params: unknown,
  options?: { attempts?: number; timeoutMs?: number },
): Promise<unknown> {
  return callNearRpc(nearRpcEndpoints(), method, params, options)
}

function rpcFailureText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (error instanceof Error && error.name) return error.name
  return "NEAR RPC failed"
}

function missingAccount(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return message.includes("does not exist") || message.includes("unknown account") || message.includes("access key")
}

export async function readNearBalance(account: string): Promise<{ exists: boolean; yocto: bigint }> {
  try {
    const result = (await rpc("query", {
      request_type: "view_account",
      finality: "final",
      account_id: account,
    })) as { amount?: string }
    return { exists: true, yocto: BigInt(result.amount ?? "0") }
  } catch (error) {
    if (missingAccount(error)) return { exists: false, yocto: 0n }
    throw error
  }
}

async function viewCall(contract: string, method: string, args: unknown): Promise<unknown> {
  const result = (await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  })) as { result?: number[] }
  const text = new TextDecoder().decode(Uint8Array.from(result.result ?? []))
  return text ? JSON.parse(text) : null
}

export async function readTokenBalance(contract: string, account: string): Promise<bigint> {
  try {
    const balance = await viewCall(contract, "ft_balance_of", { account_id: account })
    if (typeof balance !== "string" || !/^\d+$/.test(balance)) return 0n
    return BigInt(balance)
  } catch (error) {
    if (missingAccount(error)) return 0n
    throw error
  }
}

export async function readTokenMetadata(contract: string): Promise<{ symbol: string; decimals: number }> {
  const meta = (await viewCall(contract, "ft_metadata", {})) as { symbol?: unknown; decimals?: unknown }
  return {
    symbol: typeof meta.symbol === "string" ? meta.symbol : "",
    decimals: typeof meta.decimals === "number" ? meta.decimals : -1,
  }
}

export function assertQmMetadata(meta: { symbol: string; decimals: number }) {
  if (meta.symbol !== "QM" || meta.decimals !== 6) {
    throw new NearConfigError("TOKEN_ACCOUNT must be quick-market QM with 6 decimals.")
  }
}

/** Optimistic is enough to sign. Final waits for a block the transaction does not need. */
export function signingKeyQuery(account: string, publicKey: string) {
  return {
    request_type: "view_access_key" as const,
    finality: "optimistic" as const,
    account_id: account,
    public_key: publicKey,
  }
}

export function nonceCacheFresh(at: number, now: number): boolean {
  return now >= at && now - at <= NONCE_TTL_MS
}

/** Invalid nonce or a stale block hash. An executed action error is not a reason to sign again. */
export function nearNonceRejected(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : typeof error === "string" ? error : "").toLowerCase()
  if (message.includes("invalidnonce")) return true
  if (message.includes("actionerror") || message.includes("functioncallerror")) return false
  return message.includes("invalidtxerror") && message.includes("expired")
}

type NonceCache = { account: string; nonce: bigint; blockHash: Uint8Array; at: number }
let nonceCache: NonceCache | null = null

async function readNonce(account: string, secretKey: string): Promise<{ nonce: bigint; blockHash: Uint8Array; publicKey: Uint8Array }> {
  const publicKey = await publicKeyBytes(secretKey)
  if (!publicKey) throw new Error("TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
  const result = (await rpc("query", signingKeyQuery(account, `ed25519:${bs58.encode(publicKey)}`), {
    attempts: 1,
    timeoutMs: SIGN_FETCH_MS,
  })) as { nonce?: number; block_hash?: string }
  if (typeof result.block_hash !== "string") throw new Error("Treasury access key is missing")
  return { nonce: BigInt(result.nonce ?? 0) + 1n, blockHash: bs58.decode(result.block_hash), publicKey }
}

async function allocateNonce(
  account: string,
  secretKey: string,
  refresh: boolean,
): Promise<{ nonce: bigint; blockHash: Uint8Array; publicKey: Uint8Array }> {
  const now = Date.now()
  if (!refresh && nonceCache && nonceCache.account === account && nonceCacheFresh(nonceCache.at, now)) {
    const publicKey = await publicKeyBytes(secretKey)
    if (!publicKey) throw new Error("TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
    return { nonce: nonceCache.nonce, blockHash: nonceCache.blockHash, publicKey }
  }
  const fresh = await readNonce(account, secretKey)
  nonceCache = { account, nonce: fresh.nonce, blockHash: fresh.blockHash, at: now }
  return fresh
}

function commitNonce(account: string, used: bigint) {
  if (!nonceCache || nonceCache.account !== account || nonceCache.nonce !== used) return
  nonceCache = { ...nonceCache, nonce: used + 1n, at: Date.now() }
}

/** Included and not-yet-executed replies use a string status. Only an object can be a Failure. */
export function nearExecutionFailed(status: unknown): { failed: true; reason: string } | { failed: false } {
  if (!status || typeof status !== "object" || !("Failure" in status)) return { failed: false }
  return { failed: true, reason: JSON.stringify(status.Failure) }
}

type SignedNear = { hash: string; raw: string }

async function signUnderLock(input: {
  signerId: string
  secretKey: string
  receiverId: string
  actions: number[][]
  refresh?: boolean
  onSigned?: (hash: string) => void
}): Promise<SignedNear> {
  return enqueueSign(async () => {
    const viewed = await allocateNonce(input.signerId, input.secretKey, input.refresh === true)
    const signed = await signTransaction({
      signerId: input.signerId,
      secretKey: input.secretKey,
      nonce: viewed.nonce,
      receiverId: input.receiverId,
      blockHash: viewed.blockHash,
      actions: input.actions,
    })
    input.onSigned?.(signed.hash)
    commitNonce(input.signerId, viewed.nonce)
    return { hash: signed.hash, raw: Buffer.from(signed.signed).toString("base64") }
  })
}

async function sendOnce(
  raw: string,
  waitUntil: "NONE" | "INCLUDED" | "EXECUTED" | "FINAL",
): Promise<{ status?: unknown; transaction?: { hash?: string } }> {
  const result = (await rpc("send_tx", {
    signed_tx_base64: raw,
    wait_until: waitUntil,
  })) as { status?: unknown; transaction?: { hash?: string } }
  const execution = nearExecutionFailed(result?.status)
  if (execution.failed) throw new Error(execution.reason)
  return result
}

async function submit(input: {
  signerId: string
  secretKey: string
  receiverId: string
  actions: number[][]
  waitUntil?: "NONE" | "INCLUDED" | "EXECUTED" | "FINAL"
  /** A lost response can still be polled. The hash is known before the RPC answers. */
  recoverHash?: boolean
  onSigned?: (hash: string) => void
}): Promise<string> {
  const waitUntil = input.waitUntil ?? "EXECUTED"
  const signed = await signUnderLock(input)
  return enqueueBroadcast(async () => {
    try {
      const result = await sendOnce(signed.raw, waitUntil)
      return result.transaction?.hash ?? signed.hash
    } catch (error) {
      if (input.recoverHash && nearSubmitLost(error)) return signed.hash
      // Only the tail can reuse the chain nonce. A later signature is already queued behind this send.
      if (broadcasts !== 1 || !nearNonceRejected(error)) throw error
      const again = await signUnderLock({ ...input, refresh: true })
      try {
        const result = await sendOnce(again.raw, waitUntil)
        return result.transaction?.hash ?? again.hash
      } catch (retryError) {
        if (input.recoverHash && nearSubmitLost(retryError)) return again.hash
        throw retryError
      }
    }
  })
}

/** A rejected transaction stays a failure. A timeout or a dropped socket can still land. */
function nearSubmitLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  if (message.includes("invalidtx") || message.includes("actionerror") || message.includes("functioncallerror")) return false
  if (nearRpcBusy(error)) return true
  return (
    message.includes("aborted") ||
    message.includes("socket") ||
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("connection reset") ||
    message.includes("connection closed") ||
    message.includes("unable to connect")
  )
}

export type NearGrantStatus = {
  status?: { Failure?: unknown; SuccessValue?: unknown; SuccessReceiptId?: unknown }
  final_execution_status?: unknown
}

function nearTxFailed(result: NearGrantStatus): boolean {
  return nearExecutionFailed(result.status).failed
}

/**
 * Step 1 is a known hash. Execution is step 2. Final is step 3.
 * A success value with no finality field is already executed.
 */
export function nearGrantSeen(result: NearGrantStatus | null): { failed: boolean; seen: number } {
  if (!result) return { failed: false, seen: 1 }
  if (nearTxFailed(result)) return { failed: true, seen: 1 }
  const level = typeof result.final_execution_status === "string" ? result.final_execution_status : ""
  if (level === "FINAL") return { failed: false, seen: MINT_CONFIRMATIONS }
  if (level === "EXECUTED" || level === "EXECUTED_OPTIMISTIC") return { failed: false, seen: MINT_CONFIRMATIONS - 1 }
  const status = result.status
  if (status && typeof status === "object" && ("SuccessValue" in status || "SuccessReceiptId" in status)) {
    return { failed: false, seen: MINT_CONFIRMATIONS - 1 }
  }
  return { failed: false, seen: 1 }
}

/**
 * One poll of a grant. Execution credits it. Finality is not another wait.
 * A timeout before execution does not credit.
 */
export function nextNearGrantWatch(input: {
  elapsedMs: number
  deadlineMs: number
  seen: number
  status: NearGrantStatus | null
}): { seen: number; done: boolean; failed: boolean } {
  const step = nearGrantSeen(input.status)
  if (step.failed) return { seen: input.seen, done: false, failed: true }
  const seen = Math.max(input.seen, step.seen)
  // Execution credits the grant. Finality is not another wait.
  if (seen >= MINT_CONFIRMATIONS - 1) return { seen: MINT_CONFIRMATIONS, done: true, failed: false }
  if (input.elapsedMs >= input.deadlineMs) return { seen, done: false, failed: true }
  return { seen, done: false, failed: false }
}

async function readNearGrantStatus(signerId: string, hash: string): Promise<NearGrantStatus | null> {
  try {
    return (await rpc(
      "EXPERIMENTAL_tx_status",
      { tx_hash: hash, sender_account_id: signerId, wait_until: "NONE" },
      { attempts: 1, timeoutMs: STATUS_POLL_MS },
    )) as NearGrantStatus
  } catch {
    return null
  }
}

/** Poll the saved hash. A blocking FINAL wait holds the slot when the public RPC is slow. Does not send another transaction. */
export async function watchNearGrant(
  signerId: string,
  hash: string,
  report: (progress: { txHash?: string; seen: number }) => void,
): Promise<void> {
  report({ txHash: hash, seen: 1 })
  const started = Date.now()
  let seen = 1
  while (seen < MINT_CONFIRMATIONS) {
    const elapsed = Date.now() - started
    const status = elapsed < MINT_RECEIPT_TIMEOUT_MS ? await readNearGrantStatus(signerId, hash) : null
    const next = nextNearGrantWatch({
      elapsedMs: Date.now() - started,
      deadlineMs: MINT_RECEIPT_TIMEOUT_MS,
      seen,
      status,
    })
    if (next.seen > seen) report({ seen: next.seen })
    seen = next.seen
    if (next.failed) {
      if (status && nearTxFailed(status)) throw new Error(JSON.stringify(status.status?.Failure))
      throw new Error(`Mint timed out ${hash}`)
    }
    if (next.done) return
    await new Promise((resolve) => setTimeout(resolve, NEAR_GRANT_POLL_MS))
  }
}

export function ledgerSumMicros(): bigint {
  const row = getDb()
    .query("SELECT COALESCE(SUM(balance_micros), 0) AS total FROM users WHERE chain_key = ?")
    .get(activeChainKey()) as { total: number | bigint | null }
  if (row.total === null) return 0n
  return typeof row.total === "bigint" ? row.total : BigInt(row.total)
}

export function userAddresses(): string[] {
  const rows = getDb().query("SELECT address FROM users WHERE chain_key = ?").all(activeChainKey()) as { address: string }[]
  return rows.map((row) => row.address)
}

export function assertLedgerChain(chainKey: "base" | "base-sepolia" | "near-testnet", dbPath: string) {
  const conflict = ledgerChainConflict(userAddresses(), chainKey)
  if (conflict) throw new NearConfigError(ledgerChainMessage(conflict, dbPath))
}

export async function accessKeyOnAccount(account: string, publicKey: string): Promise<boolean> {
  const parsed = parseNearPublicKey(publicKey)
  if (!parsed) return false
  try {
    await rpc("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: account,
      public_key: publicKey.trim(),
    })
    return true
  } catch (error) {
    if (missingAccount(error)) return false
    throw error
  }
}

async function holding(account: string, token: string, withToken: boolean): Promise<Holding> {
  const balance = await readNearBalance(account)
  const tokenMicros = withToken && balance.exists ? await readTokenBalance(token, account) : 0n
  return { exists: balance.exists, nearYocto: balance.yocto, tokenMicros }
}

export async function collectHoldings(treasury: string, agents: string[]): Promise<{ treasury: Holding; agents: AgentHolding[] }> {
  const token = loadEnv().tokenAccount.trim()
  const treasuryHolding = await holding(treasury, token, true)
  const rows: AgentHolding[] = []
  for (const account of agents) {
    const balance = await readNearBalance(account)
    rows.push({ account, holding: { exists: balance.exists, nearYocto: balance.yocto, tokenMicros: 0n } })
  }
  return { treasury: treasuryHolding, agents: rows }
}

/** A failed read has no balance. Keep the error line and do not publish the zero placeholders as holdings. */
function uncheckedReport(treasury: string, agents: string[], error: unknown): TreasuryReport {
  const line = error instanceof Error ? error.message : "NEAR check failed"
  const report = describeTreasury({
    account: treasury,
    treasury: { exists: false, nearYocto: 0n, tokenMicros: 0n },
    ledgerMicros: 0n,
    agents: agents.map((account) => ({ account, holding: { exists: false, nearYocto: 0n, tokenMicros: 0n } })),
  })
  report.ok = false
  report.lines = [line]
  return report
}

function failedReport(treasury: string, agents: string[], error: unknown): TreasuryReport {
  const report = uncheckedReport(treasury, agents, error)
  latest = report
  for (const row of report.lines) console.error(row)
  return report
}

function publishReport(report: TreasuryReport): TreasuryReport {
  latest = report
  if (!report.ok) for (const line of report.lines) console.error(line)
  return report
}

export async function bootNear(treasury: string): Promise<TreasuryReport> {
  const env = loadEnv()
  const token = env.tokenAccount.trim()
  assertLedgerChain("near-testnet", env.dbPath)
  try {
    assertQmMetadata(await readTokenMetadata(token))
  } catch (error) {
    if (error instanceof NearConfigError) throw error
    if (missingAccount(error)) throw new NearConfigError("TOKEN_ACCOUNT must be quick-market QM with 6 decimals.")
    return failedReport(treasury, [], error)
  }
  try {
    const first = await collectHoldings(treasury, [])
    const planned = planSeed({ treasury: first.treasury, ledgerMicros: ledgerSumMicros(), agents: [] })
    if (planned.mintMicros > 0n) {
      await submit({
        signerId: treasury,
        secretKey: signingKey(),
        receiverId: token,
        actions: [encodeFunctionCall("mint", jsonArgs({ account_id: treasury, amount: planned.mintMicros.toString() }), GAS, 0n)],
      })
    }
    const second = await collectHoldings(treasury, [])
    return publishReport(describeTreasury({ account: treasury, treasury: second.treasury, ledgerMicros: ledgerSumMicros(), agents: [] }))
  } catch (error) {
    if (error instanceof NearConfigError) throw error
    return failedReport(treasury, [], error)
  }
}

export async function sendNearActions(input: {
  signerId: string
  secretKey: string
  receiverId: string
  actions: number[][]
}): Promise<string> {
  return submit(input)
}

export async function inspectNear(treasury: string): Promise<TreasuryReport> {
  try {
    const read = await collectHoldings(treasury, [])
    const report = describeTreasury({ account: treasury, treasury: read.treasury, ledgerMicros: ledgerSumMicros(), agents: [] })
    latest = report
    return report
  } catch (error) {
    const report = uncheckedReport(treasury, [], error)
    latest = report
    return report
  }
}

export async function mintNearToTreasury(
  amountMicros: number,
  report?: (progress: { txHash?: string; seen: number }) => void,
): Promise<void> {
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new Error("Amount is invalid")
  const env = loadEnv()
  const treasury = await accountFromSecret(signingKey())
  if (!treasury) throw new Error("TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
  const hash = await submit({
    signerId: treasury,
    secretKey: signingKey(),
    receiverId: env.tokenAccount.trim(),
    actions: [encodeFunctionCall("mint", jsonArgs({ account_id: treasury, amount: String(amountMicros) }), GAS, 0n)],
    waitUntil: "NONE",
    recoverHash: true,
    onSigned: (hash) => report?.({ txHash: hash, seen: 1 }),
  })
  await watchNearGrant(treasury, hash, (progress) => report?.(progress))
}

function debitWithdraw(address: string, amountMicros: number, raw: string, hash: string): string {
  const id = crypto.randomUUID()
  const tx = getDb().transaction(() => {
    const held = withdraw(address, amountMicros)
    if (!held.ok) throw new Error(held.error)
    getDb()
      .query(
        `INSERT INTO withdrawals (chain_key, id, address, amount_micros, tx_hash, raw_tx, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(activeChainKey(), id, address, amountMicros, hash, raw, Date.now())
  })
  tx()
  return id
}

function refundWithdraw(id: string) {
  const row = getDb().query("SELECT address, amount_micros, status FROM withdrawals WHERE chain_key = ? AND id = ?").get(activeChainKey(), id) as
    | { address: string; amount_micros: number; status: string }
    | null
  if (!row || row.status !== "pending") return
  const tx = getDb().transaction(() => {
    const added = credit(row.address, row.amount_micros)
    if (!added.ok) throw new Error(added.error)
    getDb()
      .query("UPDATE withdrawals SET status = 'refunded' WHERE chain_key = ? AND id = ? AND status = 'pending'")
      .run(activeChainKey(), id)
  })
  tx()
}

async function broadcastRaw(raw: string): Promise<void> {
  const result = (await rpc("send_tx", {
    signed_tx_base64: raw,
    wait_until: "EXECUTED",
  })) as { status?: { Failure?: unknown } }
  if (result.status && "Failure" in result.status) throw new Error(JSON.stringify(result.status.Failure))
}

export async function requestNearWithdraw(
  address: string,
  amountMicros: number,
): Promise<{ ok: true; you: You; txHash: string } | { ok: false; error: string; you?: You }> {
  const who = normalizeAccount(address, "near-testnet")
  const you = who ? youFor(who) : null
  if (!who || !you) return { ok: false, error: "Unknown wallet" }
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) return { ok: false, error: "Amount is invalid" }
  if (amountMicros > you.balanceMicros) return { ok: false, error: "Insufficient balance" }
  const env = loadEnv()
  const treasury = await accountFromSecret(signingKey())
  if (!treasury) return { ok: false, error: "TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key" }
  const transfer = {
    signerId: treasury,
    secretKey: signingKey(),
    receiverId: env.tokenAccount.trim(),
    actions: [
      encodeFunctionCall(
        "ft_transfer",
        jsonArgs({ receiver_id: who, amount: String(amountMicros), memo: null }),
        GAS,
        ONE_YOCTO,
      ),
    ],
  }
  let id = ""
  let signed: SignedNear
  try {
    const prepared = await enqueueSign(async () => {
      const current = youFor(who)
      if (!current || amountMicros > current.balanceMicros) throw new Error("Insufficient balance")
      const viewed = await allocateNonce(treasury, signingKey(), false)
      const tx = await signTransaction({
        signerId: transfer.signerId,
        secretKey: transfer.secretKey,
        nonce: viewed.nonce,
        receiverId: transfer.receiverId,
        blockHash: viewed.blockHash,
        actions: transfer.actions,
      })
      const raw = Buffer.from(tx.signed).toString("base64")
      const nextId = debitWithdraw(who, amountMicros, raw, tx.hash)
      commitNonce(treasury, viewed.nonce)
      return { hash: tx.hash, raw, id: nextId }
    })
    signed = prepared
    id = prepared.id
  } catch (error) {
    const message = error instanceof Error ? error.message : "Withdrawal failed"
    if (message === "Insufficient balance" || message === "Unknown wallet" || message === "Amount is invalid") {
      return { ok: false, error: message, you: youFor(who) ?? undefined }
    }
    return { ok: false, error: nearFaultMessage(error), you: youFor(who) ?? you }
  }
  try {
    await enqueueBroadcast(async () => {
      try {
        await broadcastRaw(signed.raw)
      } catch (error) {
        if (broadcasts !== 1 || !nearNonceRejected(error)) throw error
        refundWithdraw(id)
        const again = await signUnderLock({ ...transfer, refresh: true })
        id = debitWithdraw(who, amountMicros, again.raw, again.hash)
        signed = again
        await broadcastRaw(again.raw)
      }
    })
    getDb()
      .query("UPDATE withdrawals SET status = 'sent' WHERE chain_key = ? AND id = ? AND status = 'pending'")
      .run(activeChainKey(), id)
    return { ok: true, you: youFor(who)!, txHash: signed.hash }
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ""
    if (nearNonceRejected(error) || message.includes("failure") || message.includes("revert") || message.includes("not enough")) {
      refundWithdraw(id)
      return { ok: false, error: nearFaultMessage(error), you: youFor(who) ?? undefined }
    }
    console.error(error)
    return { ok: false, error: "Withdrawal is pending", you: youFor(who) ?? undefined }
  }
}

export function parseNearDeposits(payload: unknown, treasury: string, token: string, timestamp = 0n): ParsedDeposit[] {
  if (!payload || typeof payload !== "object") return []
  const body = payload as { transaction?: { hash?: unknown }; receipts_outcome?: unknown }
  const hash = typeof body.transaction?.hash === "string" ? body.transaction.hash : ""
  if (!hash || !Array.isArray(body.receipts_outcome)) return []
  const deposits: ParsedDeposit[] = []
  for (const receipt of body.receipts_outcome) {
    if (!receipt || typeof receipt !== "object") continue
    const outcome = (receipt as { outcome?: unknown }).outcome
    if (!outcome || typeof outcome !== "object") continue
    const execution = outcome as { executor_id?: unknown; status?: unknown; logs?: unknown }
    if (execution.executor_id !== token || !Array.isArray(execution.logs)) continue
    if (execution.status && typeof execution.status === "object" && "Failure" in execution.status) continue
    for (let logIndex = 0; logIndex < execution.logs.length; logIndex += 1) {
      const log = execution.logs[logIndex]
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue
      let event: { standard?: unknown; event?: unknown; data?: unknown }
      try {
        event = JSON.parse(log.slice("EVENT_JSON:".length))
      } catch {
        continue
      }
      if (event.standard !== "nep141" || event.event !== "ft_transfer" || !Array.isArray(event.data)) continue
      for (const item of event.data) {
        if (!item || typeof item !== "object") continue
        const row = item as Record<string, unknown>
        const from = typeof row.old_owner_id === "string" ? row.old_owner_id : ""
        const to = typeof row.new_owner_id === "string" ? row.new_owner_id : ""
        const amount = typeof row.amount === "string" ? row.amount : ""
        if (to !== treasury || !isNearAccountId(from) || from === treasury || from === token) continue
        if (!/^\d+$/.test(amount)) continue
        const micros = Number(amount)
        if (!Number.isSafeInteger(micros) || micros <= 0) continue
        deposits.push({ txHash: hash, logIndex: deposits.length, from, amountMicros: micros, timestamp })
      }
    }
  }
  return deposits
}

export function applyNearDeposit(input: ParsedDeposit): boolean {
  const run = getDb().transaction(() => {
    const inserted = getDb()
      .query(
        `INSERT INTO deposits (chain_key, tx_hash, log_index, address, amount_micros, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(activeChainKey(), input.txHash, input.logIndex, input.from, input.amountMicros, Date.now())
    if (inserted.changes === 0) return false
    const added = credit(input.from, input.amountMicros)
    if (!added.ok) throw new Error(added.error)
    return true
  })
  return run()
}

type NearBlock = {
  header: { height: number; timestamp_nanosec?: string }
  chunks: { chunk_hash: string; gas_used: string }[]
}

async function nearBlock(height?: number): Promise<NearBlock> {
  return (await rpc("block", height === undefined ? { finality: "final" } : { block_id: height })) as NearBlock
}

/** Blocks older than this are gone from the free non-archival nodes. A shorter gap may still be propagating. */
export const PRUNED_DEPOSIT_GAP = 120

/** When every endpoint has dropped this history, resume just before the head so new deposits still land. */
export function prunedDepositResume(cursor: number, head: number): number | null {
  if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(head)) return null
  if (head - cursor <= PRUNED_DEPOSIT_GAP) return null
  const resume = head - 1
  return resume > cursor ? resume : null
}

function historyMissingText(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes("db not found") ||
    lower.includes("unknown block") ||
    lower.includes("unknown_block") ||
    lower.includes("unknown chunk") ||
    lower.includes("unknown_chunk")
  )
}

export function nearHistoryMissing(error: unknown): boolean {
  return historyMissingText(error instanceof Error ? error.message : "")
}

function saveDepositCursor(cursorKey: string, height: number) {
  getDb()
    .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(cursorKey, String(height))
}

async function pollNearDeposits(treasury: string) {
  const token = loadEnv().tokenAccount.trim()
  const cursorKey = `${activeChainKey()}:near_deposit_height`
  const cursorRow = getDb().query("SELECT value FROM meta WHERE key = ?").get(cursorKey) as { value: string } | null
  const latest = await nearBlock()
  if (!cursorRow) {
    getDb().query("INSERT INTO meta (key, value) VALUES (?, ?)").run(cursorKey, String(latest.header.height))
    return
  }
  const cursor = Number(cursorRow.value)
  if (!Number.isSafeInteger(cursor)) throw new Error("NEAR deposit cursor is invalid")
  const end = Math.min(latest.header.height, cursor + 32)
  for (let height = cursor + 1; height <= end; height += 1) {
    let block: NearBlock
    try {
      block = await nearBlock(height)
    } catch (error) {
      const resume = nearHistoryMissing(error) ? prunedDepositResume(cursor, latest.header.height) : null
      if (resume === null) throw error
      console.error(`near deposits skipped ${height}..${resume}, pruned`)
      saveDepositCursor(cursorKey, resume)
      return
    }
    const timestamp = BigInt(block.header.timestamp_nanosec ?? "0")
    for (const header of block.chunks) {
      if (header.gas_used === "0") continue
      const chunk = (await rpc("chunk", { chunk_id: header.chunk_hash })) as {
        transactions?: { hash: string; signer_id: string; receiver_id: string; actions?: { FunctionCall?: { method_name?: string } }[] }[]
      }
      for (const transaction of chunk.transactions ?? []) {
        if (transaction.receiver_id !== token) continue
        if (!transaction.actions?.some((action) => action.FunctionCall?.method_name === "ft_transfer")) continue
        const payload = await rpc("EXPERIMENTAL_tx_status", {
          tx_hash: transaction.hash,
          sender_account_id: transaction.signer_id,
          wait_until: "NONE",
        })
        for (const row of parseNearDeposits(payload, treasury, token, timestamp)) {
          if (applyNearDeposit(row)) console.log(`deposit ${row.from} ${row.amountMicros} ${row.txHash}`)
        }
      }
    }
    saveDepositCursor(cursorKey, height)
  }
}

async function resumeNearWithdrawals() {
  const rows = getDb()
    .query("SELECT id, raw_tx FROM withdrawals WHERE chain_key = ? AND status = 'pending' ORDER BY created_at ASC")
    .all(activeChainKey()) as { id: string; raw_tx: string | null }[]
  for (const row of rows) {
    if (!row.raw_tx) continue
    const raw = row.raw_tx
    try {
      await enqueueBroadcast(() => broadcastRaw(raw))
      getDb()
        .query("UPDATE withdrawals SET status = 'sent' WHERE chain_key = ? AND id = ? AND status = 'pending'")
        .run(activeChainKey(), row.id)
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ""
      if (message.includes("failure") || message.includes("revert") || message.includes("not enough")) refundWithdraw(row.id)
      else console.error(error)
    }
  }
}

export function startNearCustody(treasury: string) {
  const chainKey = activeChainKey()
  console.log(`near rpc ${nearRpcEndpoints().map((endpoint) => endpoint.url).join(" ")}`)
  const runtime = globalThis as unknown as { quickMarketNearCustody?: ReturnType<typeof setInterval> }
  if (runtime.quickMarketNearCustody) clearInterval(runtime.quickMarketNearCustody)
  const tick = () => {
    withChain(chainKey, () => {
      if (polling) return
      polling = true
      Promise.all([
        pollNearDeposits(treasury).catch((error) => console.error(error)),
        resumeNearWithdrawals().catch((error) => console.error(error)),
      ]).finally(() => {
        polling = false
      })
    })
  }
  tick()
  runtime.quickMarketNearCustody = setInterval(tick, 8_000)
}
