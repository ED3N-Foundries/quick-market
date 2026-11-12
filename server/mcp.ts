import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import * as z from "zod"
import { MINT_CONFIRMATIONS } from "../shared/mint"
import { loginMessage, nearLoginMessage } from "../shared/login"
import type { ChainKey } from "../shared/chain"
import type { PublicConfig } from "../shared/market"
import { activeChainKey } from "./activeChain"
import { chainConfig } from "./env"
import { grantSettings, noteGrantTx, settleGrantRequest, startGrant } from "./grant"
import { normalizeAccount, parseMicros } from "./money"
import {
  accountResults,
  board,
  feedStatus,
  handoffNow,
  listRounds,
  placeBuyIn,
  placeBuyIns,
  roundDetail,
  tapeRange,
  tapeTail,
  youFor,
  type BuyInOrder,
} from "./rounds"
import { endSessionToken, openSession, readSessionToken } from "./session"

export type McpDeps = {
  markets: () => { defaultChainKey: ChainKey; markets: PublicConfig[] }
  grantsOpen: () => boolean
  mint: (amount: number, onHash?: (hash: string) => void) => Promise<void>
  withdraw: (address: string, amount: number) => Promise<{ ok: boolean; error?: string; you?: unknown; txHash?: string }>
  publish: () => void
}

type Bound = { address: string; token: string }

type LiveSession = {
  transport: WebStandardStreamableHTTPServerTransport
  accounts: Map<string, Bound>
}

const sessions = new Map<string, LiveSession>()

const readOnly = { readOnlyHint: true }

function textResult(body: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
    isError,
  }
}

function fail(error: string, code?: string) {
  return textResult(code ? { error, code } : { error }, true)
}

function rpcError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function refresh(accounts: Map<string, Bound>) {
  for (const [address, bound] of [...accounts]) {
    const session = readSessionToken(bound.token)
    if (session.address !== address) accounts.delete(address)
  }
}

function pickAccount(
  accounts: Map<string, Bound>,
  raw: string | undefined,
): { ok: true; bound: Bound } | { ok: false; error: string } {
  refresh(accounts)
  if (raw) {
    const address = normalizeAccount(raw, activeChainKey())
    if (!address) return { ok: false, error: "Address is invalid" }
    const bound = accounts.get(address)
    if (!bound) return { ok: false, error: "Sign in on this market" }
    return { ok: true, bound }
  }
  if (accounts.size === 1) return { ok: true, bound: [...accounts.values()][0]! }
  if (accounts.size === 0) return { ok: false, error: "Sign in first" }
  return { ok: false, error: "Name the account" }
}

function stakeOf(stake: string | undefined, stakeMicros: number | undefined): number | null {
  if (stakeMicros !== undefined) return Number.isSafeInteger(stakeMicros) && stakeMicros > 0 ? stakeMicros : null
  return parseMicros(stake)
}

