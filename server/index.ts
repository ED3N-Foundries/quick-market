import { existsSync } from "node:fs"
import { join, normalize, sep } from "node:path"
import { parseLang, stampHtml, type Lang } from "../shared/lang"
import { loadMarket, requireExplicitChain, TICK_MS, type PublicConfig } from "../shared/market"
import { feeBps, marketMs, MIN_STAKE_MICROS, priceSource, viewMs, windowMs, type PriceSource } from "./config"
import { takeTick } from "./tick"
import { configuredChain, loadEnv } from "./env"
import { handleAgents } from "./agents"
import { startChainRuntime, type ChainRuntime } from "./chainRuntime"
import { MINT_CONFIRMATIONS } from "../shared/mint"
import { grantOnSignIn, grantSettings, noteGrantTx, settleGrantRequest, startGrant } from "./grant"
import { hub } from "./hub"
import { LAG_MAX_BYTES, lagEcho } from "./lag"
import { parseMicros } from "./money"
import { feedsNow } from "./feeds"
import { oracleView, startOracle } from "./oracle"
import { adoptFeed, advance, board, failFeed, feedStatus, handoffNow, listRounds, noteAlive, notePrint, placeBuyIn, roundDetail, tapePoints, tickerNow, youFor } from "./rounds"
import { agentAuthorized, endSession, openSession, readSession } from "./session"

let activeChain: ChainRuntime
let chain: ReturnType<typeof configuredChain>
let treasury: string

const port = loadEnv().port
const distDir = join(import.meta.dir, "..", "dist")
const serveUi = loadEnv().nodeEnv === "production"

async function bootServer() {
  requireExplicitChain()
  loadMarket()
  activeChain = await startChainRuntime()
  chain = activeChain.chain
  treasury = activeChain.treasury
}

