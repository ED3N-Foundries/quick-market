import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbiItem,
  type Address,
  type Hash,
  type Hex,
} from "viem"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import { base, baseSepolia } from "viem/chains"
import type { ChainConfig } from "../shared/chain"
import { mintReceiptWait } from "../shared/mint"
import { mintAbi, usdcAbi } from "../shared/usdc"
import { activeChainKey } from "./activeChain"
import { getDb } from "./db"
import { configuredChain, loadEnv } from "./env"
import { normalizeAddress } from "./money"
import { credit, withdraw, youFor, type You } from "./rounds"

const CONFIRMATIONS = 3n
const LOG_RANGE = 199n
const ZERO = "0x0000000000000000000000000000000000000000"
export const DEAD = "0x000000000000000000000000000000000000dEaD" as Address
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")

type WithdrawRow = {
  id: string
  address: string
  amount_micros: number
  tx_hash: string | null
  raw_tx: string | null
  status: string
}

let queue: Promise<void> = Promise.resolve()

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function treasuryAccount(): PrivateKeyAccount {
  const raw = loadEnv().treasuryPrivateKey
  if (!raw) throw new Error("TREASURY_PRIVATE_KEY is required")
  return privateKeyToAccount(raw as Hex)
}

export function treasuryAddress(): Address {
  return treasuryAccount().address
}

class TreasuryShort extends Error {}

export function treasuryFaultMessage(error: unknown, chainName: string): string {
  if (error instanceof TreasuryShort) return error.message
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  if (
    message.includes("insufficient funds") ||
    message.includes("insufficient balance for transfer") ||
    message.includes("gas required exceeds")
  ) {
    return `Treasury needs ${chainName} ETH for gas.`
  }
  return "Treasury could not prepare the withdraw"
}

async function signedTransfer(to: Address, amount: bigint): Promise<Hex> {
  const config = configuredChain()
  const account = treasuryAccount()
  const transport = http(loadEnv().rpcUrl || config.rpc)
  const data = encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [to, amount] })
  const chain = config.id === base.id ? base : baseSepolia
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })
  const balance = await publicClient.readContract({
    address: config.usdc,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [account.address],
  })
  if (balance < amount) throw new TreasuryShort("Treasury is short. Try again shortly.")
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" })
  const prepared = await walletClient.prepareTransactionRequest({
    account,
    chain,
    to: config.usdc,
    data,
    nonce,
  })
  return account.signTransaction(prepared as Parameters<PrivateKeyAccount["signTransaction"]>[0])
}

let pendingMintMicros = 0
let pendingMintWaiters: {
  resolve: () => void
  reject: (error: unknown) => void
  onHash?: (hash: Hash) => void
}[] = []
let mintScheduled = false

export async function mintToTreasury(amountMicros: number, onHash?: (hash: Hash) => void): Promise<void> {
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new Error("Amount is invalid")
  return new Promise<void>((resolve, reject) => {
    pendingMintMicros += amountMicros
    pendingMintWaiters.push({ resolve, reject, onHash })
    if (mintScheduled) return
    mintScheduled = true
    queueMicrotask(() => {
      mintScheduled = false
      const total = pendingMintMicros
      const waiters = pendingMintWaiters
      pendingMintMicros = 0
      pendingMintWaiters = []
      if (total <= 0 || waiters.length === 0) return
      enqueue(async () => {
        const { chain, account, publicClient, walletClient } = clients()
        const hash = await walletClient.writeContract({
          address: chain.usdc,
          abi: mintAbi,
          functionName: "mint",
          args: [account.address, BigInt(total)],
          gas: 200_000n,
        })
        for (const waiter of waiters) {
          try {
            waiter.onHash?.(hash)
          } catch (error) {
            console.error(error instanceof Error ? error.message : error)
          }
        }
        const receipt = await publicClient.waitForTransactionReceipt(mintReceiptWait(hash))
        if (receipt.status !== "success") throw new Error(`Mint failed ${hash}`)
      }).then(
        () => {
          for (const waiter of waiters) waiter.resolve()
        },
        (error) => {
          for (const waiter of waiters) waiter.reject(error)
        },
      )
    })
  })
}