function registerTools(server: McpServer, accounts: Map<string, Bound>, deps: McpDeps) {
  server.registerTool(
    "markets",
    {
      description: "List the markets that are on, and which one this connection is using.",
      annotations: readOnly,
    },
    async () => textResult({ ...deps.markets(), chain: activeChainKey() }),
  )

  server.registerTool(
    "login_message",
    {
      description: "The exact string a wallet signs to sign in. The signature is made locally. This server never sees a private key.",
      inputSchema: { address: z.string() },
      annotations: readOnly,
    },
    async ({ address }) => {
      const chain = activeChainKey()
      const who = normalizeAccount(address, chain)
      if (!who) return fail("Address is invalid")
      const issued = Date.now()
      const message = chain === "near-testnet" ? nearLoginMessage(who, issued) : loginMessage(chainConfig().id, who, issued)
      return textResult({ address: who, message, issued })
    },
  )

  server.registerTool(
    "sign_in",
    {
      description:
        "Sign in an account. Pass the signature over the login_message string, plus issued, or pass a session token this server already issued to bind that account again. Later tools on this connection use the signed-in accounts and do not take the token. The result includes the address and the balance.",
      inputSchema: {
        address: z.string().optional(),
        signature: z.string().optional(),
        issued: z.number().optional(),
        nonce: z.string().optional(),
        publicKey: z.string().optional(),
        token: z.string().optional(),
      },
    },
    async (args) => {
      if (args.token && !args.signature) {
        const session = readSessionToken(args.token)
        if (!session.address) return fail("Sign in again")
        accounts.set(session.address, { address: session.address, token: args.token })
        const you = youFor(session.address)
        return textResult({ address: session.address, balanceMicros: you?.balanceMicros ?? 0 })
      }
      if (!args.address || !args.signature || typeof args.issued !== "number") return fail("Sign-in expired")
      const opened = await openSession({
        address: args.address,
        signature: args.signature,
        issued: args.issued,
        now: Date.now(),
        nonce: args.nonce,
        publicKey: args.publicKey,
      })
      if (!opened.ok) return fail(opened.error)
      accounts.set(opened.you.address, { address: opened.you.address, token: opened.token })
      return textResult({
        address: opened.you.address,
        balanceMicros: opened.you.balanceMicros,
        token: opened.token,
      })
    },
  )

  server.registerTool(
    "sign_out",
    {
      description: "End the session for one signed-in account, or for every account on this connection when no address is given.",
      inputSchema: { address: z.string().optional() },
    },
    async ({ address }) => {
      refresh(accounts)
      const targets: Bound[] = []
      if (address) {
        const picked = pickAccount(accounts, address)
        if (!picked.ok) return fail(picked.error)
        targets.push(picked.bound)
      } else {
        targets.push(...accounts.values())
      }
      const signedOut = targets.map((bound) => bound.address)
      for (const bound of targets) {
        endSessionToken(bound.token)
        accounts.delete(bound.address)
      }
      return textResult({ ok: true, signedOut })
    },
  )

  server.registerTool(
    "book",
    {
      description: "The live board, the price feed, the handoff, and a tail of the tape.",
      inputSchema: { tailMs: z.number().int().optional() },
      annotations: readOnly,
    },
    async ({ tailMs }) => {
      const now = Date.now()
      const tail = tailMs === undefined ? 90_000 : Math.min(120_000, Math.max(1_000, tailMs))
      return textResult({
        board: board(now),
        feed: feedStatus(now),
        handoff: handoffNow(),
        tape: tapeTail(now, tail),
      })
    },
  )

  server.registerTool(
    "tape",
    {
      description: "Prints between two timestamps. The range is capped at 15 minutes.",
      inputSchema: { from: z.number(), to: z.number() },
      annotations: readOnly,
    },
    async ({ from, to }) => {
      const now = Date.now()
      const end = Math.min(now, to)
      if (!Number.isFinite(end) || !Number.isFinite(from) || end < 0 || from < 0 || from > end) return fail("Tape range is invalid")
      const start = Math.max(from, end - 15 * 60 * 1000)
      return textResult({ tape: tapeRange(start, end) })
    },
  )

  server.registerTool(
    "rounds",
    {
      description:
        "Settled markets, newest first, at most 100. Pass after to walk forward from a round id, oldest first. mine is limited to a signed-in account.",
      inputSchema: {
        limit: z.number().int().optional(),
        mine: z.boolean().optional(),
        after: z.number().int().optional(),
        address: z.string().optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      if (args.after !== undefined && !Number.isSafeInteger(args.after)) return fail("Round is invalid")
      let address: string | null = null
      if (args.mine) {
        const picked = pickAccount(accounts, args.address)
        if (!picked.ok) return fail(picked.error)
        address = picked.bound.address
      }
      return textResult({
        rounds: listRounds(args.limit ?? 10, address, Boolean(args.mine), args.after),
      })
    },
  )

  server.registerTool(
    "round",
    {
      description: "One round, its buy-ins, and its tape.",
      inputSchema: { id: z.number().int() },
      annotations: readOnly,
    },
    async ({ id }) => {
      const detail = roundDetail(id)
      if (!detail) return fail("Round not found")
      return textResult(detail as unknown as Record<string, unknown>)
    },
  )

  server.registerTool(
    "account",
    {
      description: "Balance, open buy-ins, and recent results for a signed-in account.",
      inputSchema: { address: z.string().optional(), limit: z.number().int().optional() },
      annotations: readOnly,
    },
    async (args) => {
      const picked = pickAccount(accounts, args.address)
      if (!picked.ok) return fail(picked.error)
      const you = youFor(picked.bound.address)
      return textResult({
        address: picked.bound.address,
        balanceMicros: you?.balanceMicros ?? 0,
        you,
        results: accountResults(picked.bound.address, args.limit ?? 10),
      })
    },
  )

  server.registerTool(
    "place_buy_in",
    {
      description: "Place one buy-in for a signed-in account. stake is a dollar string such as \"1\" or \"1.5\". stakeMicros is an integer count of micros. One USDC is 1000000.",
      inputSchema: {
        address: z.string().optional(),
        side: z.enum(["up", "down"]),
        roundId: z.number().int(),
        stake: z.string().optional(),
        stakeMicros: z.number().int().optional(),
        requestId: z.string().optional(),
      },
    },
    async (args) => {
      const picked = pickAccount(accounts, args.address)
      if (!picked.ok) return fail(picked.error)
      const stake = stakeOf(args.stake, args.stakeMicros)
      if (stake === null) return fail("Stake is invalid")
      const result = placeBuyIn({
        address: picked.bound.address,
        side: args.side,
        stakeMicros: stake,
        roundId: args.roundId,
        requestId: args.requestId,
        now: Date.now(),
      })
      if (!result.ok) return fail(result.error, result.code)
      deps.publish()
      return textResult({ address: result.you.address, balanceMicros: result.you.balanceMicros, you: result.you })
    },
  )

  server.registerTool(
    "place_buy_ins",
    {
      description:
        "Place up to 200 buy-ins in one transaction. Every address must already be signed in on this connection. Each order uses the same window rules as one buy-in.",
      inputSchema: {
        roundId: z.number().int(),
        orders: z
          .array(
            z.object({
              address: z.string(),
              side: z.enum(["up", "down"]),
              stakeMicros: z.number().int(),
            }),
          )
          .max(200),
      },
    },
    async (args) => {
      refresh(accounts)
      const chain = activeChainKey()
      const orders: BuyInOrder[] = []
      for (const order of args.orders) {
        const address = normalizeAccount(order.address, chain)
        if (!address || !accounts.has(address)) return fail("Sign in on this market")
        orders.push({ address, side: order.side, stakeMicros: order.stakeMicros })
      }
      const result = placeBuyIns({ orders, roundId: args.roundId, now: Date.now() })
      if (!result.ok) return fail(result.error, result.code)
      if (result.accepted > 0) deps.publish()
      return textResult({ accepted: result.accepted, results: result.results })
    },
  )

  server.registerTool(
    "claim_grant",
    {
      description: "Claim the testnet grant for a signed-in account, when grants are open on this market.",
      inputSchema: { address: z.string().optional() },
    },
    async (args) => claimGrant(accounts, deps, args.address),
  )

  server.registerTool(
    "withdraw",
    {
      description:
        "Withdraw from a signed-in account to its wallet. amount is a dollar string. amountMicros is an integer count of micros. The ledger is debited and the wallet is paid.",
      inputSchema: {
        address: z.string().optional(),
        amount: z.string().optional(),
        amountMicros: z.number().int().optional(),
      },
    },
    async (args) => {
      const picked = pickAccount(accounts, args.address)
      if (!picked.ok) return fail(picked.error)
      const amount = args.amountMicros !== undefined ? (Number.isSafeInteger(args.amountMicros) && args.amountMicros > 0 ? args.amountMicros : null) : parseMicros(args.amount)
      if (amount === null) return fail("Amount is invalid")
      const result = await deps.withdraw(picked.bound.address, amount)
      if (!result.ok) return fail(result.error ?? "Withdraw failed")
      const you = youFor(picked.bound.address)
      return textResult({
        address: picked.bound.address,
        balanceMicros: you?.balanceMicros ?? 0,
        txHash: result.txHash ?? null,
        you: result.you ?? you,
      })
    },
  )
}

async function claimGrant(accounts: Map<string, Bound>, deps: McpDeps, raw: string | undefined) {
  if (!deps.grantsOpen()) return fail("Grants are only on testnet.")
  const picked = pickAccount(accounts, raw)
  if (!picked.ok) return fail(picked.error)
  const address = picked.bound.address
  const now = Date.now()
  const settings = grantSettings()
  const chainKey = activeChainKey()
  let seenHash: string | null = null
  let reportHash: (hash: string) => void = () => {}
  const hashPromise = new Promise<string>((resolve) => {
    reportHash = (hash) => {
      if (seenHash) return
      seenHash = hash
      resolve(hash)
    }
  })
  const started = startGrant({
    address,
    now,
    chainKey,
    amount: settings.amount,
    intervalMs: settings.intervalMs,
    mint: (amount) =>
      deps.mint(amount, (hash) => {
        noteGrantTx(address, hash, chainKey)
        reportHash(hash)
      }),
  })
  if (!started.claimed) {
    const you = youFor(address)
    return textResult({
      address,
      balanceMicros: you?.balanceMicros ?? 0,
      granted: false,
      pending: Boolean(you?.grantPending),
      txHash: you?.grantPending?.txHash ?? null,
      confirmations: MINT_CONFIRMATIONS,
      you,
    })
  }
  const done = started.done
  try {
    const settled = await settleGrantRequest({ done, hash: hashPromise })
    const you = youFor(address)
    if (settled.kind === "pending") {
      void done.then(
        () => undefined,
        (error) => console.error(error instanceof Error ? error.message : error),
      )
      return textResult({
        address,
        balanceMicros: you?.balanceMicros ?? 0,
        granted: false,
        pending: true,
        txHash: settled.txHash,
        confirmations: MINT_CONFIRMATIONS,
        you,
      })
    }
    return textResult({
      address,
      balanceMicros: you?.balanceMicros ?? 0,
      granted: settled.value,
      pending: false,
      txHash: seenHash,
      confirmations: MINT_CONFIRMATIONS,
      you,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    const you = youFor(address)
    return textResult(
      {
        error: "The grant did not land. Try again.",
        address,
        balanceMicros: you?.balanceMicros ?? 0,
        txHash: seenHash,
        you,
      },
      true,
    )
  }
}

/** Streamable HTTP on `/mcp`. One connection remembers every account that signed in on it. */
export async function handleMcp(req: Request, deps: McpDeps): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
    return rpcError(405, "Method not allowed")
  }
  const sessionId = req.headers.get("mcp-session-id")
  if (sessionId) {
    const live = sessions.get(sessionId)
    if (!live) return rpcError(404, "Session not found")
    return live.transport.handleRequest(req)
  }
  if (req.method !== "POST") return rpcError(400, "Bad Request: Mcp-Session-Id header is required")
  let body: unknown
  try {
    body = await req.clone().json()
  } catch {
    return rpcError(400, "Parse error")
  }
  if (!isInitializeRequest(body)) return rpcError(400, "Bad Request: Server not initialized")
  const accounts = new Map<string, Bound>()
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, accounts })
    },
    onsessionclosed: (id) => {
      sessions.delete(id)
    },
  })
  const server = new McpServer({ name: "quick-market", version: "1.0.0" })
  registerTools(server, accounts, deps)
  await server.connect(transport)
  return transport.handleRequest(req)
}
