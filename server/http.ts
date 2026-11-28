import { existsSync } from "node:fs"
import { join, normalize, sep } from "node:path"
import type { ChainKey } from "../shared/chain"
import { parseLang, stampHtml, type Lang } from "../shared/lang"
import { MINT_CONFIRMATIONS } from "../shared/mint"
import type { PublicConfig } from "../shared/market"
import { priceSource, viewMs, windowMs } from "./config"
import { dbShapeStats, getDb } from "./db"
import { feedsNow } from "./feeds"
import { grantOnSignIn, grantSettings, nearGrantSkipsMint, startGrant } from "./grant"
import { NEAR_WITHDRAWALS_PAUSED } from "./nearLedger"
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
import { orderLatency } from "./orderLatency"
import { noteRequestError, snapshotProcessHealth } from "./processHealth"
import { parseMicros } from "./money"
import { NEAR_COOLDOWN_CODE, isNearCooling, nearCooldownStatus, nearDepositLag, nearRpcStatus, type NearFundingState } from "./near"
import { nearRuntimeSlot } from "./nearWatchdog"
import {
  board,
  feedLastReceivedAt,
  feedStatus,
  handoffNow,
  listRounds,
  placeBuyIn,
  roundDetail,
  tapeRange,
  tickerNow,
  youFor,
} from "./rounds"
import { withChain } from "./activeChain"
import { pickChain } from "./markets"
import { handleMcp, mcpSessionStats } from "./mcp"
import { endSession, lastAuthPrune, NEAR_BUSY, openSession, readSession, sessionChainForToken } from "./session"