try {
  await bootServer()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

function grantsOpen(): boolean {
  return activeChain.grantsOpen
}

function mintTreasury(amount: number, onHash?: (hash: string) => void): Promise<void> {
  return activeChain.mint(amount, onHash)
}

let pending: { price: string; exchangeTs: number; source: PriceSource } | null = null
let lastTickAt = 0
let lastFeed: "live" | "stale" | null = null

const runtime = globalThis as unknown as {
  quickMarketTimer?: ReturnType<typeof setInterval>
  quickMarketStopOracle?: () => void
}
runtime.quickMarketStopOracle?.()
runtime.quickMarketStopOracle = startOracle({
  onPrint(print) {
    notePrint(print)
    pending = { price: print.price, exchangeTs: print.exchangeTs, source: print.source }
  },
  onAlive(at) {
    noteAlive(at)
  },
  onBreak(event) {
    const settled = failFeed(event.from, event.to, event.at)
    for (const item of settled) hub.broadcast({ type: "settled", serverNow: event.at, ...item })
    publishRound(event.at)
  },
  onAdopt(event) {
    adoptFeed(event.to, event.at)
    publishRound(event.at)
  },
})

let roundDirty = false

function markRoundDirty() {
  roundDirty = true
}

function publishRound(now = Date.now()) {
  roundDirty = false
  const feed = feedStatus(now)
  lastFeed = feed
  const ticker = tickerNow()
  hub.broadcast({
    type: "round",
    serverNow: now,
    feed,
    source: ticker.venue,
    ticker,
    handoff: handoffNow(),
    board: board(now),
  })
}

if (runtime.quickMarketTimer) clearInterval(runtime.quickMarketTimer)
runtime.quickMarketTimer = setInterval(() => {
  try {
    const now = Date.now()
    const { settled, broadcastRound } = advance(now)
    const feed = feedStatus(now)
    if (pending) {
      const due = takeTick(pending, lastTickAt, now, TICK_MS)
      if (due.send) {
        pending = null
        lastTickAt = due.lastSentAt
        hub.broadcast({ type: "tick", ...due.send, serverNow: now, feed })
      }
    }
    for (const event of settled) hub.broadcast({ type: "settled", serverNow: now, ...event })
    if (broadcastRound || roundDirty || feed !== lastFeed) publishRound(now)
  } catch (error) {
    console.error(error)
  }
}, 16)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

async function readJson(req: Request) {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function publicConfig(): PublicConfig {
  const grant = grantsOpen() ? grantSettings() : { amount: 0, intervalMs: 0 }
  return {
    windowSeconds: windowMs() / 1000,
    marketSeconds: marketMs() / 1000,
    viewSeconds: viewMs() / 1000,
    feeBps: feeBps(),
    minStakeMicros: MIN_STAKE_MICROS,
    source: priceSource(),
    chainId: chain.id,
    chainKey: chain.key,
    chainName: chain.name,
    usdc: activeChain.token,
    treasury,
    moneyLabel: activeChain.moneyLabel,
    tokenKind: activeChain.tokenKind,
    tokenLabel: activeChain.tokenLabel,
    grantMicros: grant.amount,
    grantIntervalMs: grant.intervalMs,
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(publicConfig())
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, source: priceSource(), chain: chain.key, treasury: activeChain.treasuryReport() })
  }

  if (req.method === "GET" && url.pathname === "/api/feeds") {
    const now = Date.now()
    return json(
      feedsNow(oracleView(), {
        configured: priceSource(),
        live: feedStatus(now),
        handoff: handoffNow(),
        now,
      }),
    )
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const now = Date.now()
    const session = readSession(req, now)
    if (session.rejected) return json({ error: "Sign in again" }, 401)
    return json({
      serverNow: now,
      feed: feedStatus(now),
      config: publicConfig(),
      ticker: tickerNow(),
      handoff: handoffNow(),
      board: board(now),
      you: session.address ? youFor(session.address) : null,
      tape: tapePoints(),
    })
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await readJson(req)
    const issued = body?.issued
    if (typeof issued !== "number") return json({ error: "Sign-in expired" }, 400)
    const result = await openSession({
      address: String(body?.address ?? ""),
      signature: String(body?.signature ?? ""),
      issued,
      now: Date.now(),
      botSecret: body?.botSecret,
      nonce: body?.nonce,
      publicKey: body?.publicKey,
    })
    if (!result.ok) return json({ error: result.error }, 400)
    if (grantsOpen() && grantOnSignIn(result.you.grantAt)) {
      const settings = grantSettings()
      const started = startGrant({
        address: result.you.address,
        now: Date.now(),
        chainKey: chain.key,
        amount: settings.amount,
        intervalMs: settings.intervalMs,
        mint: (amount) => mintTreasury(amount, (hash) => noteGrantTx(result.you.address, hash, chain.key)),
      })
      if (started.claimed) {
        void started.done.catch((error) => {
          console.error(error instanceof Error ? error.message : error)
        })
      }
    }
    return json({ token: result.token, you: youFor(result.you.address) })
  }

  if (req.method === "DELETE" && url.pathname === "/api/session") {
    endSession(req)
    return json({ ok: true })
  }

  if (req.method === "POST" && url.pathname === "/api/grant") {
    if (!grantsOpen()) return json({ error: "Grants are only on testnet." }, 400)
    const session = readSession(req)
    if (!session.address) return json({ error: "Sign in to receive a grant." }, 401)
    const address = session.address
    const now = Date.now()
    const settings = grantSettings()
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
      chainKey: chain.key,
      amount: settings.amount,
      intervalMs: settings.intervalMs,
      mint: (amount) =>
        mintTreasury(amount, (hash) => {
          noteGrantTx(address, hash, chain.key)
          reportHash(hash)
        }),
    })
    if (!started.claimed) {
      const you = youFor(address)
      return json({
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
      if (settled.kind === "pending") {
        void done.then(
          () => undefined,
          (error) => console.error(error instanceof Error ? error.message : error),
        )
        return json({
          granted: false,
          pending: true,
          txHash: settled.txHash,
          confirmations: MINT_CONFIRMATIONS,
          you: youFor(address),
        })
      }
      return json({
        granted: settled.value,
        pending: false,
        txHash: seenHash,
        confirmations: MINT_CONFIRMATIONS,
        you: youFor(address),
      })
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      return json({ error: "The grant did not land. Try again.", txHash: seenHash, you: youFor(address) }, 502)
    }
  }

  if (req.method === "POST" && url.pathname === "/api/withdraw") {
    const session = readSession(req)
    if (!session.address) return json({ error: "Connect a wallet first" }, 401)
    const body = await readJson(req)
    const amount = parseMicros(body?.amount)
    if (amount === null) return json({ error: "Amount is invalid" }, 400)
    const result = await activeChain.withdraw(session.address, amount)
    if (!result.ok) return json({ error: result.error, you: result.you ?? null }, 400)
    return json({ you: result.you, txHash: result.txHash })
  }

  if (url.pathname.startsWith("/api/agents/")) {
    if (!agentAuthorized(req.headers.get("x-agent-secret"))) return json({ error: "Unauthorized" }, 401)
    return handleAgents(req, url, { mint: (amount) => mintTreasury(amount), publish: markRoundDirty })
  }

  if (req.method === "POST" && url.pathname === "/api/buy-ins") {
    const now = Date.now()
    const session = readSession(req, now)
    if (!session.address) return json({ error: "Connect a wallet first" }, 401)
    const body = await readJson(req)
    const stake = parseMicros(body?.stake)
    const side = body?.side === "up" || body?.side === "down" ? body.side : null
    const roundId = body?.roundId
    if (!side) return json({ error: "Side is invalid" }, 400)
    if (stake === null) return json({ error: "Stake is invalid" }, 400)
    if (typeof roundId !== "number") return json({ error: "Market is invalid" }, 400)
    const result = placeBuyIn({ address: session.address, side, stakeMicros: stake, roundId, now })
    if (!result.ok) return json(result.code ? { error: result.error, code: result.code } : { error: result.error }, 400)
    markRoundDirty()
    return json({ you: result.you })
  }

  if (req.method === "GET" && url.pathname === "/api/rounds") {
    const limit = Number(url.searchParams.get("limit") ?? 10)
    const mine = url.searchParams.get("mine") === "1"
    const session = mine ? readSession(req) : { address: null, rejected: false }
    if (mine && !session.address) return json({ error: "Connect a wallet first" }, 401)
    return json({ rounds: listRounds(Number.isFinite(limit) ? limit : 10, session.address, mine) })
  }

  const detailMatch = url.pathname.match(/^\/api\/rounds\/(\d+)$/)
  if (req.method === "GET" && detailMatch) {
    const detail = roundDetail(Number(detailMatch[1]))
    if (!detail) return json({ error: "Round not found" }, 404)
    return json(detail)
  }

  if (serveUi && req.method === "GET") {
    const file = await staticFile(url)
    if (file) return file
  }

  return json({ error: "Not found" }, 404)
}

