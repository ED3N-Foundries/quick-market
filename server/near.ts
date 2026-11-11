import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import bs58 from "bs58"
import { activeChainKey, withChain } from "./activeChain"
import { loadEnv, nearTreasurySecret, rpcFor } from "./env"
import { getDb } from "./db"
import { normalizeAccount } from "./money"
import { credit, withdraw, youFor, type You } from "./rounds"
import {
  describeTreasury,
  isImplicitAccount,
  isNearAccountId,
  ledgerChainConflict,
  ledgerChainMessage,
  planSeed,
  type AgentHolding,
  type Holding,
  type TreasuryReport,
} from "../shared/near"
import { accountFromSecret, parseNearPublicKey, publicKeyBytes } from "../shared/nearKey"
import { encodeFunctionCall, encodeTransfer, jsonArgs, signTransaction } from "./nearTx"

/** A missing key or invalid NEAR token stops the process before it listens. */
export class NearConfigError extends Error {}

const GAS = 30_000_000_000_000n
const ONE_YOCTO = 1n
const KEYS_PATH = join(process.cwd(), "agent", "keys.near.json")

export type ParsedDeposit = {
  txHash: string
  logIndex: number
  from: string
  amountMicros: number
  timestamp: bigint
}

let latest: TreasuryReport | null = null
let queue: Promise<void> = Promise.resolve()
let polling = false

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function currentTreasuryReport(): TreasuryReport | null {
  return latest
}

export function nearRpcUrl(): string {
  return rpcFor("near-testnet")
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

function rpcErrorText(error: { message?: string; data?: unknown }): string {
  if (typeof error.data === "string" && error.data) return error.data
  if (error.data !== undefined && error.data !== null) {
    const encoded = JSON.stringify(error.data)
    if (encoded && encoded !== "{}" && encoded !== "null") return encoded
  }
  return error.message || "NEAR RPC failed"
}

/** Public testnet endpoint. NEAR documents it as severely rate limited. */
export const NEAR_PUBLIC_RPC = "https://rpc.testnet.near.org"
/** Documented public alternative when the NEAR endpoint answers 429. */
export const NEAR_FALLBACK_RPC = "https://test.rpc.fastnear.com"
const PRIMARY_QUIET_MS = 60_000

let primaryQuietUntil = 0

export function nearRpcBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ""
  return message === "Server error" || message.startsWith("NEAR RPC returned")
}

/** Skip a cooling public endpoint and use the documented fallback. A custom RPC stays put. */
export function nearRpcUrlFor(primary: string, now: number, quietUntil: number): string {
  if (primary === NEAR_PUBLIC_RPC && now < quietUntil) return NEAR_FALLBACK_RPC
  return primary
}

async function rpcOnce(url: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "quick-market", method, params }),
  })
  if (!response.ok) throw new Error(`NEAR RPC returned ${response.status}`)
  const body = (await response.json()) as { result?: unknown; error?: { message?: string; data?: unknown } }
  if (body.error) throw new Error(rpcErrorText(body.error))
  return body.result
}

