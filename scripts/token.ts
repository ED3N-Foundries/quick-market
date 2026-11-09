import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem"
import { baseSepolia } from "viem/chains"
import { formatYocto } from "../shared/near"
import { accountFromSecret, generateNearSecret } from "../shared/nearKey"
import { loadMarket, marketPreferences } from "../shared/market"
import { mintToTreasury, treasuryAccount } from "../server/custody"
import { getDb } from "../server/db"
import { loadEnv } from "../server/env"
import { sendNearActions } from "../server/near"
import { encodeDeploy, encodeFunctionCall, encodeTransfer, jsonArgs } from "../server/nearTx"
import { cutoverAmount } from "../server/grant"

const ENV_PATH = join(process.cwd(), ".env")
const EXAMPLE_PATH = join(process.cwd(), ".env.example")

async function main() {
  try {
    loadMarket()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
  if (marketPreferences.chain === "near-testnet") {
    await deployNear()
    return
  }
  if (marketPreferences.chain === "base") {
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

  const env = loadEnv()
  const transport = http(env.rpcUrl || "https://sepolia.base.org")
  const publicClient = createPublicClient({ chain: baseSepolia, transport })
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport })
  const existing = env.usdcAddress
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

async function deployNear() {
  const env = loadEnv()
  const existing = env.tokenAccount.trim()
  if (existing) {
    console.log(`TOKEN_ACCOUNT is already ${existing}. Not deploying.`)
    return
  }
  const wasmPath = join(process.cwd(), "contracts/near/res/quick_market.wasm")
  if (!existsSync(wasmPath)) {
    console.error("Build the NEAR contract first:")
    console.error("  rustup target add wasm32-unknown-unknown")
    console.error("  cargo build --manifest-path contracts/near/Cargo.toml --target wasm32-unknown-unknown --release")
    console.error("  mkdir -p contracts/near/res && cp target/wasm32-unknown-unknown/release/quick_market.wasm contracts/near/res/quick_market.wasm")
    process.exit(1)
  }
  const treasuryKey = env.treasuryPrivateKey
  const treasury = await accountFromSecret(treasuryKey)
  if (!treasury) {
    console.error("TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
    process.exit(1)
  }
  const contract = await generateNearSecret()
  const code = new Uint8Array(readFileSync(wasmPath))
  const stake = BigInt(code.length) * 10_000_000_000_000_000_000n + 200_000_000_000_000_000_000_000n
  console.log(`contract account ${contract.account}`)
  console.log(`funding ${formatYocto(stake)} NEAR for code storage`)
  await sendNearActions({
    signerId: treasury,
    secretKey: treasuryKey,
    receiverId: contract.account,
    actions: [encodeTransfer(stake)],
  })
  await sendNearActions({
    signerId: contract.account,
    secretKey: contract.secretKey,
    receiverId: contract.account,
    actions: [
      encodeDeploy(code),
      encodeFunctionCall("new", jsonArgs({ minter: treasury }), 80_000_000_000_000n, 0n),
    ],
  })
  writeEnvLine("TOKEN_ACCOUNT", contract.account)
  writeEnvLine("TOKEN_PRIVATE_KEY", contract.secretKey)
  console.log(`TOKEN_ACCOUNT ${contract.account}`)
}

function writeEnvLine(name: string, value: string) {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : readFileSync(EXAMPLE_PATH, "utf8")
  const line = `${name}=${value}`
  const pattern = new RegExp(`^${name}=.*$`, "m")
  const next = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, "\n")}${line}\n`
  writeFileSync(ENV_PATH, next, { mode: 0o600 })
  chmodSync(ENV_PATH, 0o600)
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
