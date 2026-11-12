import { afterEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { chainFromEnv } from "../shared/chain"
import { loginMessage } from "../shared/login"
import { marketPreferences } from "../shared/market"
import { bindHttp, handle } from "./http"
import { useDatabase } from "./db"
import { advance, board, credit, notePrint, resetRuntime, youFor, type Print } from "./rounds"

let server: ReturnType<typeof Bun.serve> | null = null
let client: Client | null = null
const previousWindow = marketPreferences.windowSeconds
const previousMarket = marketPreferences.marketSeconds
const previousChain = marketPreferences.chain
const previousEnvChain = process.env.CHAIN

afterEach(async () => {
  marketPreferences.windowSeconds = previousWindow
  marketPreferences.marketSeconds = previousMarket
  marketPreferences.chain = previousChain
  if (previousEnvChain === undefined) delete process.env.CHAIN
  else process.env.CHAIN = previousEnvChain
  await client?.close().catch(() => undefined)
  client = null
  server?.stop(true)
  server = null
  resetRuntime()
  useDatabase(":memory:")
})

function payload(result: unknown) {
  const content = result && typeof result === "object" && "content" in result ? result.content : null
  const text = Array.isArray(content)
    ? content.find((item) => item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string")?.text
    : undefined
  if (typeof text !== "string") throw new Error("missing tool text")
  return JSON.parse(text) as Record<string, unknown>
}

test("mcp initialize, sign-in, book, and one buy-in", async () => {
  marketPreferences.chain = "base-sepolia"
  marketPreferences.windowSeconds = 120
  marketPreferences.marketSeconds = 120
  process.env.CHAIN = "base-sepolia"
  process.env.PRICE_SOURCE = "binance"
  resetRuntime()
  useDatabase(":memory:")
  let published = 0
  bindHttp({
    config: () => {
      throw new Error("config")
    },
    markets: () => ({ defaultChainKey: "base-sepolia", markets: [] }),
    liveChains: () => ["base-sepolia"],
    chainKey: () => "base-sepolia",
    treasuryReport: () => null,
    fundingReport: async () => null,
    grantsOpen: () => false,
    mint: async () => {},
    withdraw: async () => ({ ok: true }),
    publish: () => {
      published += 1
    },
    streamMetrics: () => ({}),
    serveUi: false,
    distDir: "",
  })
  server = Bun.serve({ port: 0, fetch: handle })
  const port = server.port
  client = new Client({ name: "quick-market-test", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?chain=base-sepolia`)))

  const listed = await client.listTools()
  const names = listed.tools.map((tool) => tool.name).sort()
  expect(names).toEqual(
    [
      "account",
      "book",
      "claim_grant",
      "login_message",
      "markets",
      "place_buy_in",
      "place_buy_ins",
      "round",
      "rounds",
      "sign_in",
      "sign_out",
      "tape",
      "withdraw",
    ].sort(),
  )

  const account = privateKeyToAccount(generatePrivateKey())
  const login = payload(await client.callTool({ name: "login_message", arguments: { address: account.address } }))
  expect(typeof login.message).toBe("string")
  expect(login.message).toBe(loginMessage(chainFromEnv("base-sepolia").id, account.address, login.issued as number))
  const signature = await account.signMessage({ message: String(login.message) })
  const signed = payload(
    await client.callTool({
      name: "sign_in",
      arguments: { address: account.address, signature, issued: login.issued },
    }),
  )
  expect(signed.address).toBe(account.address.toLowerCase())
  expect(signed.balanceMicros).toBe(0)
  expect(typeof signed.token).toBe("string")
  const funded = credit(account.address.toLowerCase(), 10_000_000)
  expect(funded.ok).toBe(true)

  const now = Date.now()
  const print: Print = { price: "100", exchangeTs: now - 500, receivedAt: now, source: "binance" }
  notePrint(print)
  advance(now)
  const roundId = board(now).join?.id
  expect(typeof roundId).toBe("number")

  const book = payload(await client.callTool({ name: "book", arguments: {} }))
  expect(book.feed).toBe("live")
  const bought = payload(
    await client.callTool({
      name: "place_buy_in",
      arguments: { side: "up", roundId, stake: "1" },
    }),
  )
  expect(bought.address).toBe(account.address.toLowerCase())
  expect(bought.balanceMicros).toBe(9_000_000)
  expect(youFor(account.address.toLowerCase())?.openBuyIns[0]?.roundId).toBe(roundId)
  expect(published).toBe(1)

  const rebound = payload(await client.callTool({ name: "sign_in", arguments: { token: signed.token } }))
  expect(rebound.address).toBe(account.address.toLowerCase())
  expect(rebound.balanceMicros).toBe(9_000_000)
  expect(rebound.token).toBeUndefined()
})
