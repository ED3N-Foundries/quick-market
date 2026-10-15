import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, createWalletClient, http, type Address } from "viem"
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import { base, baseSepolia } from "viem/chains"
import { chainFromEnv, type ChainConfig } from "../shared/chain"
import { loginMessage } from "../shared/login"
import { usdcAbi } from "../shared/usdc"

const KEYS_PATH = join(process.cwd(), "agent", "keys.json")
const GAS_FLOOR = 50_000_000_000_000n
const ONE_USDC = 1_000_000n
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
  const tokens = new Map<string, string>()
  const betOn = new Map<string, number>()
  const faucetAt = new Map<string, number>()
  const lastError = new Map<string, string>()

  async function step(index: number, account: PrivateKeyAccount) {
    const eth = await publicClient.getBalance({ address: account.address })
    const usdc = await publicClient.readContract({
      address: chain.usdc,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [account.address],
    })
    const need = needsFaucet(chain.faucet, eth, usdc)
    const waited = Date.now() - (faucetAt.get(account.address) ?? 0)
    if ((need.eth || need.usdc) && waited > FAUCET_WAIT_MS) {
      faucetAt.set(account.address, Date.now())
      if (need.eth) await claim(account.address, "eth")
      if (need.usdc) await claim(account.address, "usdc")
    }

    const token = await session(account)
    const state = await getState(token)
    if (state.config.chainId !== chain.id) {
      throw new Error(`Server chain ${state.config.chainId} does not match ${chain.key}`)
    }
    const held = await publicClient.readContract({
      address: chain.usdc,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [account.address],
    })
    if (held >= ONE_USDC) await sweep(account, state.config.treasury, held)

    const roundId = state.board.join?.id
    const spendable = state.you?.balanceMicros ?? 0
    if (roundId === undefined || spendable < ONE_USDC || betOn.get(account.address) === roundId) return
    const response = await fetch(`${api}/api/bets`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ side: sideFor(index, roundId, account.address), stake: "1" }),
    })
    if (response.status === 401) {
      tokens.delete(account.address)
      return
    }
    const body = (await response.json()) as { error?: string }
    if (!response.ok) {
      if (body.error !== lastError.get(account.address)) {
        lastError.set(account.address, body.error ?? "Bet failed")
        console.error(account.address, body.error ?? "Bet failed")
      }
      if (body.error === "You are already on the other side") betOn.set(account.address, roundId)
      return
    }
    betOn.set(account.address, roundId)
    lastError.delete(account.address)
  }

  async function claim(address: Address, token: "eth" | "usdc") {
    if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
      console.error("CDP_API_KEY_ID and CDP_API_KEY_SECRET are required for the faucet")
      return
    }
    const { CdpClient } = await import("@coinbase/cdp-sdk")
    const cdp = new CdpClient()
    const result = await cdp.evm.requestFaucet({ address, network: "base-sepolia", token })
    await publicClient.waitForTransactionReceipt({ hash: result.transactionHash })
    console.log(`${address} faucet ${token} ${result.transactionHash}`)
  }

  async function sweep(account: PrivateKeyAccount, treasury: Address, amount: bigint) {
    const wallet = createWalletClient({ account, chain: viemChain(chain), transport })
    const hash = await wallet.writeContract({
      address: chain.usdc,
      abi: usdcAbi,
      functionName: "transfer",
      args: [treasury, amount],
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`${account.address} deposited ${hash}`)
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
    if (!response.ok || !body.token) throw new Error(body.error ?? "Sign-in failed")
    tokens.set(account.address, body.token)
    return body.token
  }

  async function getState(token: string): Promise<State> {
    const response = await fetch(`${api}/api/state`, { headers: { authorization: `Bearer ${token}` } })
    if (response.status === 401) throw new Error("Sign in again")
    if (!response.ok) throw new Error("State failed")
    return (await response.json()) as State
  }

  for (;;) {
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index]!
      try {
        await step(index, account)
      } catch (error) {
        console.error(account.address, error instanceof Error ? error.message : error)
      }
    }
    await Bun.sleep(1_000)
  }
}

if (import.meta.main) await main()
