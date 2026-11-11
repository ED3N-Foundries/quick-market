import { existsSync } from "node:fs"
import { join, normalize, sep } from "node:path"
import type { ChainKey } from "../shared/chain"
import { parseLang, stampHtml, type Lang } from "../shared/lang"
import { MINT_CONFIRMATIONS } from "../shared/mint"
import type { PublicConfig } from "../shared/market"
import { handleAgents } from "./agents"
import { priceSource, viewMs, windowMs } from "./config"
import { getDb } from "./db"
import { feedsNow } from "./feeds"
import { grantOnSignIn, grantSettings, noteGrantTx, settleGrantRequest, startGrant } from "./grant"
import { listArchives } from "./archive"
import {
  averageQueryStats,
  currentDisk,
  hangStats,
  queryPercentiles,
  readRecentHangs,
  readRecentHealth,
  routePercentiles,
} from "./selfHealth"
import { oracleView } from "./oracle"
import { noteRequestError, snapshotProcessHealth } from "./processHealth"
import { parseMicros } from "./money"
import {
  board,
  feedStatus,
  handoffNow,
  listRounds,
  placeBuyIn,
  roundDetail,
  tapeRange,
  tickerNow,
  youFor,
} from "./rounds"
import { agentAuthorized, endSession, openSession, readSession } from "./session"

export type HttpDeps = {
  config: () => PublicConfig
  chainKey: () => ChainKey
  treasuryReport: () => unknown
  grantsOpen: () => boolean
  mint: (amount: number, onHash?: (hash: string) => void) => Promise<void>
  withdraw: (address: string, amount: number) => Promise<{ ok: boolean; error?: string; you?: unknown; txHash?: string }>
  publish: () => void
  streamMetrics: () => unknown
  serveUi: boolean
  distDir: string
}

let deps: HttpDeps | null = null

export function bindHttp(next: HttpDeps) {
  deps = next
}

function useDeps(): HttpDeps {
  if (!deps) throw new Error("HTTP is not bound")
  return deps
}

