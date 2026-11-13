import { afterEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { chainFromEnv } from "../shared/chain"
import { loginMessage, nearLoginMessage } from "../shared/login"
import { NEP413_RECIPIENT } from "../shared/nearKey"
import { marketPreferences } from "../shared/market"
import { bindHttp, handle } from "./http"
import { getDb, useDatabase } from "./db"
import { advance, board, credit, notePrint, resetRuntime, youFor, type Print } from "./rounds"

let server: ReturnType<typeof Bun.serve> | null = null
let client: Client | null = null
const previousWindow = marketPreferences.windowSeconds
const previousMarket = marketPreferences.marketSeconds
const previousChain = marketPreferences.chain
const previousGrant = marketPreferences.grantMicros
const previousGrantInterval = marketPreferences.grantIntervalMs
const previousEnvChain = process.env.CHAIN
let releaseMint: (() => void) | null = null

afterEach(async () => {
  releaseMint?.()
  releaseMint = null
  marketPreferences.windowSeconds = previousWindow
  marketPreferences.marketSeconds = previousMarket
  marketPreferences.chain = previousChain
  marketPreferences.grantMicros = previousGrant
  marketPreferences.grantIntervalMs = previousGrantInterval
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
  marketPreferences.grantMicros = 100_000_000
  marketPreferences.grantIntervalMs = 120_000
  process.env.CHAIN = "base-sepolia"
  process.env.PRICE_SOURCE = "binance"
  resetRuntime()
  useDatabase(":memory:")
  let published = 0
  const gate = new Promise<void>((resolve) => {
    releaseMint = resolve
  })
  bindHttp({
    config: () => {
      throw new Error("config")
    },
    markets: () => ({ defaultChainKey: "base-sepolia", markets: [] }),
    liveChains: () => ["base-sepolia", "near-testnet"],
    chainKey: () => "base-sepolia",
    treasuryReport: () => null,
    fundingReport: async () => null,
    grantsOpen: () => true,
    mint: () => gate,
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
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?chain=base-sepolia`))
  await client.connect(transport)
  const sessionId = transport.sessionId
  expect(sessionId).toBeTruthy()
  const stayed = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "markets", arguments: {} } }),
  })
  const stayedText = await stayed.text()
  expect(stayed.status).toBe(200)
  expect(stayedText).toContain('"chain":"base-sepolia"')
  const other = await fetch(`http://127.0.0.1:${port}/mcp?chain=near-testnet`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "markets", arguments: {} } }),
  })
  expect(other.status).toBe(400)
  expect(await other.text()).toContain("This connection is on another market")

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
  expect(login.chain).toBe("base-sepolia")
  expect(login.expiresInMs).toBe(120_000)
  expect(login.how).toBe("personal_sign the message. Call sign_in with address, signature, and issued.")
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
  expect(signed.amountMicros).toBe(100_000_000)
  expect(signed.intervalMs).toBe(120_000)
  expect(typeof signed.nextGrantAt).toBe("number")
  expect(signed.grantDue).toBe(true)
  expect(typeof signed.serverNow).toBe("number")
  expect(signed.pending).toBe(true)
  expect(signed.grantNote).toBe("The grant on this market is $100 every 2 minutes. Call claim_grant again after nextGrantAt.")
  expect(typeof signed.token).toBe("string")
  const claimed = payload(await client.callTool({ name: "claim_grant", arguments: {} }))
  expect(claimed.granted).toBe(false)
  expect(claimed.grantDue).toBe(true)
  expect(claimed.pending).toBe(true)
  expect(claimed.amountMicros).toBe(100_000_000)
  expect(claimed.intervalMs).toBe(120_000)
  const funded = credit(account.address.toLowerCase(), 10_000_000)
  expect(funded.ok).toBe(true)

  const now = Date.now()
  const print: Print = { price: "100", exchangeTs: now - 500, receivedAt: now, source: "binance" }
  notePrint(print)
  advance(now)
  const roundId = board(now).join?.id
  expect(typeof roundId).toBe("number")

  notePrint({ price: "90", exchangeTs: now - 30_000, receivedAt: now, source: "binance" })
  const book = payload(await client.callTool({ name: "book", arguments: {} }))
  expect(book.feed).toBe("live")
  expect(typeof book.serverNow).toBe("number")
  const tape = book.tape as { t: number }[]
  expect(tape.some((point) => point.t === now - 30_000)).toBe(false)
  expect(tape.some((point) => point.t === now - 500)).toBe(true)
  const wide = payload(await client.callTool({ name: "book", arguments: { tailMs: 90_000 } }))
  expect((wide.tape as { t: number }[]).some((point) => point.t === now - 30_000)).toBe(true)
  const bookTool = listed.tools.find((tool) => tool.name === "book")
  expect(bookTool?.description).toContain("board.join.strikeAt")
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

  const grantedAt = Date.now()
  getDb()
    .query("UPDATE users SET grant_at = ? WHERE chain_key = ? AND address = ?")
    .run(grantedAt, "base-sepolia", account.address.toLowerCase())
  const rebound = payload(await client.callTool({ name: "sign_in", arguments: { token: signed.token } }))
  expect(rebound.address).toBe(account.address.toLowerCase())
  expect(rebound.balanceMicros).toBe(9_000_000)
  expect(rebound.token).toBeUndefined()
  expect(rebound.intervalMs).toBe(120_000)
  expect(rebound.grantDue).toBe(false)
  expect(Number(rebound.nextGrantAt)).toBeGreaterThan(Number(rebound.serverNow))

  const again = payload(
    await client.callTool({
      name: "place_buy_in",
      arguments: { side: "down", roundId, stake: "1" },
    }),
  )
  expect(again.error).toBe("You are already on the other side")

  const marketsTool = listed.tools.find((tool) => tool.name === "markets")
  expect(marketsTool?.description).toContain("session token")
  const authed = new Client({ name: "quick-market-token-url", version: "1.0.0" })
  const authedTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp?chain=base-sepolia&token=${signed.token as string}`),
  )
  try {
    await authed.connect(authedTransport)
    const viewed = payload(await authed.callTool({ name: "account", arguments: {} }))
    expect(viewed.address).toBe(account.address.toLowerCase())
    expect(viewed.balanceMicros).toBe(9_000_000)
    const bare = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": authedTransport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "account", arguments: {} } }),
    })
    const bareText = await bare.text()
    expect(bare.status).toBe(200)
    expect(bareText).toContain(account.address.toLowerCase())
  } finally {
    await authed.close().catch(() => undefined)
  }
  const rejected = await fetch(`http://127.0.0.1:${port}/mcp?chain=base-sepolia&token=00`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check", version: "0" } },
    }),
  })
  expect(rejected.status).toBe(401)
  expect(await rejected.text()).toContain("Sign in again")
})

