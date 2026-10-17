import { beforeEach, expect, test } from "bun:test"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { chainFromEnv } from "../shared/chain"
import { botEnrollMessage, loginMessage } from "../shared/login"
import { enrollBot, resurrectBot } from "./agents"
import { holdBurn, refundBurn } from "./custody"
import { getDb, useDatabase } from "./db"
import { advance, board, credit, notePrint, placeBets, resetRuntime, youFor, type Print } from "./rounds"
import { openSession } from "./session"

const USDC = 1_000_000
const T = 10_000_000_000_000
const WINDOW = 5_000

function print(price: string, at: number): Print {
  return { price, exchangeTs: at, receivedAt: at, source: "binance" }
}

function address(n: number) {
  return `0x${n.toString(16).padStart(40, "0")}`
}

function bot(n: number, micros: number) {
  const who = address(n)
  if (micros > 0) {
    const result = credit(who, micros)
    if (!result.ok) throw new Error(result.error)
  } else {
    getDb().query("INSERT INTO users (address, balance_micros, created_at, is_bot) VALUES (?, 0, ?, 1)").run(who, 1)
    return who
  }
  getDb().query("UPDATE users SET is_bot = 1 WHERE address = ?").run(who)
  return who
}

beforeEach(() => {
  process.env.WINDOW_SECONDS = "5"
  process.env.MARKET_SECONDS = "5"
  process.env.FEE_BPS = "0"
  process.env.CHAIN = "base-sepolia"
  process.env.AGENT_SECRET = "test-secret"
  resetRuntime()
  useDatabase(":memory:")
})

test("one poor row does not reject the good rows, and a retry does not double the stake", () => {
  notePrint(print("100", T - 20))
  advance(T + 10)
  const rich = bot(1, 10 * USDC)
  const poor = bot(2, 0)
  const other = bot(3, 8 * USDC)
  const first = placeBets({
    now: T + 100,
    roundId: T / WINDOW,
    orders: [
      { address: rich, side: "up", stakeMicros: 1_500_000 },
      { address: poor, side: "down", stakeMicros: USDC },
      { address: other, side: "down", stakeMicros: 2_250_000 },
    ],
  })
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.accepted).toBe(2)
  expect(first.results.find((row) => row.address === poor)).toEqual({ address: poor, ok: false, error: "Insufficient balance" })
  expect(youFor(rich)?.balanceMicros).toBe(10 * USDC - 1_500_000)
  expect(youFor(other)?.balanceMicros).toBe(8 * USDC - 2_250_000)
  const card = board(T + 100).join
  expect(card?.poolUpMicros).toBe(1_500_000)
  expect(card?.poolDownMicros).toBe(2_250_000)

  const again = placeBets({
    now: T + 150,
    roundId: T / WINDOW,
    orders: [
      { address: rich, side: "up", stakeMicros: 1_500_000 },
      { address: other, side: "down", stakeMicros: 2_250_000 },
    ],
  })
  expect(again.ok).toBe(true)
  if (!again.ok) return
  expect(again.accepted).toBe(0)
  expect(youFor(rich)?.balanceMicros).toBe(10 * USDC - 1_500_000)
  expect(board(T + 150).join?.poolUpMicros).toBe(1_500_000)
})

test("enroll seeds a bot once and will not take a person", async () => {
  const chain = chainFromEnv("base-sepolia")
  const account = privateKeyToAccount(generatePrivateKey())
  const issued = Date.now()
  const seed = 12_000_000
  const signature = await account.signMessage({ message: botEnrollMessage(chain.id, account.address, issued, seed) })
  const minted: number[] = []
  const mint = async (amount: number) => {
    minted.push(amount)
  }
  const first = await enrollBot({ address: account.address, signature, issued, seedMicros: seed, now: issued, mint })
  expect(first.ok).toBe(true)
  if (first.ok) expect(first.seeded).toBe(true)
  expect(youFor(account.address.toLowerCase())?.balanceMicros).toBe(seed)
  const again = await enrollBot({ address: account.address, signature, issued, seedMicros: seed, now: issued, mint })
  expect(again.ok).toBe(true)
  if (again.ok) expect(again.seeded).toBe(false)
  expect(minted).toEqual([seed])

  const person = privateKeyToAccount(generatePrivateKey())
  const humanIssued = Date.now()
  const humanSignature = await person.signMessage({
    message: botEnrollMessage(chain.id, person.address, humanIssued, seed),
  })
  const opened = await openSession({
    address: person.address,
    signature: await person.signMessage({ message: loginMessage(chain.id, person.address, humanIssued) }),
    issued: humanIssued,
    now: humanIssued,
  })
  expect(opened.ok).toBe(true)
  const stolen = await enrollBot({
    address: person.address,
    signature: humanSignature,
    issued: humanIssued,
    seedMicros: seed,
    now: humanIssued,
    mint,
  })
  expect(stolen.ok).toBe(false)
  expect(minted).toEqual([seed])
})

test("a burn debits a bot and a refund puts the balance back", () => {
  const who = bot(9, 50 * USDC)
  const held = holdBurn(who, 20 * USDC)
  expect(held.ok).toBe(true)
  if (!held.ok) return
  expect(youFor(who)?.balanceMicros).toBe(30 * USDC)
  const row = getDb().query("SELECT status, amount_micros FROM burns WHERE id = ?").get(held.id) as { status: string; amount_micros: number }
  expect(row).toEqual({ status: "pending", amount_micros: 20 * USDC })
  refundBurn(held.id)
  expect(youFor(who)?.balanceMicros).toBe(50 * USDC)
  const human = address(10)
  credit(human, 10 * USDC)
  expect(holdBurn(human, USDC).ok).toBe(false)
  expect(youFor(human)?.balanceMicros).toBe(10 * USDC)
})

test("a floor mint refuses a bot that is already above the floor", async () => {
  const who = bot(11, 2 * USDC)
  const minted: number[] = []
  const filled = await resurrectBot({
    address: who,
    amountMicros: 8 * USDC,
    mint: async (amount) => {
      minted.push(amount)
    },
  })
  expect(filled.ok).toBe(true)
  if (filled.ok) expect(filled.balanceMicros).toBe(10 * USDC)
  expect(minted).toEqual([8 * USDC])
  const fat = await resurrectBot({
    address: who,
    amountMicros: USDC,
    mint: async (amount) => {
      minted.push(amount)
    },
  })
  expect(fat.ok).toBe(false)
  expect(minted).toEqual([8 * USDC])
})
