import { beforeEach, expect, test } from "bun:test"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { chainFromEnv } from "../shared/chain"
import { loginMessage } from "../shared/login"
import { getDb, useDatabase } from "./db"
import { openSession } from "./session"

beforeEach(() => {
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