test("a second round on the same connection is rejected", async () => {
  marketPreferences.chain = "base-sepolia"
  marketPreferences.windowSeconds = 1
  marketPreferences.marketSeconds = 30
  process.env.CHAIN = "base-sepolia"
  process.env.PRICE_SOURCE = "binance"
  resetRuntime()
  useDatabase(":memory:")
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
    publish: () => {},
    streamMetrics: () => ({}),
    serveUi: false,
    distDir: "",
  })
  server = Bun.serve({ port: 0, fetch: handle })
  const port = server.port
  client = new Client({ name: "quick-market-test", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?chain=base-sepolia`)))
  const account = privateKeyToAccount(generatePrivateKey())
  const login = payload(await client.callTool({ name: "login_message", arguments: { address: account.address } }))
  const signature = await account.signMessage({ message: String(login.message) })
  await client.callTool({
    name: "sign_in",
    arguments: { address: account.address, signature, issued: login.issued },
  })
  const funded = credit(account.address.toLowerCase(), 10_000_000)
  expect(funded.ok).toBe(true)
  const opened = Date.now()
  notePrint({ price: "100", exchangeTs: opened, receivedAt: opened, source: "binance" })
  advance(opened)
  const roundId = board(opened).join?.id
  const bought = payload(await client.callTool({ name: "place_buy_in", arguments: { side: "up", roundId, stake: "1" } }))
  expect(bought.address).toBe(account.address.toLowerCase())
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const next = Date.now()
  notePrint({ price: "100", exchangeTs: next, receivedAt: next, source: "binance" })
  advance(next)
  const nextId = board(next).join?.id
  expect(nextId).not.toBe(roundId)
  const second = payload(await client.callTool({ name: "place_buy_in", arguments: { side: "up", roundId: nextId, stake: "1" } }))
  expect(second.error).toBe("Your last buy-in is still open")
})

test("NEAR login_message returns the NEP-413 nonce", async () => {
  marketPreferences.chain = "near-testnet"
  process.env.CHAIN = "near-testnet"
  resetRuntime()
  useDatabase(":memory:")
  bindHttp({
    config: () => {
      throw new Error("config")
    },
    markets: () => ({ defaultChainKey: "near-testnet", markets: [] }),
    liveChains: () => ["near-testnet"],
    chainKey: () => "near-testnet",
    treasuryReport: () => null,
    fundingReport: async () => null,
    grantsOpen: () => true,
    mint: async () => {},
    withdraw: async () => ({ ok: true }),
    publish: () => {},
    streamMetrics: () => ({}),
    serveUi: false,
    distDir: "",
  })
  server = Bun.serve({ port: 0, fetch: handle })
  const port = server.port
  client = new Client({ name: "quick-market-test", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?chain=near-testnet`)))
  const login = payload(await client.callTool({ name: "login_message", arguments: { address: "alice.testnet" } }))
  expect(login.chain).toBe("near-testnet")
  expect(login.address).toBe("alice.testnet")
  expect(login.message).toBe(nearLoginMessage("alice.testnet", login.issued as number))
  expect(login.recipient).toBe(NEP413_RECIPIENT)
  expect(Buffer.from(String(login.nonce), "base64")).toHaveLength(32)
  expect(login.how).toContain("NEP-413")
  expect(login.how).toContain("no callback")
  const described = (await client.listTools()).tools.find((tool) => tool.name === "login_message")?.description ?? ""
  expect(described).toContain("NEP-413")
  expect(described).toContain("publicKey")
})
