import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootstrapChainEnv, envFilePath, fillEnvDefaults, parseEnvText, requiredEnvDefaults, selectedChain } from "./envFile"

let dir: string | null = null
const keys = ["CHAIN", "DB_PATH", "TREASURY_PRIVATE_KEY", "TOKEN_ACCOUNT", "RPC_URL"]
const previous = new Map<string, string | undefined>()

afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  previous.clear()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function fixture() {
  dir = mkdtempSync(join(tmpdir(), "qm-env-"))
  return dir
}

function remember(...names: string[]) {
  for (const key of names) if (!previous.has(key)) previous.set(key, process.env[key])
}

test("network files fill defaults without replacing existing values", () => {
  const source = "TREASURY_PRIVATE_KEY=keep-me\nRPC_URL=\nCUSTOM=value\n"
  const filled = fillEnvDefaults(source, "near-testnet")
  const values = parseEnvText(filled.text)
  expect(values.TREASURY_PRIVATE_KEY).toBe("keep-me")
  expect(values.RPC_URL).toBe("")
  expect(values.DB_PATH).toBe("data/quick-market.sqlite")
  expect(values.CUSTOM).toBe("value")
  expect(values.TOKEN_ACCOUNT).toBe("")
  expect(requiredEnvDefaults("base-sepolia").USDC_ADDRESS).toBe("")
  expect(fillEnvDefaults(filled.text, "near-testnet").changed).toBe(false)
})

test("the selected network file wins over legacy values and explicit CHAIN wins", () => {
  const root = fixture()
  writeFileSync(join(root, ".env"), "CHAIN=base-sepolia\nENV_FILES_VERSION=1\nDB_PATH=legacy.sqlite\nTREASURY_PRIVATE_KEY=legacy\n")
  writeFileSync(envFilePath("near-testnet", root), "DB_PATH=data/quick-market.sqlite\nTREASURY_PRIVATE_KEY=near-key\nTOKEN_ACCOUNT=token.testnet\n")
  remember(...keys)
  delete process.env.CHAIN
  delete process.env.DB_PATH
  delete process.env.TREASURY_PRIVATE_KEY
  delete process.env.TOKEN_ACCOUNT
  expect(bootstrapChainEnv(root)).toBe("base-sepolia")
  expect(selectedChain({ CHAIN: "near-testnet" }, root)).toBe("near-testnet")

  process.env.CHAIN = "near-testnet"
  expect(bootstrapChainEnv(root)).toBe("near-testnet")
  expect(process.env.DB_PATH as string | undefined).toBe("data/quick-market.sqlite")
  expect(process.env.TREASURY_PRIVATE_KEY as string | undefined).toBe("near-key")
  expect(process.env.TOKEN_ACCOUNT as string | undefined).toBe("token.testnet")
})

test("the first multichain launch selects NEAR without deleting legacy settings", () => {
  const root = fixture()
  writeFileSync(join(root, ".env"), "CHAIN=base-sepolia\nTREASURY_PRIVATE_KEY=keep-base\n")
  remember(...keys)
  process.env.CHAIN = "base-sepolia"
  expect(bootstrapChainEnv(root)).toBe("near-testnet")
  const legacy = parseEnvText(readFileSync(join(root, ".env"), "utf8"))
  expect(legacy.CHAIN).toBe("near-testnet")
  expect(legacy.TREASURY_PRIVATE_KEY).toBe("keep-base")
  expect(legacy.ENV_FILES_VERSION).toBe("1")
  expect(parseEnvText(readFileSync(envFilePath("near-testnet", root), "utf8")).DB_PATH).toBe("data/quick-market.sqlite")
})


test("a blank network key falls back only to a compatible legacy treasury", () => {
  const root = fixture()
  writeFileSync(join(root, ".env"), "CHAIN=near-testnet\nENV_FILES_VERSION=1\nTREASURY_PRIVATE_KEY=ed25519:legacy\n")
  writeFileSync(envFilePath("near-testnet", root), "TREASURY_PRIVATE_KEY=\n")
  remember(...keys)
  delete process.env.TREASURY_PRIVATE_KEY
  bootstrapChainEnv(root)
  expect(process.env.TREASURY_PRIVATE_KEY as string | undefined).toBe("ed25519:legacy")
})

test("an incompatible legacy treasury is not reused on the other chain", () => {
  const root = fixture()
  writeFileSync(join(root, ".env"), "CHAIN=near-testnet\nENV_FILES_VERSION=1\nTREASURY_PRIVATE_KEY=0xbase\n")
  writeFileSync(envFilePath("near-testnet", root), "TREASURY_PRIVATE_KEY=\n")
  remember(...keys)
  process.env.TREASURY_PRIVATE_KEY = "0xbase"
  bootstrapChainEnv(root)
  expect(process.env.TREASURY_PRIVATE_KEY as string | undefined).toBe("")
})