function clients() {
  const chain = configuredChain()
  const account = treasuryAccount()
  const transport = http(loadEnv().rpcUrl || chain.rpc)
  const chainDef = chain.id === base.id ? base : baseSepolia
  return {
    chain,
    account,
    publicClient: createPublicClient({ chain: chainDef, transport }),
    walletClient: createWalletClient({ account, chain: chainDef, transport }),
  }
}

type ChainClient = ReturnType<typeof clients>["publicClient"]
type ChainWallet = ReturnType<typeof clients>["walletClient"]

export function applyDeposit(input: {
  treasury: string
  txHash: string
  logIndex: number
  from: string
  to: string
  amountMicros: number
  now?: number
}): boolean {
  const treasury = normalizeAddress(input.treasury)
  const from = normalizeAddress(input.from)
  const to = normalizeAddress(input.to)
  if (!treasury || !from || !to || to !== treasury || from === ZERO) return false
  if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0) return false
  const now = input.now ?? Date.now()
  const txHash = input.txHash.toLowerCase()
  const run = getDb().transaction(() => {
    const inserted = getDb()
      .query(
        `INSERT INTO deposits (chain_key, tx_hash, log_index, address, amount_micros, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(activeChainKey(), txHash, input.logIndex, from, input.amountMicros, now)
    if (inserted.changes === 0) return false
    const added = credit(from, input.amountMicros)
    if (!added.ok) throw new Error(added.error)
    return true
  })
  return run()
}

export function requestWithdraw(
  address: string,
  amountMicros: number,
): Promise<{ ok: true; you: You; txHash: string } | { ok: false; error: string; you?: You }> {
  return enqueue(() => requestWithdrawLocked(address, amountMicros))
}

async function requestWithdrawLocked(
  address: string,
  amountMicros: number,
): Promise<{ ok: true; you: You; txHash: string } | { ok: false; error: string; you?: You }> {
  const you = youFor(address)
  if (!you) return { ok: false, error: "Unknown wallet" }
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) return { ok: false, error: "Amount is invalid" }
  if (amountMicros > you.balanceMicros) return { ok: false, error: "Insufficient balance" }

  const { publicClient, walletClient } = clients()
  let raw: Hex
  let hash: Hash
  try {
    raw = await signedTransfer(address as Address, BigInt(amountMicros))
    hash = keccak256(raw)
  } catch (error) {
    if (!(error instanceof TreasuryShort)) console.error(error)
    return { ok: false, error: treasuryFaultMessage(error, configuredChain().name) }
  }

  const id = crypto.randomUUID()
  try {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Withdraw failed"
    if (message === "Insufficient balance" || message === "Unknown wallet" || message === "Amount is invalid") {
      return { ok: false, error: message }
    }
    throw error
  }

  return finishWithdraw(id, publicClient, walletClient)
}

export async function resumeWithdrawals() {
  const rows = getDb()
    .query("SELECT id FROM withdrawals WHERE chain_key = ? AND status = 'pending' ORDER BY created_at ASC")
    .all(activeChainKey()) as { id: string }[]
  for (const row of rows) {
    await enqueue(async () => {
      const { publicClient, walletClient } = clients()
      await finishWithdraw(row.id, publicClient, walletClient)
    })
  }
}

async function finishWithdraw(
  id: string,
  publicClient: ChainClient,
  walletClient: ChainWallet,
): Promise<{ ok: true; you: You; txHash: string } | { ok: false; error: string; you?: You }> {
  const row = withdrawRow(id)
  if (!row) return { ok: false, error: "Withdraw failed" }
  const you = () => youFor(row.address) ?? undefined
  if (row.status === "sent" && row.tx_hash) return { ok: true, you: you()!, txHash: row.tx_hash }
  if (row.status !== "pending" || !row.raw_tx || !row.tx_hash) return { ok: false, error: "Withdraw failed", you: you() }
  const hash = row.tx_hash as Hash
  try {
    await broadcast(publicClient, walletClient, row.raw_tx as Hex, hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 })
    if (receipt.status === "reverted") {
      refundRow(row)
      return { ok: false, error: "Withdraw reverted", you: youFor(row.address) ?? undefined }
    }
    getDb()
      .query("UPDATE withdrawals SET status = 'sent' WHERE chain_key = ? AND id = ? AND status = 'pending'")
      .run(activeChainKey(), id)
    return { ok: true, you: you()!, txHash: hash }
  } catch (error) {
    console.error(error)
    return { ok: false, error: "Withdraw is pending", you: you() }
  }
}

async function broadcast(publicClient: ChainClient, walletClient: ChainWallet, raw: Hex, hash: Hash) {
  const existing = await publicClient.getTransactionReceipt({ hash }).catch(() => null)
  if (existing) return
  try {
    await walletClient.sendRawTransaction({ serializedTransaction: raw })
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ""
    if (message.includes("already known") || message.includes("nonce too low") || message.includes("already imported")) return
    throw error
  }
}

function refundRow(row: WithdrawRow) {
  const tx = getDb().transaction(() => {
    const current = withdrawRow(row.id)
    if (!current || current.status !== "pending") return
    const added = credit(row.address, row.amount_micros)
    if (!added.ok) throw new Error(added.error)
    getDb()
      .query("UPDATE withdrawals SET status = 'refunded' WHERE chain_key = ? AND id = ? AND status = 'pending'")
      .run(activeChainKey(), row.id)
  })
  tx()
}

function withdrawRow(id: string): WithdrawRow | null {
  return (getDb().query("SELECT * FROM withdrawals WHERE chain_key = ? AND id = ?").get(activeChainKey(), id) as WithdrawRow | null) ?? null
}

type BurnRow = {
  id: string
  address: string
  amount_micros: number
  tx_hash: string | null
  raw_tx: string | null
  status: string
}

export function holdBurn(address: string, amountMicros: number): { ok: true; id: string } | { ok: false; error: string } {
  const who = normalizeAddress(address)
  if (!who) return { ok: false, error: "Address is invalid" }
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) return { ok: false, error: "Amount is invalid" }
  const id = crypto.randomUUID()
  try {
    const tx = getDb().transaction(() => {
      const row = getDb().query("SELECT balance_micros, is_bot FROM users WHERE chain_key = ? AND address = ?").get(activeChainKey(), who) as
        | { balance_micros: number; is_bot: number }
        | null
      if (!row || row.is_bot !== 1) throw new Error("Not a bot")
      if (amountMicros > row.balance_micros) throw new Error("Insufficient balance")
      getDb()
        .query("UPDATE users SET balance_micros = balance_micros - ? WHERE chain_key = ? AND address = ?")
        .run(amountMicros, activeChainKey(), who)
      getDb()
        .query(
          `INSERT INTO burns (chain_key, id, address, amount_micros, tx_hash, raw_tx, status, created_at)
           VALUES (?, ?, ?, ?, NULL, NULL, 'pending', ?)`,
        )
        .run(activeChainKey(), id, who, amountMicros, Date.now())
    })
    tx()
  } catch (error) {
    const message = error instanceof Error ? error.message : "Burn failed"
    if (message === "Not a bot" || message === "Insufficient balance") return { ok: false, error: message }
    throw error
  }
  return { ok: true, id }
}

export function refundBurn(id: string) {
  const tx = getDb().transaction(() => {
    const row = burnRow(id)
    if (!row || row.status !== "pending") return
    const added = credit(row.address, row.amount_micros)
    if (!added.ok) throw new Error(added.error)
    getDb()
      .query("UPDATE burns SET status = 'refunded' WHERE chain_key = ? AND id = ? AND status = 'pending'")
      .run(activeChainKey(), id)
  })
  tx()
}

export function markBurned(id: string, txHash: string) {
  getDb()
    .query("UPDATE burns SET status = 'burned', tx_hash = ? WHERE chain_key = ? AND id = ? AND status = 'pending'")
    .run(txHash, activeChainKey(), id)
}

function burnRow(id: string): BurnRow | null {
  return (getDb().query("SELECT * FROM burns WHERE chain_key = ? AND id = ?").get(activeChainKey(), id) as BurnRow | null) ?? null
}

export async function submitBurn(id: string): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  const row = burnRow(id)
  if (!row || row.status !== "pending") return { ok: false, error: "Burn is not pending" }
  if (!row.raw_tx || !row.tx_hash) {
    try {
      const raw = await signedTransfer(DEAD, BigInt(row.amount_micros))
      const hash = keccak256(raw)
      getDb()
        .query("UPDATE burns SET raw_tx = ?, tx_hash = ? WHERE chain_key = ? AND id = ? AND status = 'pending'")
        .run(raw, hash, activeChainKey(), id)
    } catch (error) {
      if (!(error instanceof TreasuryShort)) console.error(error)
      refundBurn(id)
      return { ok: false, error: treasuryFaultMessage(error, configuredChain().name) }
    }
  }
  return finishBurn(id)
}

export function requestBurn(
  address: string,
  amountMicros: number,
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  return enqueue(async () => {
    const held = holdBurn(address, amountMicros)
    if (!held.ok) return held
    return submitBurn(held.id)
  })
}

export async function resumeBurns() {
  const rows = getDb()
    .query("SELECT id, raw_tx, created_at FROM burns WHERE chain_key = ? AND status = 'pending' ORDER BY created_at ASC")
    .all(activeChainKey()) as { id: string; raw_tx: string | null; created_at: number }[]
  for (const row of rows) {
    if (!row.raw_tx) {
      if (Date.now() - row.created_at > 120_000) refundBurn(row.id)
      continue
    }
    await enqueue(() => finishBurn(row.id))
  }
}

async function finishBurn(id: string): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  const row = burnRow(id)
  if (!row) return { ok: false, error: "Burn failed" }
  if (row.status === "burned" && row.tx_hash) return { ok: true, txHash: row.tx_hash }
  if (row.status !== "pending" || !row.raw_tx || !row.tx_hash) return { ok: false, error: "Burn failed" }
  const { publicClient, walletClient } = clients()
  const hash = row.tx_hash as Hash
  try {
    await broadcast(publicClient, walletClient, row.raw_tx as Hex, hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 })
    if (receipt.status === "reverted") {
      refundBurn(id)
      return { ok: false, error: "Burn reverted" }
    }
    markBurned(id, hash)
    return { ok: true, txHash: hash }
  } catch (error) {
    console.error(error)
    return { ok: false, error: "Burn is pending" }
  }
}

let polling = false

export function startCustody() {
  const runtime = globalThis as unknown as { quickMarketCustody?: ReturnType<typeof setInterval> }
  if (runtime.quickMarketCustody) clearInterval(runtime.quickMarketCustody)
  const tick = () => {
    if (polling) return
    polling = true
    const { chain, account, publicClient } = clients()
    Promise.all([
      pollDeposits(publicClient, chain, account.address).catch((error) => console.error(error)),
      resumeWithdrawals().catch((error) => console.error(error)),
      resumeBurns().catch((error) => console.error(error)),
    ]).finally(() => {
      polling = false
    })
  }
  tick()
  runtime.quickMarketCustody = setInterval(tick, 2_000)
}

export async function pollDeposits(
  publicClient: Pick<ChainClient, "getBlockNumber" | "getLogs">,
  chain: Pick<ChainConfig, "usdc">,
  treasury: Address,
) {
  const head = await publicClient.getBlockNumber()
  const safe = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n
  const cursor = readCursor()
  if (cursor === null) {
    writeCursor(safe)
    return
  }
  if (safe <= cursor) return
  let from = cursor + 1n
  while (from <= safe) {
    const to = from + LOG_RANGE < safe ? from + LOG_RANGE : safe
    const logs = await publicClient.getLogs({
      address: chain.usdc,
      event: transferEvent,
      args: { to: treasury },
      fromBlock: from,
      toBlock: to,
    })
    for (const log of logs) {
      const value = log.args.value
      const sender = log.args.from
      if (value === undefined || !sender || log.logIndex == null || !log.transactionHash) continue
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        console.error("deposit exceeds the ledger", log.transactionHash)
        continue
      }
      const credited = applyDeposit({
        treasury,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        from: sender,
        to: treasury,
        amountMicros: Number(value),
      })
      if (credited) console.log(`deposit ${sender.toLowerCase()} ${Number(value)} ${log.transactionHash}`)
    }
    writeCursor(to)
    from = to + 1n
  }
}

function cursorKey(): string {
  return `${activeChainKey()}:deposit_block`
}

function readCursor(): bigint | null {
  const row = getDb().query("SELECT value FROM meta WHERE key = ?").get(cursorKey()) as { value: string } | null
  if (!row) return null
  return BigInt(row.value)
}

function writeCursor(block: bigint) {
  getDb()
    .query(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(cursorKey(), block.toString())
}
