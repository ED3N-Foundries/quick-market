import { beforeEach, expect, test } from "bun:test"
import * as ed from "@noble/ed25519"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { chainFromEnv } from "../shared/chain"
import { loginMessage, nearLoginMessage } from "../shared/login"
import { marketPreferences } from "../shared/market"
import { NEP413_RECIPIENT, bs58, generateNearSecret, nep413Bytes, seedFromSecret } from "../shared/nearKey"
import { getDb, useDatabase } from "./db"
import { openSession } from "./session"

beforeEach(() => {
  marketPreferences.chain = "base-sepolia"
  process.env.CHAIN = "base-sepolia"
  process.env.AGENT_SECRET = "test-secret"
  useDatabase(":memory:")
})

async function sign(chainId: number, issued = Date.now()) {
  const account = privateKeyToAccount(generatePrivateKey())
  const signature = await account.signMessage({ message: loginMessage(chainId, account.address, issued) })
  return { account, signature, issued }
}

test("a signed session is accepted once", async () => {
  const chain = chainFromEnv("base-sepolia")
  const { account, signature, issued } = await sign(chain.id)
  const opened = await openSession({ address: account.address, signature, issued, now: issued })
  expect(opened.ok).toBe(true)
  if (opened.ok) expect(opened.you.address).toBe(account.address.toLowerCase())
  const again = await openSession({ address: account.address, signature, issued, now: issued })
  expect(again.ok).toBe(false)
})

test("a signature for another chain is rejected", async () => {
  const issued = Date.now()
  const { account, signature } = await sign(8453, issued)
  const opened = await openSession({ address: account.address, signature, issued, now: issued })
  expect(opened.ok).toBe(false)
})

test("an old signature is rejected", async () => {
  const chain = chainFromEnv("base-sepolia")
  const issued = Date.now() - 5 * 60 * 1000
  const { account, signature } = await sign(chain.id, issued)
  const opened = await openSession({ address: account.address, signature, issued, now: Date.now() })
  expect(opened.ok).toBe(false)
})

test("the agent secret marks a bot and a wrong secret does not", async () => {
  const chain = chainFromEnv("base-sepolia")
  const bot = await sign(chain.id)
  const human = await sign(chain.id)
  const marked = await openSession({
    address: bot.account.address,
    signature: bot.signature,
    issued: bot.issued,
    now: bot.issued,
    botSecret: "test-secret",
  })
  expect(marked.ok).toBe(true)
  const plain = await openSession({
    address: human.account.address,
    signature: human.signature,
    issued: human.issued,
    now: human.issued,
    botSecret: "nope",
  })
  expect(plain.ok).toBe(true)
  const botRow = getDb().query("SELECT is_bot FROM users WHERE address = ?").get(bot.account.address.toLowerCase()) as { is_bot: number }
  const humanRow = getDb().query("SELECT is_bot FROM users WHERE address = ?").get(human.account.address.toLowerCase()) as { is_bot: number }
  expect(botRow.is_bot).toBe(1)
  expect(humanRow.is_bot).toBe(0)
})


test("a NEAR NEP-413 signature opens a session only with its nonce", async () => {
  const previousKey = process.env.TREASURY_PRIVATE_KEY
  marketPreferences.chain = "near-testnet"
  try {
    const made = await generateNearSecret()
    process.env.TREASURY_PRIVATE_KEY = made.secretKey
    const issued = Date.now()
    const message = nearLoginMessage(made.account, issued)
    const nonce = new Uint8Array(32).fill(4)
    const signature = Buffer.from(
      await ed.signAsync(nep413Bytes(message, nonce, NEP413_RECIPIENT), seedFromSecret(made.secretKey)!),
    ).toString("hex")
    const publicKey = `ed25519:${bs58.encode(Buffer.from(made.account, "hex"))}`
    const opened = await openSession({
      address: made.account,
      signature,
      issued,
      now: issued,
      nonce: Buffer.from(nonce).toString("base64"),
      publicKey,
    })
    expect(opened.ok).toBe(true)

    const otherIssued = issued + 1
    const otherMessage = nearLoginMessage(made.account, otherIssued)
    const otherSignature = Buffer.from(
      await ed.signAsync(nep413Bytes(otherMessage, nonce, NEP413_RECIPIENT), seedFromSecret(made.secretKey)!),
    ).toString("hex")
    const wrongNonce = new Uint8Array(32).fill(5)
    const rejected = await openSession({
      address: made.account,
      signature: otherSignature,
      issued: otherIssued,
      now: otherIssued,
      nonce: Buffer.from(wrongNonce).toString("base64"),
      publicKey,
    })
    expect(rejected).toEqual({ ok: false, error: "Signature is invalid" })
  } finally {
    marketPreferences.chain = "base-sepolia"
    if (previousKey === undefined) delete process.env.TREASURY_PRIVATE_KEY
    else process.env.TREASURY_PRIVATE_KEY = previousKey
  }
})
