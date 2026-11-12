import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import * as z from "zod"
import { MINT_CONFIRMATIONS } from "../shared/mint"
import { LOGIN_SKEW_MS, loginMessage, nearLoginMessage } from "../shared/login"
import type { ChainKey } from "../shared/chain"
import { NEP413_RECIPIENT } from "../shared/nearKey"
import type { PublicConfig } from "../shared/market"
import { activeChainKey, withChain } from "./activeChain"
import { chainConfig } from "./env"
import { grantOnSignIn, grantSettings, noteGrantTx, settleGrantRequest, startGrant } from "./grant"
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
  chain: ChainKey
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

function grantSentence(): string {
  const settings = grantSettings()
  const dollars = settings.amount / 1_000_000
  const money = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  const minutes = settings.intervalMs / 60_000
  const every = Number.isInteger(minutes) && minutes >= 1 ? `${minutes} minutes` : `${settings.intervalMs} ms`
  return `The grant on this market is ${money} every ${every}. Call claim_grant again after nextGrantAt.`
}

function grantView(address: string) {
  const settings = grantSettings()
  const you = youFor(address)
  const grantAt = you?.grantAt ?? null
  return {
    amountMicros: settings.amount,
    intervalMs: settings.intervalMs,
    nextGrantAt: grantAt == null ? Date.now() : grantAt + settings.intervalMs,
    grantNote: grantSentence(),
  }
}

function beginGrant(deps: McpDeps, address: string) {
  if (!deps.grantsOpen()) return
  const you = youFor(address)
  if (!grantOnSignIn(you?.grantAt ?? null)) return
  const settings = grantSettings()
  const chainKey = activeChainKey()
  const started = startGrant({
    address,
    now: Date.now(),
    chainKey,
    amount: settings.amount,
    intervalMs: settings.intervalMs,
    mint: (amount) => deps.mint(amount, (hash) => noteGrantTx(address, hash, chainKey)),
  })
  if (started.claimed) {
    void started.done.catch((error) => {
      console.error(error instanceof Error ? error.message : error)
    })
  }
}

function registerTools(server: McpServer, accounts: Map<string, Bound>, deps: McpDeps) {
  const market = chainConfig()
  const other = market.key === "near-testnet" ? "base-sepolia" : "near-testnet"
  const grantLine = deps.grantsOpen() ? grantSentence() : "Grants are closed on this market."
  server.registerTool(
    "markets",
    {
      description: `This connection trades only ${market.name} (${market.key}). The other market is /mcp?chain=${other}. A session token on this connector URL is already signed in. Call account.`,
      annotations: readOnly,
    },
    async () => textResult({ ...deps.markets(), chain: activeChainKey(), grantNote: grantLine }),
  )

  server.registerTool(
    "login_message",
    {
      description:
        market.key === "near-testnet"
          ? `The NEAR Testnet sign-in message for this connection. The wallet signs NEP-413: SHA-256 of the tagged payload (the message, the returned nonce, recipient ${NEP413_RECIPIENT}, no callback). Call sign_in with address, signature, issued, nonce, and publicKey. The message expires in 2 minutes. This server never sees a private key.`
          : `The ${market.name} sign-in message for this connection. personal_sign that exact string. Call sign_in with address, signature, and issued. The message expires in 2 minutes. This server never sees a private key.`,
      inputSchema: { address: z.string() },
      annotations: readOnly,
    },
    async ({ address }) => {
      const chain = activeChainKey()
      const who = normalizeAccount(address, chain)
      if (!who) return fail("Address is invalid")
      const issued = Date.now()
      if (chain === "near-testnet") {
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
        return textResult({
          chain,
          address: who,
          message: nearLoginMessage(who, issued),
          issued,
          expiresInMs: LOGIN_SKEW_MS,
          nonce,
          recipient: NEP413_RECIPIENT,
          how: `NEP-413. Sign SHA-256 of the tagged payload (message, nonce, recipient ${NEP413_RECIPIENT}, no callback). Call sign_in with address, signature, issued, nonce, and publicKey (ed25519 base58).`,
        })
      }
      return textResult({
        chain,
        address: who,
        message: loginMessage(chainConfig().id, who, issued),
        issued,
        expiresInMs: LOGIN_SKEW_MS,
        how: "personal_sign the message. Call sign_in with address, signature, and issued.",
      })
    },
  )

  server.registerTool(
    "sign_in",
    {
      description:
        market.key === "near-testnet"
          ? `Sign in an account on NEAR Testnet. Pass address, signature, issued, nonce, and publicKey from login_message. Or pass a session token this server already issued. Later tools on this connection use the signed-in accounts and do not take the token. ${grantLine}`
          : `Sign in an account on ${market.name}. Pass address, signature, and issued from login_message. Or pass a session token this server already issued. Later tools on this connection use the signed-in accounts and do not take the token. ${grantLine}`,
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
        beginGrant(deps, session.address)
        const you = youFor(session.address)
        return textResult({
          address: session.address,
          balanceMicros: you?.balanceMicros ?? 0,
          pending: Boolean(you?.grantPending),
          ...grantView(session.address),
        })
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
      beginGrant(deps, opened.you.address)
      const you = youFor(opened.you.address)
      return textResult({
        address: opened.you.address,
        balanceMicros: you?.balanceMicros ?? opened.you.balanceMicros,
        token: opened.token,
        pending: Boolean(you?.grantPending),
        ...grantView(opened.you.address),
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
      description: `Balance, open buy-ins, recent results, and the grant timer for a signed-in account on ${market.name}. ${grantLine}`,
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
        pending: Boolean(you?.grantPending),
        ...grantView(picked.bound.address),
      })
    },
  )

  server.registerTool(
    "place_buy_in",
    {
      description: `Place one buy-in on ${market.name}. One open round at a time. A second buy-in while that round is still open fails. The other market is /mcp?chain=${other}. stake is a dollar string such as "1" or "1.5". stakeMicros is an integer count of micros. One USDC is 1000000.`,
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
      description: `Claim the testnet grant on ${market.name}. ${grantLine}`,
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
      ...grantView(address),
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
        ...grantView(address),
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
      ...grantView(address),
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
        ...grantView(address),
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
    const asked = new URL(req.url).searchParams.get("chain")
    if (asked !== null && asked !== live.chain) return rpcError(400, "This connection is on another market")
    return withChain(live.chain, () => live.transport.handleRequest(req))
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
  const chain = activeChainKey()
  const token = new URL(req.url).searchParams.get("token")
  if (token !== null) {
    const session = readSessionToken(token)
    if (!session.address) return rpcError(401, "Sign in again")
    accounts.set(session.address, { address: session.address, token })
    beginGrant(deps, session.address)
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, accounts, chain })
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
