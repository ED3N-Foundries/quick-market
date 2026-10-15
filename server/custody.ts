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
import { chainFromEnv, type ChainConfig } from "../shared/chain"
import { usdcAbi } from "../shared/usdc"
import { getDb } from "./db"
import { normalizeAddress } from "./money"
import { credit, withdraw, youFor, type You } from "./rounds"

const CONFIRMATIONS = 3n
const LOG_RANGE = 199n
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
  const raw = process.env.TREASURY_PRIVATE_KEY?.trim() ?? ""
  if (!raw) throw new Error("TREASURY_PRIVATE_KEY is required")
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("TREASURY_PRIVATE_KEY must be a 32-byte hex string")
  return privateKeyToAccount(hex as Hex)
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
  const config = chainFromEnv(process.env.CHAIN)
  const account = treasuryAccount()
  const transport = http(process.env.RPC_URL || config.rpc)
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

function clients() {
  const chain = chainFromEnv(process.env.CHAIN)
  const account = treasuryAccount()
  const transport = http(process.env.RPC_URL || chain.rpc)
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
  if (!treasury || !from || !to || to !== treasury) return false
  if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0) return false
  const now = input.now ?? Date.now()
  const txHash = input.txHash.toLowerCase()
  const run = getDb().transaction(() => {
    const inserted = getDb()
      .query(
        `INSERT INTO deposits (tx_hash, log_index, address, amount_micros, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(txHash, input.logIndex, from, input.amountMicros, now)
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
    return { ok: false, error: treasuryFaultMessage(error, chainFromEnv(process.env.CHAIN).name) }
  }

  const id = crypto.randomUUID()
  try {
    const tx = getDb().transaction(() => {
      const held = withdraw(address, amountMicros)
      if (!held.ok) throw new Error(held.error)
      getDb()
        .query(
          `INSERT INTO withdrawals (id, address, amount_micros, tx_hash, raw_tx, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(id, address, amountMicros, hash, raw, Date.now())
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
    .query("SELECT id FROM withdrawals WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as { id: string }[]
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
    getDb().query("UPDATE withdrawals SET status = 'sent' WHERE id = ? AND status = 'pending'").run(id)
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
    getDb().query("UPDATE withdrawals SET status = 'refunded' WHERE id = ? AND status = 'pending'").run(row.id)
  })
  tx()
}

function withdrawRow(id: string): WithdrawRow | null {
  return (getDb().query("SELECT * FROM withdrawals WHERE id = ?").get(id) as WithdrawRow | null) ?? null
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

function readCursor(): bigint | null {
  const row = getDb().query("SELECT value FROM meta WHERE key = 'deposit_block'").get() as { value: string } | null
  if (!row) return null
  return BigInt(row.value)
}

function writeCursor(block: bigint) {
  getDb()
    .query(
      `INSERT INTO meta (key, value) VALUES ('deposit_block', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(block.toString())
}
