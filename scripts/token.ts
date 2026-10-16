import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem"
import { baseSepolia } from "viem/chains"
import { getDb } from "../server/db"
import { cutoverAmount } from "../server/grant"
import { mintToTreasury, treasuryAccount } from "../server/custody"

const ENV_PATH = join(process.cwd(), ".env")
const EXAMPLE_PATH = join(process.cwd(), ".env.example")

async function main() {
  if (process.env.CHAIN === "base") {
    console.error("CHAIN=base uses Circle USDC. Refusing to deploy quick-market USDC.")
    process.exit(1)
  }

  let account: ReturnType<typeof treasuryAccount>
  try {
    account = treasuryAccount()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }

  const transport = http(process.env.RPC_URL || "https://sepolia.base.org")
  const publicClient = createPublicClient({ chain: baseSepolia, transport })
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport })
  const existing = process.env.USDC_ADDRESS?.trim() ?? ""
  let token: Address
  if (existing) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(existing)) throw new Error("USDC_ADDRESS must be a 20-byte hex address")
    token = existing as Address
    console.log(`USDC_ADDRESS is already ${token}. Not deploying.`)
  } else {
    const artifact = JSON.parse(readFileSync(join(process.cwd(), "contracts/QuickMarketUSDC.json"), "utf8")) as {
      abi: Abi
      bytecode: Hex
    }
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      chain: baseSepolia,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deploy failed")
    token = receipt.contractAddress
    process.env.USDC_ADDRESS = token
    writeAddress(token)
    console.log(`quick-market USDC ${token}`)
  }
  await backLedger(token)
}

async function backLedger(token: Address) {
  process.env.USDC_ADDRESS = token
  const row = getDb().query("SELECT value FROM meta WHERE key = 'qm_usdc_v1'").get() as { value: string } | null
  const sumRow = getDb().query("SELECT COALESCE(SUM(balance_micros), 0) AS total FROM users").get() as {
    total: number | bigint | null
  }
  const total = sumRow.total === null ? 0 : typeof sumRow.total === "bigint" ? Number(sumRow.total) : sumRow.total
  const amount = cutoverAmount(row?.value ?? null, total)
  if (amount === null) {
    console.log("quick-market USDC cutover already recorded")
    return
  }
  if (amount > 0) await mintToTreasury(amount)
  getDb().query("INSERT INTO meta (key, value) VALUES ('qm_usdc_v1', ?)").run(String(amount))
  console.log(`backed ${amount} micros of existing balances with quick-market USDC`)
}

function writeAddress(address: string) {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : readFileSync(EXAMPLE_PATH, "utf8")
  const line = `USDC_ADDRESS=${address}`
  const next = /^USDC_ADDRESS=.*$/m.test(text)
    ? text.replace(/^USDC_ADDRESS=.*$/m, line)
    : `${text.replace(/\n?$/, "\n")}${line}\n`
  writeFileSync(ENV_PATH, next, { mode: 0o600 })
  chmodSync(ENV_PATH, 0o600)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