async function rpc(method: string, params: unknown): Promise<unknown> {
  let last = "NEAR RPC failed"
  const attempts = method === "send_tx" ? 1 : 4
  for (let attempt = 0; attempt < attempts; attempt++) {
    const primary = nearRpcUrl()
    const url = nearRpcUrlFor(primary, Date.now(), primaryQuietUntil)
    try {
      return await rpcOnce(url, method, params)
    } catch (error) {
      last = error instanceof Error ? error.message : "NEAR RPC failed"
      if (nearRpcBusy(new Error(last)) && url === NEAR_PUBLIC_RPC) {
        primaryQuietUntil = Date.now() + PRIMARY_QUIET_MS
        try {
          return await rpcOnce(NEAR_FALLBACK_RPC, method, params)
        } catch (fallbackError) {
          last = fallbackError instanceof Error ? fallbackError.message : last
        }
      }
      if (!nearRpcBusy(new Error(last)) || attempt + 1 === attempts) break
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
    }
  }
  throw new Error(last)
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

async function nextNonce(account: string, secretKey: string): Promise<{ nonce: bigint; blockHash: Uint8Array; publicKey: Uint8Array }> {
  const publicKey = await publicKeyBytes(secretKey)
  if (!publicKey) throw new Error("TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
  const result = (await rpc("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: account,
    public_key: `ed25519:${bs58.encode(publicKey)}`,
  })) as { nonce?: number; block_hash?: string }
  if (typeof result.block_hash !== "string") throw new Error("Treasury access key is missing")
  return { nonce: BigInt(result.nonce ?? 0) + 1n, blockHash: bs58.decode(result.block_hash), publicKey }
}

async function submit(input: {
  signerId: string
  secretKey: string
  receiverId: string
  actions: number[][]
}): Promise<string> {
  const viewed = await nextNonce(input.signerId, input.secretKey)
  const signed = await signTransaction({
    signerId: input.signerId,
    secretKey: input.secretKey,
    nonce: viewed.nonce,
    receiverId: input.receiverId,
    blockHash: viewed.blockHash,
    actions: input.actions,
  })
  const result = (await rpc("send_tx", {
    signed_tx_base64: Buffer.from(signed.signed).toString("base64"),
    wait_until: "EXECUTED",
  })) as { status?: { Failure?: unknown }; transaction?: { hash?: string } }
  if (result.status && "Failure" in result.status) throw new Error(JSON.stringify(result.status.Failure))
  return result.transaction?.hash ?? signed.hash
}

export function nearAgentAccounts(): string[] {
  if (!existsSync(KEYS_PATH)) return []
  try {
    const parsed = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as unknown
    if (!Array.isArray(parsed)) return []
    const accounts: string[] = []
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue
      const account = (row as { account?: unknown }).account
      if (typeof account === "string" && isImplicitAccount(account)) accounts.push(account)
    }
    return accounts
  } catch {
    return []
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
  for (const line of report.lines) console.error(line)
  return report
}

export async function bootNear(treasury: string): Promise<TreasuryReport> {
  const env = loadEnv()
  const token = env.tokenAccount.trim()
  assertLedgerChain("near-testnet", env.dbPath)
  const agents = nearAgentAccounts()
  try {
    assertQmMetadata(await readTokenMetadata(token))
  } catch (error) {
    if (error instanceof NearConfigError) throw error
    if (missingAccount(error)) throw new NearConfigError("TOKEN_ACCOUNT must be quick-market QM with 6 decimals.")
    return failedReport(treasury, agents, error)
  }
  try {
    const first = await collectHoldings(treasury, agents)
    const planned = planSeed({ treasury: first.treasury, ledgerMicros: ledgerSumMicros(), agents: first.agents })
    if (planned.mintMicros > 0n) {
      await enqueue(() =>
        submit({
          signerId: treasury,
          secretKey: signingKey(),
          receiverId: token,
          actions: [encodeFunctionCall("mint", jsonArgs({ account_id: treasury, amount: planned.mintMicros.toString() }), GAS, 0n)],
        }),
      )
    }
    for (const transfer of planned.transfers) {
      await enqueue(() =>
        submit({
          signerId: treasury,
          secretKey: signingKey(),
          receiverId: transfer.to,
          actions: [encodeTransfer(transfer.yocto)],
        }),
      )
    }
    const second = await collectHoldings(treasury, agents)
    return publishReport(describeTreasury({ account: treasury, treasury: second.treasury, ledgerMicros: ledgerSumMicros(), agents: second.agents }))
  } catch (error) {
    if (error instanceof NearConfigError) throw error
    return failedReport(treasury, agents, error)
  }
}

export async function sendNearActions(input: {
  signerId: string
  secretKey: string
  receiverId: string
  actions: number[][]
}): Promise<string> {
  return enqueue(() => submit(input))
}

export async function inspectNear(treasury: string): Promise<TreasuryReport> {
  const agents = nearAgentAccounts()
  try {
    const read = await collectHoldings(treasury, agents)
    const report = describeTreasury({ account: treasury, treasury: read.treasury, ledgerMicros: ledgerSumMicros(), agents: read.agents })
    latest = report
    return report
  } catch (error) {
    const report = uncheckedReport(treasury, agents, error)
    latest = report
    return report
  }
}

export function fundedAgents(report: TreasuryReport): Set<string> {
  const short = new Set(report.shortAgents.map((agent) => agent.account))
  return new Set(nearAgentAccounts().filter((account) => !short.has(account)))
}

export async function mintNearToTreasury(amountMicros: number, onHash?: (hash: string) => void): Promise<void> {
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new Error("Amount is invalid")
  const env = loadEnv()
  const treasury = await accountFromSecret(signingKey())
  if (!treasury) throw new Error("TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
  const hash = await enqueue(() =>
    submit({
      signerId: treasury,
      secretKey: signingKey(),
      receiverId: env.tokenAccount.trim(),
      actions: [encodeFunctionCall("mint", jsonArgs({ account_id: treasury, amount: String(amountMicros) }), GAS, 0n)],
    }),
  )
  onHash?.(hash)
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
  return enqueue(async () => {
    const who = normalizeAccount(address, "near-testnet")
    const you = who ? youFor(who) : null
    if (!who || !you) return { ok: false, error: "Unknown wallet" }
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) return { ok: false, error: "Amount is invalid" }
    if (amountMicros > you.balanceMicros) return { ok: false, error: "Insufficient balance" }
    const env = loadEnv()
    const treasury = await accountFromSecret(signingKey())
    if (!treasury) return { ok: false, error: "TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key" }
    let raw = ""
    let hash = ""
    try {
      const viewed = await nextNonce(treasury, signingKey())
      const signed = await signTransaction({
        signerId: treasury,
        secretKey: signingKey(),
        nonce: viewed.nonce,
        receiverId: env.tokenAccount.trim(),
        blockHash: viewed.blockHash,
        actions: [
          encodeFunctionCall(
            "ft_transfer",
            jsonArgs({ receiver_id: who, amount: String(amountMicros), memo: null }),
            GAS,
            ONE_YOCTO,
          ),
        ],
      })
      raw = Buffer.from(signed.signed).toString("base64")
      hash = signed.hash
    } catch (error) {
      return { ok: false, error: nearFaultMessage(error), you }
    }
    let id = ""
    try {
      id = debitWithdraw(who, amountMicros, raw, hash)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Withdraw failed"
      return { ok: false, error: message, you: youFor(who) ?? undefined }
    }
    try {
      await broadcastRaw(raw)
      getDb()
        .query("UPDATE withdrawals SET status = 'sent' WHERE chain_key = ? AND id = ? AND status = 'pending'")
        .run(activeChainKey(), id)
      return { ok: true, you: youFor(who)!, txHash: hash }
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ""
      if (message.includes("failure") || message.includes("revert") || message.includes("not enough")) {
        refundWithdraw(id)
        return { ok: false, error: nearFaultMessage(error), you: youFor(who) ?? undefined }
      }
      console.error(error)
      return { ok: false, error: "Withdraw is pending", you: youFor(who) ?? undefined }
    }
  })
}

export async function requestNearBurn(address: string, amountMicros: number): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  return enqueue(async () => {
    if (!isImplicitAccount(address)) return { ok: false, error: "Address is invalid" }
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) return { ok: false, error: "Amount is invalid" }
    const env = loadEnv()
    const treasury = await accountFromSecret(signingKey())
    if (!treasury) return { ok: false, error: "TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key" }
    const id = crypto.randomUUID()
    try {
      const tx = getDb().transaction(() => {
        const row = getDb()
          .query("SELECT balance_micros, is_bot FROM users WHERE chain_key = ? AND address = ?")
          .get(activeChainKey(), address) as { balance_micros: number; is_bot: number } | null
        if (!row || row.is_bot !== 1) throw new Error("Not a bot")
        if (amountMicros > row.balance_micros) throw new Error("Insufficient balance")
        getDb()
          .query("UPDATE users SET balance_micros = balance_micros - ? WHERE chain_key = ? AND address = ?")
          .run(amountMicros, activeChainKey(), address)
        getDb()
          .query(`INSERT INTO burns (chain_key, id, address, amount_micros, tx_hash, raw_tx, status, created_at) VALUES (?, ?, ?, ?, NULL, NULL, 'pending', ?)`)
          .run(activeChainKey(), id, address, amountMicros, Date.now())
      })
      tx()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Burn failed" }
    }
    try {
      const hash = await submit({
        signerId: treasury,
        secretKey: signingKey(),
        receiverId: env.tokenAccount.trim(),
        actions: [encodeFunctionCall("burn", jsonArgs({ amount: String(amountMicros) }), GAS, 0n)],
      })
      getDb()
        .query("UPDATE burns SET status = 'sent', tx_hash = ? WHERE chain_key = ? AND id = ? AND status = 'pending'")
        .run(hash, activeChainKey(), id)
      return { ok: true, txHash: hash }
    } catch (error) {
      const refund = getDb().transaction(() => {
        const row = getDb().query("SELECT status FROM burns WHERE chain_key = ? AND id = ?").get(activeChainKey(), id) as
          | { status: string }
          | null
        if (!row || row.status !== "pending") return
        credit(address, amountMicros)
        getDb()
          .query("UPDATE burns SET status = 'refunded' WHERE chain_key = ? AND id = ? AND status = 'pending'")
          .run(activeChainKey(), id)
      })
      refund()
      return { ok: false, error: nearFaultMessage(error) }
    }
  })
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
    const block = await nearBlock(height)
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
          wait_until: "EXECUTED",
        })
        for (const row of parseNearDeposits(payload, treasury, token, timestamp)) {
          if (applyNearDeposit(row)) console.log(`deposit ${row.from} ${row.amountMicros} ${row.txHash}`)
        }
      }
    }
    getDb()
      .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(cursorKey, String(height))
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
      await enqueue(() => broadcastRaw(raw))
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