async function staticFile(url: URL): Promise<Response | null> {
  if (!existsSync(distDir)) return null
  const pathname = url.pathname
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const full = normalize(join(distDir, rel))
  const root = normalize(distDir)
  if (full !== root && !full.startsWith(root + sep)) return null
  const lang = parseLang(url.searchParams.get("lang"))
  const file = Bun.file(full)
  if (await file.exists()) return serveAsset(file, full.endsWith(`${sep}index.html`) || pathname === "/", lang)
  const index = Bun.file(join(distDir, "index.html"))
  if (await index.exists()) return serveAsset(index, true, lang)
  return null
}

async function serveAsset(file: Bun.BunFile, html: boolean, lang: Lang | null): Promise<Response> {
  if (!html || !lang) return new Response(file)
  return new Response(stampHtml(await file.text(), lang), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-language": lang,
    },
  })
}

const host = process.env.HOST?.trim() || "127.0.0.1"

Bun.serve({
  port,
  hostname: host,
  // Default is 10s. A mint submit plus three blocks can run longer, and cutting
  // the request there reported a failure while the credit still landed.
  idleTimeout: 90,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined as unknown as Response
      return new Response("Expected websocket", { status: 400 })
    }
    return handle(req).catch((error) => {
      console.error(error)
      return json({ error: "Server error" }, 500)
    })
  },
  websocket: {
    // Ping about 32s into a 48s idle so a quiet socket stays inside Cloudflare's 100s proxy cut.
    // The browser answers without page timers. A frozen tab cannot, and the socket closes.
    idleTimeout: 48,
    sendPings: true,
    open(ws) {
      hub.add(ws)
      const now = Date.now()
      ws.send(
        JSON.stringify({
          type: "round",
          serverNow: now,
          feed: feedStatus(now),
          source: tickerNow().venue,
          ticker: tickerNow(),
          handoff: handoffNow(),
          board: board(now),
        }),
      )
    },
    message(ws, raw) {
      const size = typeof raw === "string" ? raw.length : raw.byteLength
      if (size > LAG_MAX_BYTES) return
      const text = typeof raw === "string" ? raw : raw.toString()
      const recv = Date.now()
      const reply = lagEcho(text, recv, Date.now())
      if (reply) ws.send(reply)
    },
    close(ws) {
      hub.remove(ws)
    },
  },
})

console.log(`quick market api http://127.0.0.1:${port}`)