export function json(body: unknown, status = 200) {
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

function withDisk(proc: ReturnType<typeof snapshotProcessHealth> | null) {
  if (!proc) return null
  const disk = currentDisk()
  return {
    ...proc,
    diskUsed: disk?.diskUsed ?? null,
    diskSize: disk?.diskSize ?? null,
    dbBytes: disk?.dbBytes ?? null,
  }
}

function emptyTails() {
  return {}
}

function getHealth(): Response {
  const http = useDeps()
  let proc: ReturnType<typeof snapshotProcessHealth> | null = null
  try {
    proc = snapshotProcessHealth()
  } catch {
    proc = null
  }
  let self: { samples: Record<string, unknown>[]; routes: Record<string, unknown>[] } = { samples: [], routes: [] }
  let archives: Record<string, unknown>[] = []
  try {
    const db = getDb()
    self = readRecentHealth(db, { limit: 12 })
    archives = listArchives(db, 10)
  } catch {
    // ignore
  }
  return json({
    ok: true,
    source: priceSource(),
    chain: http.chainKey(),
    treasury: http.treasuryReport(),
    status: proc?.status ?? "ok",
    reason: proc?.reason ?? null,
    process: withDisk(proc),
    previous: proc?.previous ?? null,
    stream: http.streamMetrics(),
    selfHealth: self,
    queryStats: (() => {
      try {
        return averageQueryStats(getDb(), Date.now() - 60 * 60 * 1000)
      } catch {
        return emptyTails()
      }
    })(),
    routePctl: (() => {
      try {
        return routePercentiles(getDb(), Date.now() - 60 * 60 * 1000)
      } catch {
        return emptyTails()
      }
    })(),
    queryPctl: (() => {
      try {
        return queryPercentiles(getDb(), Date.now() - 60 * 60 * 1000)
      } catch {
        return emptyTails()
      }
    })(),
    hangs: (() => {
      try {
        const db = getDb()
        return { recent: readRecentHangs(db, 20), hour: hangStats(db, Date.now() - 60 * 60 * 1000) }
      } catch {
        return { recent: [], hour: { count: 0, maxMs: 0, lastTs: null } }
      }
    })(),
    archives,
  })
}

function getHealthHistory(url: URL): Response {
  const limit = Number(url.searchParams.get("limit") ?? 36)
  const bootId = url.searchParams.get("bootId") ?? undefined
  try {
    const db = getDb()
    const health = readRecentHealth(db, { limit: Number.isFinite(limit) ? limit : 36, bootId })
    return json({
      ...health,
      hangs: readRecentHangs(db, 20),
      queryPctl: queryPercentiles(db, Date.now() - 60 * 60 * 1000),
      routePctl: routePercentiles(db, Date.now() - 60 * 60 * 1000),
    })
  } catch {
    return json({ samples: [], routes: [] })
  }
}

function getStatus(): Response {
  const now = Date.now()
  let proc: ReturnType<typeof snapshotProcessHealth> | null = null
  try {
    proc = snapshotProcessHealth()
  } catch {
    proc = null
  }
  let self: { samples: Record<string, unknown>[]; routes: Record<string, unknown>[] } = { samples: [], routes: [] }
  let hangs: { recent: unknown[]; hour: { count: number; maxMs: number; lastTs: number | null } } = {
    recent: [],
    hour: { count: 0, maxMs: 0, lastTs: null },
  }
  try {
    const db = getDb()
    self = readRecentHealth(db, { limit: 6 })
    hangs = { recent: readRecentHangs(db, 5), hour: hangStats(db, now - 60 * 60 * 1000) }
  } catch {
    // ignore
  }
  return json({
    serverNow: now,
    status: proc?.status ?? "ok",
    reason: proc?.reason ?? null,
    feed: feedStatus(now),
    process: withDisk(proc),
    previous: proc?.previous ?? null,
    selfHealth: self,
    hangs,
  })
}

function getFeeds(): Response {
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

function getTape(url: URL): Response {
  const now = Date.now()
  const to = Math.min(now, Number(url.searchParams.get("to") ?? now))
  const requestedFrom = Number(url.searchParams.get("from") ?? to - 30_000)
  if (!Number.isFinite(to) || !Number.isFinite(requestedFrom) || to < 0 || requestedFrom < 0 || requestedFrom > to) {
    return json({ error: "Tape range is invalid" }, 400)
  }
  const from = Math.max(requestedFrom, to - 15 * 60 * 1000)
  return json({ tape: tapeRange(from, to) })
}

function getState(req: Request): Response {
  const http = useDeps()
  const now = Date.now()
  const session = readSession(req, now)
  if (session.rejected) return json({ error: "Sign in again" }, 401)
  const tailMs = Math.max(30_000, windowMs() * 2, viewMs() * 2)
  return json({
    serverNow: now,
    feed: feedStatus(now),
    config: http.config(),
    ticker: tickerNow(),
    handoff: handoffNow(),
    board: board(now),
    you: session.address ? youFor(session.address) : null,
    tape: tapeRange(now - tailMs, now),
  })
}

async function postSession(req: Request): Promise<Response> {
  const http = useDeps()
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
  if (http.grantsOpen() && grantOnSignIn(result.you.grantAt)) {
    const settings = grantSettings()
    const chainKey = http.chainKey()
    const started = startGrant({
      address: result.you.address,
      now: Date.now(),
      chainKey,
      amount: settings.amount,
      intervalMs: settings.intervalMs,
      mint: (amount) => http.mint(amount, (hash) => noteGrantTx(result.you.address, hash, chainKey)),
    })
    if (started.claimed) {
      void started.done.catch((error) => {
        console.error(error instanceof Error ? error.message : error)
      })
    }
  }
  return json({ token: result.token, you: youFor(result.you.address) })
}

function deleteSession(req: Request): Response {
  endSession(req)
  return json({ ok: true })
}

async function postGrant(req: Request): Promise<Response> {
  const http = useDeps()
  if (!http.grantsOpen()) return json({ error: "Grants are only on testnet." }, 400)
  const session = readSession(req)
  if (!session.address) return json({ error: "Sign in to receive a grant." }, 401)
  const address = session.address
  const now = Date.now()
  const settings = grantSettings()
  const chainKey = http.chainKey()
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
      http.mint(amount, (hash) => {
        noteGrantTx(address, hash, chainKey)
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

async function postWithdraw(req: Request): Promise<Response> {
  const http = useDeps()
  const session = readSession(req)
  if (!session.address) return json({ error: "Connect a wallet first" }, 401)
  const body = await readJson(req)
  const amount = parseMicros(body?.amount)
  if (amount === null) return json({ error: "Amount is invalid" }, 400)
  const result = await http.withdraw(session.address, amount)
  if (!result.ok) return json({ error: result.error, you: result.you ?? null }, 400)
  return json({ you: result.you, txHash: result.txHash })
}

function postAgents(req: Request, url: URL): Response | Promise<Response> {
  const http = useDeps()
  if (!agentAuthorized(req.headers.get("x-agent-secret"))) return json({ error: "Unauthorized" }, 401)
  return handleAgents(req, url, { mint: (amount) => http.mint(amount), publish: http.publish })
}

function postBuyIn(req: Request): Promise<Response> {
  const http = useDeps()
  const now = Date.now()
  const session = readSession(req, now)
  if (!session.address) return Promise.resolve(json({ error: "Connect a wallet first" }, 401))
  return readJson(req).then((body) => {
    const stake = parseMicros(body?.stake)
    const side = body?.side === "up" || body?.side === "down" ? body.side : null
    const roundId = body?.roundId
    if (!side) return json({ error: "Side is invalid" }, 400)
    if (stake === null) return json({ error: "Stake is invalid" }, 400)
    if (typeof roundId !== "number") return json({ error: "Market is invalid" }, 400)
    const requestId = typeof body?.requestId === "string" ? body.requestId : undefined
    const result = placeBuyIn({ address: session.address!, side, stakeMicros: stake, roundId, requestId, now })
    if (!result.ok) return json(result.code ? { error: result.error, code: result.code } : { error: result.error }, 400)
    http.publish()
    return json({ you: result.you })
  })
}

function getRounds(req: Request, url: URL): Response {
  const limit = Number(url.searchParams.get("limit") ?? 10)
  const mine = url.searchParams.get("mine") === "1"
  const session = mine ? readSession(req) : { address: null, rejected: false }
  if (mine && !session.address) return json({ error: "Connect a wallet first" }, 401)
  return json({ rounds: listRounds(Number.isFinite(limit) ? limit : 10, session.address, mine) })
}

function getRound(url: URL): Response | null {
  const detailMatch = url.pathname.match(/^\/api\/rounds\/(\d+)$/)
  if (!detailMatch) return null
  const detail = roundDetail(Number(detailMatch[1]))
  if (!detail) return json({ error: "Round not found" }, 404)
  return json(detail)
}

async function staticFile(url: URL): Promise<Response | null> {
  const http = useDeps()
  if (!existsSync(http.distDir)) return null
  const pathname = url.pathname
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const full = normalize(join(http.distDir, rel))
  const root = normalize(http.distDir)
  if (full !== root && !full.startsWith(root + sep)) return null
  const lang = parseLang(url.searchParams.get("lang"))
  const file = Bun.file(full)
  if (await file.exists()) return serveAsset(file, full.endsWith(`${sep}index.html`) || pathname === "/", lang)
  const index = Bun.file(join(http.distDir, "index.html"))
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

type RouteHandler = (req: Request, url: URL) => Response | Promise<Response>

const routes: Record<string, RouteHandler> = {
  "GET /api/config": () => json(useDeps().config()),
  "GET /api/health": () => getHealth(),
  "GET /api/health/history": (_req, url) => getHealthHistory(url),
  "GET /api/status": () => getStatus(),
  "GET /api/feeds": () => getFeeds(),
  "GET /api/tape": (_req, url) => getTape(url),
  "GET /api/state": (req) => getState(req),
  "POST /api/session": (req) => postSession(req),
  "DELETE /api/session": (req) => deleteSession(req),
  "POST /api/grant": (req) => postGrant(req),
  "POST /api/withdraw": (req) => postWithdraw(req),
  "POST /api/buy-ins": (req) => postBuyIn(req),
  "GET /api/rounds": (req, url) => getRounds(req, url),
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const exact = routes[`${req.method} ${url.pathname}`]
  if (exact) return exact(req, url)
  if (url.pathname.startsWith("/api/agents/")) return postAgents(req, url)
  if (req.method === "GET" && /^\/api\/rounds\/\d+$/.test(url.pathname)) {
    const detail = getRound(url)
    if (detail) return detail
  }
  if (useDeps().serveUi && req.method === "GET") {
    const file = await staticFile(url)
    if (file) return file
  }
  return json({ error: "Not found" }, 404)
}

export async function handleSafe(req: Request): Promise<Response> {
  try {
    return await handle(req)
  } catch (error) {
    try {
      const url = new URL(req.url)
      noteRequestError(error, url.pathname)
    } catch {
      // ignore
    }
    throw error
  }
}
