import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem"
import { baseSepolia } from "viem/chains"
import { formatYocto } from "../shared/near"
import { accountFromSecret, generateNearSecret } from "../shared/nearKey"
import { loadMarket, marketPreferences } from "../shared/market"
import { mintToTreasury, treasuryAccount } from "../server/custody"
import { getDb } from "../server/db"
import { loadEnv, nearTreasurySecret } from "../server/env"
import { nearRpcUrl, readNearBalance, readTokenMetadata, sendNearActions } from "../server/near"
import { encodeDeploy, encodeFunctionCall, encodeTransfer, jsonArgs } from "../server/nearTx"
import { cutoverAmount } from "../server/grant"

const EXAMPLE_PATH = join(process.cwd(), ".env.example")

function envPath(): string {
  const override = process.env.QUICK_MARKET_ENV_FILE?.trim()
  return override || join(process.cwd(), ".env")
}

/** Writes the NEAR token lines and leaves TREASURY_PRIVATE_KEY alone. */
export function planTokenLines(text: string, account: string, secret: string): string {
  return writeNamedLine(writeNamedLine(text, "TOKEN_ACCOUNT", account), "TOKEN_PRIVATE_KEY", secret)
}

function writeNamedLine(text: string, name: string, value: string): string {
  const line = `${name}=${value}`
  const pattern = new RegExp(`^${name}=.*$`, "m")
  if (pattern.test(text)) return text.replace(pattern, line)
  return `${text.replace(/\n?$/, "\n")}${line}\n`
}

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
  const chain = marketPreferences.chain
  const metaKey = `${chain}:qm_usdc_v1`
  const row = getDb().query("SELECT value FROM meta WHERE key = ?").get(metaKey) as { value: string } | null
  const sumRow = getDb().query("SELECT COALESCE(SUM(balance_micros), 0) AS total FROM users WHERE chain_key = ?").get(chain) as {
    total: number | bigint | null
  }
  const total = sumRow.total === null ? 0 : typeof sumRow.total === "bigint" ? Number(sumRow.total) : sumRow.total
  const amount = cutoverAmount(row?.value ?? null, total)
  if (amount === null) {
    console.log("quick-market USDC cutover already recorded")
    return
  }
  if (amount > 0) await mintToTreasury(amount)
  getDb().query("INSERT INTO meta (key, value) VALUES (?, ?)").run(metaKey, String(amount))
  console.log(`backed ${amount} micros of existing balances with quick-market USDC`)
}

function rememberToken(account: string, secret: string) {
  const current = existsSync(envPath()) ? readFileSync(envPath(), "utf8") : readFileSync(EXAMPLE_PATH, "utf8")
  writeFileSync(envPath(), planTokenLines(current, account, secret), { mode: 0o600 })
  chmodSync(envPath(), 0o600)
  process.env.TOKEN_ACCOUNT = account
  process.env.TOKEN_PRIVATE_KEY = secret
}

async function metadataReady(account: string): Promise<boolean> {
  try {
    const meta = await readTokenMetadata(account)
    return meta.symbol === "QM" && meta.decimals === 6
  } catch {
    return false
  }
}

async function waitForBalance(account: string, need: bigint) {
  let last = "balance not visible yet"
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const balance = await readNearBalance(account)
      if (balance.exists && balance.yocto >= need) return
      last = balance.exists ? `yocto ${balance.yocto}` : "account is not final yet"
    } catch (error) {
      last = error instanceof Error ? error.message : "balance check failed"
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error(`${account} did not reach ${need} yoctoNEAR (${last})`)
}

async function deployNear() {
  const env = loadEnv()
  const wasmPath = join(process.cwd(), "contracts/near/res/quick_market.wasm")
  if (!existsSync(wasmPath)) {
    console.error("Build the NEAR contract first:")
    console.error("  rustup target add wasm32-unknown-unknown")
    console.error("  cargo +1.86.0 build --manifest-path contracts/near/Cargo.toml --target wasm32-unknown-unknown --release")
    console.error("  mkdir -p contracts/near/res && cp contracts/near/target/wasm32-unknown-unknown/release/quick_market.wasm contracts/near/res/quick_market.wasm")
    process.exit(1)
  }
  const treasuryKey = nearTreasurySecret(env)
  const treasury = await accountFromSecret(treasuryKey)
  if (!treasury) {
    console.error("NEAR_TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
    process.exit(1)
  }
  let account = env.tokenAccount.trim()
  let secret = (process.env.TOKEN_PRIVATE_KEY ?? "").trim()
  if (account && (await metadataReady(account))) {
    console.log(`TOKEN_ACCOUNT is already ${account}. Not deploying.`)
    return
  }
  if (!account) {
    const made = await generateNearSecret()
    account = made.account
    secret = made.secretKey
    rememberToken(account, secret)
  } else if (!secret.startsWith("ed25519:")) {
    console.error("TOKEN_ACCOUNT is set but TOKEN_PRIVATE_KEY is missing")
    process.exit(1)
  }
  const code = new Uint8Array(readFileSync(wasmPath))
  const stake = BigInt(code.length) * 10_000_000_000_000_000_000n + 200_000_000_000_000_000_000_000n
  console.log(`contract account ${account}`)
  console.log(`wasm bytes ${code.length}`)
  console.log(`storage ${formatYocto(stake)} NEAR`)
  const balance = await readNearBalance(account)
  if (!balance.exists || balance.yocto < stake) {
    const have = balance.exists ? balance.yocto : 0n
    const need = stake - have
    const gasReserve = 50_000_000_000_000_000_000_000n
    const treasuryBalance = await readNearBalance(treasury)
    if (!treasuryBalance.exists || treasuryBalance.yocto < need + gasReserve) {
      console.error(
        `Treasury is short. Wasm bytes ${code.length}. Required yocto ${stake}. Transfer yocto ${need}. Treasury yocto ${treasuryBalance.yocto}.`,
      )
      process.exit(1)
    }
    console.log(`funding ${formatYocto(need)} NEAR for code storage`)
    const fundHash = await sendNearActions({
      signerId: treasury,
      secretKey: treasuryKey,
      receiverId: account,
      actions: [encodeTransfer(need)],
    })
    console.log(`fund tx ${fundHash}`)
    await waitForBalance(account, stake)
  }
  const deployHash = await sendNearActions({
    signerId: account,
    secretKey: secret,
    receiverId: account,
    actions: [
      encodeDeploy(code),
      encodeFunctionCall("new", jsonArgs({ minter: treasury }), 80_000_000_000_000n, 0n),
    ],
  })
  console.log(`deploy tx ${deployHash}`)
  const meta = await readTokenMetadata(account)
  console.log(`ft_metadata symbol ${meta.symbol} decimals ${meta.decimals}`)
  if (meta.symbol !== "QM" || meta.decimals !== 6) {
    console.error("TOKEN_ACCOUNT must be quick-market QM with 6 decimals.")
    process.exit(1)
  }
  console.log(`TOKEN_ACCOUNT ${account}`)
  console.log(`rpc ${nearRpcUrl()}`)
}

function writeAddress(address: string) {
  const text = existsSync(envPath()) ? readFileSync(envPath(), "utf8") : readFileSync(EXAMPLE_PATH, "utf8")
  writeFileSync(envPath(), writeNamedLine(text, "USDC_ADDRESS", address), { mode: 0o600 })
  chmodSync(envPath(), 0o600)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