export type HttpDeps = {
  config: () => PublicConfig
  markets: () => { defaultChainKey: ChainKey; markets: PublicConfig[] }
  liveChains: () => ChainKey[]
  chainKey: () => ChainKey
  treasuryReport: () => unknown
  fundingReport: () => Promise<unknown>
  grantsOpen: () => boolean
  mint: (amount: number, report?: (progress: { txHash?: string; seen: number }) => void) => Promise<void>
  withdraw: (address: string, amount: number) => Promise<{
    ok: boolean
    error?: string
    you?: unknown
    txHash?: string
    code?: string
    retryAfterMs?: number
    coolingUntil?: number | null
  }>
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

export function json(body: unknown, status = 200, extra?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
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

function nearFundingFor(chainKey: string): NearFundingState {
  if (chainKey !== "near-testnet") return { cooling: false, retryAfterMs: 0, untilMs: null, reason: null }
  return nearCooldownStatus()
}

/** Internal health/status are not request-scoped: NEAR telemetry is live
 *  whenever the NEAR runtime is live, even when BASE is the default chain. */
function isNearLive(http: Pick<HttpDeps, "liveChains" | "chainKey">): boolean {
  try {
    return http.liveChains().includes("near-testnet")
  } catch {
    return http.chainKey() === "near-testnet"
  }
}

function liveChainKeys(http: Pick<HttpDeps, "liveChains" | "chainKey">): ChainKey[] {
  try {
    const live = http.liveChains()
    if (Array.isArray(live) && live.length > 0) return [...live]
  } catch {
    // fall through to the active chain
  }
  return [http.chainKey()]
}

function nearLiveState(
  http: Pick<HttpDeps, "liveChains" | "chainKey">,
): { cooling: NearFundingState; rpc: ReturnType<typeof nearRpcStatus>; runtime: ReturnType<typeof nearRuntimeSlot> | null } {
  if (!isNearLive(http)) return { cooling: { cooling: false, retryAfterMs: 0, untilMs: null, reason: null }, rpc: [], runtime: null }
  return { cooling: nearCooldownStatus(), rpc: nearRpcStatus(), runtime: nearRuntimeSlot() }
}

function coolingResponse(funding: NearFundingState): Response {
  return json(
    {
      error: "NEAR funding paused — RPC cooling. Try again shortly.",
      code: NEAR_COOLDOWN_CODE,
      retryAfterMs: funding.retryAfterMs,
      coolingUntil: funding.untilMs,
      reason: funding.reason,
    },
    503,
  )
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
  const live = liveChainKeys(http)
  const near = nearLiveState(http)
  const cooling = near.cooling
  const status = proc?.status ?? "ok"
  const reason =
    cooling.cooling && status === "ok"
      ? `near rpc cooling — funding paused, trading live${cooling.reason ? `: ${cooling.reason}` : ""}`
      : (proc?.reason ?? null)
  const effective = cooling.cooling && status === "ok" ? "degraded" : status
  return json({
    ok: true,
    source: priceSource(),
    chain: http.chainKey(),
    liveChains: live,
    treasury: http.treasuryReport(),
    status: effective,
    reason,
    process: withDisk(proc),
    previous: proc?.previous ?? null,
    nearRpc: near.rpc,
    nearCooldown: cooling,
    nearRuntime: near.runtime,
    nearDeposit: isNearLive(http) ? nearDepositLag("near-testnet") : null,
    stream: http.streamMetrics(),
    orderLatency: orderLatency.snapshot(),
    mcp: mcpSessionStats(),
    auth: lastAuthPrune(),
    db: (() => {
      try {
        return dbShapeStats(getDb())
      } catch {
        return null
      }
    })(),
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
  const http = useDeps()
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
  const live = liveChainKeys(http)
  const near = nearLiveState(http)
  const cooling = near.cooling
  const status = proc?.status ?? "ok"
  const reason =
    cooling.cooling && status === "ok"
      ? `near rpc cooling — funding paused, trading live${cooling.reason ? `: ${cooling.reason}` : ""}`
      : (proc?.reason ?? null)
  const effective = cooling.cooling && status === "ok" ? "degraded" : status
  return json({
    serverNow: now,
    status: effective,
    reason,
    feed: feedStatus(now),
    liveChains: live,
    process: withDisk(proc),
    previous: proc?.previous ?? null,
    nearRpc: near.rpc,
    nearCooldown: cooling,
    nearRuntime: near.runtime,
    nearDeposit: isNearLive(http) ? nearDepositLag("near-testnet") : null,
    orderLatency: orderLatency.snapshot(now),
    mcp: mcpSessionStats(),
    auth: lastAuthPrune(),
    db: (() => {
      try {
        return dbShapeStats(getDb())
      } catch {
        return null
      }
    })(),
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
  return json(
    {
      serverNow: now,
      feed: feedStatus(now),
      config: http.config(),
      ticker: tickerNow(),
      handoff: handoffNow(),
      board: board(now),
      you: session.address ? youFor(session.address) : null,
      tape: tapeRange(now - tailMs, now),
      nearFunding: nearFundingFor(http.chainKey()),
    },
    200,
    { "cache-control": "no-store" },
  )
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
    nonce: body?.nonce,
    publicKey: body?.publicKey,
  })
  if (!result.ok) return json({ error: result.error }, result.error === NEAR_BUSY ? 503 : 400)
  if (http.grantsOpen() && grantOnSignIn(result.you.grantAt)) {
    const chainKey = http.chainKey()
    const skipMint = nearGrantSkipsMint(chainKey)
    if (skipMint || chainKey !== "near-testnet" || !nearFundingFor(chainKey).cooling) {
      const settings = grantSettings()
      const started = startGrant({
        address: result.you.address,
        now: Date.now(),
        chainKey,
        amount: settings.amount,
        intervalMs: settings.intervalMs,
        mint: (amount, report) => http.mint(amount, report),
        skipMint,
      })
      if (started.claimed) {
        void started.done.catch((error) => {
          if (!isNearCooling(error)) console.error(error instanceof Error ? error.message : error)
        })
      }
    }
  }
  return json({ token: result.token, you: youFor(result.you.address), nearFunding: nearFundingFor(http.chainKey()) })
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
  const skipMint = nearGrantSkipsMint(chainKey)
  if (chainKey === "near-testnet" && !skipMint) {
    const funding = nearFundingFor(chainKey)
    if (funding.cooling) return coolingResponse(funding)
  }
  const started = startGrant({
    address,
    now,
    chainKey,
    amount: settings.amount,
    intervalMs: settings.intervalMs,
    mint: (amount, report) => http.mint(amount, report),
    skipMint,
  })
  if (started.claimed) {
    void started.done.catch((error) => {
      console.error(error instanceof Error ? error.message : error)
    })
  }
  const you = youFor(address)
  return json({
    granted: false,
    pending: Boolean(you?.grantPending),
    txHash: you?.grantPending?.txHash ?? null,
    seen: you?.grantPending?.seen ?? 0,
    confirmations: MINT_CONFIRMATIONS,
    you,
  })
}

async function postWithdraw(req: Request): Promise<Response> {
  const http = useDeps()
  const session = readSession(req)
  if (!session.address) return json({ error: "Connect a wallet first" }, 401)
  if (nearGrantSkipsMint(http.chainKey())) {
    return json({ error: NEAR_WITHDRAWALS_PAUSED, you: youFor(session.address) }, 400)
  }
  if (http.chainKey() === "near-testnet") {
    const funding = nearFundingFor(http.chainKey())
    if (funding.cooling) return coolingResponse(funding)
  }
  const body = await readJson(req)
  const amount = parseMicros(body?.amount)
  if (amount === null) return json({ error: "Amount is invalid" }, 400)
  const result = await http.withdraw(session.address, amount)
  if (!result.ok) {
    if (result.code === NEAR_COOLDOWN_CODE || isNearCooling(result.error)) {
      return coolingResponse({
        cooling: true,
        retryAfterMs: result.retryAfterMs ?? 0,
        untilMs: result.coolingUntil ?? null,
        reason: typeof result.error === "string" ? result.error : null,
      })
    }
    return json({ error: result.error, you: result.you ?? null }, 400)
  }
  return json({ you: result.you, txHash: result.txHash })
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

/**
 * Public slim health (D1 §2 item 7). The compose healthcheck asserts
 * `status !== "down" && feedUp`, so a wedged market that still answers HTTP
 * flips the container unhealthy instead of looking fine.
 */
function slimHealth(): Record<string, unknown> {
  const now = Date.now()
  let status = "ok"
  try {
    status = snapshotProcessHealth().status ?? "ok"
  } catch {
    status = "ok"
  }
  const feedUp = feedStatus(now) === "live"
  const lastReceivedAt = feedLastReceivedAt()
  return {
    ok: true,
    status,
    feedUp,
    feedAgeMs: lastReceivedAt > 0 ? Math.max(0, now - lastReceivedAt) : null,
  }
}

type RouteHandler = (req: Request, url: URL) => Response | Promise<Response>

const routes: Record<string, RouteHandler> = {
  "GET /api/markets": () => json(useDeps().markets()),
  "GET /api/config": () => json(useDeps().config()),
  "GET /api/health": () => json(slimHealth()),
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

function bearer(req: Request): string | null {
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.get("authorization") ?? "")
  return match?.[1] ?? null
}

/** Docker-network only. Caddy does not proxy port 3002. */
export async function handleInternal(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (req.method !== "GET") return json({ error: "Not found" }, 404)
  if (url.pathname === "/api/health") return getHealth()
  if (url.pathname === "/api/health/history") return getHealthHistory(url)
  if (url.pathname === "/api/status") return getStatus()
  if (url.pathname === "/api/funding") return json(await useDeps().fundingReport())
  return json({ error: "Not found" }, 404)
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === "GET" && url.pathname === "/api/markets") return json(useDeps().markets())
  const live = useDeps().liveChains()
  const token = bearer(req)
  const picked = pickChain({
    raw: url.searchParams.get("chain"),
    sessionChain: token ? sessionChainForToken(token) : null,
    live,
  })
  if (!picked.ok) return json({ error: picked.error }, picked.status)
  return withChain(picked.chain, () => handleScoped(req, url))
}

async function handleScoped(req: Request, url: URL): Promise<Response> {
  if (url.pathname === "/mcp") return handleMcp(req, useDeps())
  const exact = routes[`${req.method} ${url.pathname}`]
  if (exact) return exact(req, url)
  if (req.method === "GET" && /^\/api\/rounds\/\d+$/.test(url.pathname)) {
    const detail = getRound(url)
    if (detail) return detail
  }
  if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404)
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
