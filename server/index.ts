import { existsSync } from "node:fs"
import { join, normalize, sep } from "node:path"
import { chainFromEnv } from "../shared/chain"
import { feeBps, marketMs, MIN_STAKE_MICROS, priceSource, viewMs, windowMs, type PriceSource } from "./config"
import { requestWithdraw, startCustody, treasuryAddress } from "./custody"
import { getDb } from "./db"
import { hub } from "./hub"
import { parseMicros } from "./money"
import { startOracle } from "./oracle"
import { advance, board, feedStatus, listRounds, notePrint, placeBet, roundDetail, tapePoints, youFor, type Side } from "./rounds"
import { endSession, openSession, readSession } from "./session"

let chain: ReturnType<typeof chainFromEnv>
try {
  chain = chainFromEnv(process.env.CHAIN)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

let treasury: string
try {
  treasury = treasuryAddress()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

const port = Number(process.env.PORT ?? 3001)
const distDir = join(import.meta.dir, "..", "dist")
const serveUi = process.env.NODE_ENV === "production"

getDb()
startCustody()

let pending: { price: string; exchangeTs: number; source: PriceSource } | null = null
let lastFeed: "live" | "stale" | null = null

const runtime = globalThis as unknown as {
  quickMarketTimer?: ReturnType<typeof setInterval>
  quickMarketStopOracle?: () => void
}
runtime.quickMarketStopOracle?.()
runtime.quickMarketStopOracle = startOracle((print) => {
  notePrint(print)
  pending = { price: print.price, exchangeTs: print.exchangeTs, source: print.source }
})

function publishRound(now = Date.now()) {
  const feed = feedStatus(now)
  lastFeed = feed
  hub.broadcast({ type: "round", serverNow: now, feed, source: priceSource(), board: board(now) })
}

if (runtime.quickMarketTimer) clearInterval(runtime.quickMarketTimer)
runtime.quickMarketTimer = setInterval(() => {
  try {
    const now = Date.now()
    const { settled, broadcastRound } = advance(now)
    const feed = feedStatus(now)
    if (pending) {
      const print = pending
      pending = null
      hub.broadcast({ type: "tick", ...print, serverNow: now, feed })
    }
    for (const event of settled) hub.broadcast({ type: "settled", serverNow: now, ...event })
    if (broadcastRound || feed !== lastFeed) publishRound(now)
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

function publicConfig() {
  return {
    windowSeconds: windowMs() / 1000,
    marketSeconds: marketMs() / 1000,
    viewSeconds: viewMs() / 1000,
    feeBps: feeBps(),
    minStakeMicros: MIN_STAKE_MICROS,
    source: priceSource(),
    chainId: chain.id,
    chainName: chain.name,
    usdc: chain.usdc,
    treasury,
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)

  if (req.method === "GET" && url.pathname === "/api/health") return json({ ok: true, source: priceSource() })

  if (req.method === "GET" && url.pathname === "/api/state") {
    const now = Date.now()
    const session = readSession(req, now)
    if (session.rejected) return json({ error: "Sign in again" }, 401)
    return json({
      serverNow: now,
      feed: feedStatus(now),
      config: publicConfig(),
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
    })
    if (!result.ok) return json({ error: result.error }, 400)
    return json({ token: result.token, you: result.you })
  }

  if (req.method === "DELETE" && url.pathname === "/api/session") {
    endSession(req)
    return json({ ok: true })
  }

  if (req.method === "POST" && url.pathname === "/api/withdraw") {
    const session = readSession(req)
    if (!session.address) return json({ error: "Connect a wallet first" }, 401)
    const body = await readJson(req)
    const amount = parseMicros(body?.amount)
    if (amount === null) return json({ error: "Amount is invalid" }, 400)
    const result = await requestWithdraw(session.address, amount)
    if (!result.ok) return json({ error: result.error, you: result.you ?? null }, 400)
    return json({ you: result.you, txHash: result.txHash })
  }

  if (req.method === "POST" && url.pathname === "/api/bets") {
    const session = readSession(req)
    if (!session.address) return json({ error: "Connect a wallet first" }, 401)
    const body = await readJson(req)
    const stake = parseMicros(body?.stake)
    const side = body?.side
    if (side !== "up" && side !== "down") return json({ error: "Side is invalid" }, 400)
    if (stake === null) return json({ error: "Stake is invalid" }, 400)
    const result = placeBet({ address: session.address, side: side as Side, stakeMicros: stake, now: Date.now() })
    if (!result.ok) return json({ error: result.error }, 400)
    publishRound()
    return json({ you: result.you, board: result.board })
  }

  if (req.method === "GET" && url.pathname === "/api/rounds") {
    const limit = Number(url.searchParams.get("limit") ?? 30)
    const mine = url.searchParams.get("mine") === "1"
    const session = mine ? readSession(req) : { address: null, rejected: false }
    if (mine && !session.address) return json({ error: "Connect a wallet first" }, 401)
    return json({ rounds: listRounds(Number.isFinite(limit) ? limit : 30, session.address, mine) })
  }

  const detailMatch = url.pathname.match(/^\/api\/rounds\/(\d+)$/)
  if (req.method === "GET" && detailMatch) {
    const detail = roundDetail(Number(detailMatch[1]))
    if (!detail) return json({ error: "Round not found" }, 404)
    return json(detail)
  }

  if (serveUi && req.method === "GET") {
    const file = await staticFile(url.pathname)
    if (file) return file
  }

  return json({ error: "Not found" }, 404)
}

async function staticFile(pathname: string): Promise<Response | null> {
  if (!existsSync(distDir)) return null
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const full = normalize(join(distDir, rel))
  const root = normalize(distDir)
  if (full !== root && !full.startsWith(root + sep)) return null
  const file = Bun.file(full)
  if (await file.exists()) return new Response(file)
  const index = Bun.file(join(distDir, "index.html"))
  if (await index.exists()) return new Response(index)
  return null
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
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
    open(ws) {
      hub.add(ws)
      const now = Date.now()
      ws.send(JSON.stringify({ type: "round", serverNow: now, feed: feedStatus(now), source: priceSource(), board: board(now) }))
    },
    message() {},
    close(ws) {
      hub.remove(ws)
    },
  },
})

console.log(`quick market api http://127.0.0.1:${port}`)
