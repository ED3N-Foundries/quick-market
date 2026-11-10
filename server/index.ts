import { existsSync } from "node:fs"
import { dirname, join, normalize, sep } from "node:path"
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
import { MarketStream } from "./stream"
import { lagEcho } from "./lag"
import { parseMicros } from "./money"
import {
  heartbeatProcessHealth,
  initProcessHealth,
  noteBootFailure,
  noteFeedAdopt,
  noteFeedBreak,
  noteFeedLive,
  noteRequestError,
  noteTickError,
  noteTickOk,
  setProcessStatus,
  snapshotProcessHealth,
} from "./processHealth"
import {
  averageQueryStats,
  flushHealthSample,
  hangStats,
  HEALTH_SAMPLE_MS,
  noteRequest,
  noteTickSample,
  queryPercentiles,
  readRecentHangs,
  readRecentHealth,
  rollupHealthMinute,
  routePercentiles,
  startLagWatchdog,
  timedQuery,
} from "./selfHealth"
import { archiveOldHealth, archiveOldTicks, archivesSizeBytes, listArchives } from "./archive"
import { getDb } from "./db"
import { feedsNow } from "./feeds"
import { oracleView, startOracle } from "./oracle"
import {
  accountResults,
  adoptFeed,
  advance,
  board,
  failFeed,
  feedStatus,
  handoffNow,
  listRounds,
  noteAlive,
  notePrint,
  placeBuyIn,
  roundDetail,
  tapeRange,
  tickerNow,
  youFor,
} from "./rounds"
import { agentAuthorized, endSession, openSession, readSession, readSessionToken } from "./session"

let activeChain: ChainRuntime
let chain: ReturnType<typeof configuredChain>
let treasury: string

const bootEnv = (() => {
  try {
    return loadEnv()
  } catch {
    return null
  }
})()
const dbPathHint = process.env.DB_PATH?.trim() || bootEnv?.dbPath || "data/quick-market.sqlite"
try {
  initProcessHealth({ dbPath: dbPathHint })
} catch {
  // Health tracking must never prevent boot.
}
function bootPort(): number {
  if (bootEnv) return bootEnv.port
  const raw = Number(process.env.PORT)
  return Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : 3001
}
function bootNodeEnv(): string | undefined {
  return bootEnv?.nodeEnv ?? process.env.NODE_ENV
}
const port = bootPort()
const distDir = join(import.meta.dir, "..", "dist")
const serveUi = bootNodeEnv() === "production"

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
  try {
    noteBootFailure(error)
  } catch {
    // ignore
  }
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

const stream = new MarketStream({
  board: () => timedQuery("board", () => board()),
  tape: () => {
    const now = Date.now()
    const tailMs = Math.max(30_000, windowMs() * 2, viewMs() * 2)
    return timedQuery("tape", () => tapeRange(now - tailMs, now))
  },
  feed: () => feedStatus(Date.now()),
  ticker: tickerNow,
  handoff: handoffNow,
  youFor: (address) => timedQuery("you", () => youFor(address)),
  accountResults: (address) => timedQuery("results", () => accountResults(address)),
})

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
    try {
      noteFeedBreak(event.from, event.to, event.to ? "switched" : "waiting for a fresh venue")
    } catch {
      // ignore
    }
    for (const item of settled) stream.settled(item, event.at)
    publishRound(event.at)
  },
  onAdopt(event) {
    adoptFeed(event.to, event.at)
    try {
      noteFeedAdopt(event.to)
    } catch {
      // ignore
    }
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
  stream.book(now, feed)
}

if (runtime.quickMarketTimer) clearInterval(runtime.quickMarketTimer)
runtime.quickMarketTimer = setInterval(() => {
  const tickStart = performance.now()
  try {
    const now = Date.now()
    const { settled, broadcastRound } = timedQuery("advance", () => advance(now))
    const feed = feedStatus(now)
    try {
      noteTickOk(feed)
    } catch {
      // ignore
    }
    if (feed === "live") {
      try {
        noteFeedLive()
      } catch {
        // ignore
      }
    }
    try {
      heartbeatProcessHealth()
    } catch {
      // ignore
    }
    if (pending) {
      const due = takeTick(pending, lastTickAt, now, TICK_MS)
      if (due.send) {
        pending = null
        lastTickAt = due.lastSentAt
        stream.tick(due.send.price, due.send.exchangeTs, now, feed)
      }
    }
    for (const event of settled) stream.settled(event, now)
    if (broadcastRound || roundDirty || feed !== lastFeed) publishRound(now)
    try {
      noteTickSample(performance.now() - tickStart)
    } catch {
      // ignore
    }
  } catch (error) {
    try {
      noteTickSample(performance.now() - tickStart)
    } catch {
      // ignore
    }
    try {
      noteTickError(error)
    } catch {
      // ignore
    }
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
      chain: chain.key,
      treasury: activeChain.treasuryReport(),
      status: proc?.status ?? "ok",
      reason: proc?.reason ?? null,
      process: proc,
      previous: proc?.previous ?? null,
      stream: stream.metrics(),
      selfHealth: self,
      queryStats: (() => {
        try {
          return averageQueryStats(getDb(), Date.now() - 60 * 60 * 1000)
        } catch {
          return {}
        }
      })(),
      routePctl: (() => {
        try {
          return routePercentiles(getDb(), Date.now() - 60 * 60 * 1000)
        } catch {
          return {}
        }
      })(),
      queryPctl: (() => {
        try {
          return queryPercentiles(getDb(), Date.now() - 60 * 60 * 1000)
        } catch {
          return {}
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

  if (req.method === "GET" && url.pathname === "/api/health/history") {
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

  if (req.method === "GET" && url.pathname === "/api/status") {
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
      process: proc,
      previous: proc?.previous ?? null,
      selfHealth: self,
      hangs,
    })
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

  if (req.method === "GET" && url.pathname === "/api/tape") {
    const now = Date.now()
    const to = Math.min(now, Number(url.searchParams.get("to") ?? now))
    const requestedFrom = Number(url.searchParams.get("from") ?? to - 30_000)
    if (!Number.isFinite(to) || !Number.isFinite(requestedFrom) || to < 0 || requestedFrom < 0 || requestedFrom > to) {
      return json({ error: "Tape range is invalid" }, 400)
    }
    const from = Math.max(requestedFrom, to - 15 * 60 * 1000)
    return json({ tape: timedQuery("tape", () => tapeRange(from, to)) })
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const now = Date.now()
    const session = readSession(req, now)
    if (session.rejected) return json({ error: "Sign in again" }, 401)
    const tailMs = Math.max(30_000, windowMs() * 2, viewMs() * 2)
    return json({
      serverNow: now,
      feed: feedStatus(now),
      config: publicConfig(),
      ticker: tickerNow(),
      handoff: handoffNow(),
      board: timedQuery("board", () => board(now)),
      you: session.address ? timedQuery("you", () => youFor(session.address!)) : null,
      tape: timedQuery("tape", () => tapeRange(now - tailMs, now)),
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
    const requestId = typeof body?.requestId === "string" ? body.requestId : undefined
    const result = timedQuery("buy_in", () => placeBuyIn({ address: session.address, side, stakeMicros: stake, roundId, requestId, now }))
    if (!result.ok) return json(result.code ? { error: result.error, code: result.code } : { error: result.error }, 400)
    markRoundDirty()
    return json({ you: result.you })
  }

  if (req.method === "GET" && url.pathname === "/api/rounds") {
    const limit = Number(url.searchParams.get("limit") ?? 10)
    const mine = url.searchParams.get("mine") === "1"
    const session = mine ? readSession(req) : { address: null, rejected: false }
    if (mine && !session.address) return json({ error: "Connect a wallet first" }, 401)
    return json({ rounds: timedQuery("rounds", () => listRounds(Number.isFinite(limit) ? limit : 10, session.address, mine)) })
  }

  const detailMatch = url.pathname.match(/^\/api\/rounds\/(\d+)$/)
  if (req.method === "GET" && detailMatch) {
    const detail = timedQuery("round_detail", () => roundDetail(Number(detailMatch[1])))
    if (!detail) return json({ error: "Round not found" }, 404)
    return json(detail)
  }

  if (serveUi && req.method === "GET") {
    const file = await staticFile(url)
    if (file) return file
  }

  return json({ error: "Not found" }, 404)
}

function routeTemplate(method: string, pathname: string): string {
  if (/^\/api\/rounds\/\d+$/.test(pathname)) return `${method} /api/rounds/:id`
  if (pathname.startsWith("/api/agents/")) return `${method} /api/agents/*`
  if (pathname === "/ws") return "WS /ws"
  return `${method} ${pathname}`
}

async function handleSafe(req: Request): Promise<Response> {
  const started = performance.now()
  let route = "unknown"
  try {
    const url = new URL(req.url)
    route = routeTemplate(req.method, url.pathname)
    return await handle(req)
  } catch (error) {
    try {
      const url = new URL(req.url)
      noteRequestError(error, url.pathname)
    } catch {
      // ignore
    }
    throw error
  } finally {
    try {
      noteRequest(route, performance.now() - started)
    } catch {
      // ignore
    }
  }
}

// --- self-health sampler: host + self + query stats into the ledger DB ------

let wsPeers = 0

function selfHealthPaths(): { dataDir: string; dbPath: string } {
  const resolved = (() => {
    try {
      return loadEnv().dbPath
    } catch {
      return process.env.DB_PATH?.trim() || "data/quick-market.sqlite"
    }
  })()
  const dataDir = resolved === ":memory:" ? join(process.cwd(), "data") : dirname(resolved)
  return { dataDir, dbPath: resolved }
}

function noteDiskPressure(level: "warn" | "down", fraction: number, free: number): void {
  try {
    const pct = (fraction * 100).toFixed(1)
    const freeMb = Math.round(free / 1024 / 1024)
    if (level === "down") {
      const snap = snapshotProcessHealth()
      if (snap.status !== "down" || !snap.reason?.includes("disk")) {
        setProcessStatus("down", `disk critically full (${pct}% used, ${freeMb}MB free) — archive or free space`)
      }
      return
    }
    const snap = snapshotProcessHealth()
    if (snap.status === "ok") {
      setProcessStatus("degraded", `disk filling (${pct}% used, ${freeMb}MB free)`)
    }
  } catch {
    // ignore
  }
}

const selfHealthRuntime = globalThis as unknown as {
  qmSelfHealthTimer?: ReturnType<typeof setInterval>
}
if (selfHealthRuntime.qmSelfHealthTimer) clearInterval(selfHealthRuntime.qmSelfHealthTimer)
if (process.env.QM_HEALTH_LOG !== "0") {
  let lastMinute = 0
  let lastArchive = 0
  selfHealthRuntime.qmSelfHealthTimer = setInterval(() => {
    try {
      const now = Date.now()
      const { dataDir, dbPath } = selfHealthPaths()
      const db = getDb()
      flushHealthSample({
        db,
        dataDir,
        dbPath,
        now,
        peers: wsPeers,
        feed: (() => {
          try {
            return feedStatus(now)
          } catch {
            return undefined
          }
        })(),
        streamBoard: (() => {
          try {
            return stream.metrics().boardBuilds
          } catch {
            return null
          }
        })(),
        onDiskPressure: noteDiskPressure,
      })
      if (now - lastMinute >= 60_000) {
        lastMinute = now
        try {
          rollupHealthMinute(db, now)
        } catch {
          // ignore
        }
      }
      if (now - lastArchive >= 60 * 60 * 1000) {
        lastArchive = now
        try {
          archiveOldHealth(db, dataDir, now)
        } catch {
          // ignore
        }
        try {
          archiveOldTicks(db, dataDir, now)
        } catch {
          // ignore
        }
        try {
          void archivesSizeBytes(dataDir)
        } catch {
          // ignore
        }
      }
    } catch {
      // sampler must never break the market
    }
  }, HEALTH_SAMPLE_MS)
  ;(selfHealthRuntime.qmSelfHealthTimer as unknown as { unref?: () => void }).unref?.()
  try {
    startLagWatchdog()
  } catch {
    // stall probe is best effort
  }
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

Bun.serve<{ address: string | null }>({
  port,
  hostname: host,
  // Default is 10s. A mint submit plus three blocks can run longer, and cutting
  // the request there reported a failure while the credit still landed.
  idleTimeout: 90,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { address: null } })) return undefined as unknown as Response
      return new Response("Expected websocket", { status: 400 })
    }
    return handleSafe(req).catch((error) => {
      console.error(error)
      return json({ error: "Server error" }, 500)
    })
  },
  websocket: {
    // Ping about 32s into a 48s idle so a quiet socket stays inside Cloudflare's 100s proxy cut.
    // The browser answers without page timers. A frozen tab cannot, and the socket closes.
    idleTimeout: 48,
    sendPings: true,
    perMessageDeflate: true,
    open(ws) {
      wsPeers += 1
      hub.add(ws)
      stream.snapshot(ws)
    },
    message(ws, raw) {
      const size = typeof raw === "string" ? raw.length : raw.byteLength
      if (size > 2_048) return
      const text = typeof raw === "string" ? raw : raw.toString()
      const recv = Date.now()
      const reply = lagEcho(text, recv, Date.now())
      if (reply) {
        ws.send(reply)
        return
      }
      let body: Record<string, unknown>
      try {
        const parsed = JSON.parse(text) as unknown
        if (!parsed || typeof parsed !== "object") return
        body = parsed as Record<string, unknown>
      } catch {
        return
      }
      if (body.type === "hello") {
        const session = readSessionToken(body.token)
        ws.data.address = session.address
        stream.account(ws, session.rejected)
        return
      }
      if (body.type === "resync") {
        stream.snapshot(ws)
        return
      }
      if (body.type !== "buy-in") return
      const requestId = typeof body.requestId === "string" ? body.requestId : ""
      const replyTo = (result: { ok: boolean; you?: ReturnType<typeof youFor>; error?: string; code?: string }) => {
        hub.send(ws, { type: "buy-in-result", requestId, ...result })
      }
      if (!ws.data.address) {
        replyTo({ ok: false, error: "Connect a wallet first" })
        return
      }
      const side = body.side === "up" || body.side === "down" ? body.side : null
      const stake = parseMicros(body.stake)
      if (!side || stake === null || typeof body.roundId !== "number") {
        replyTo({ ok: false, error: !side ? "Side is invalid" : stake === null ? "Stake is invalid" : "Market is invalid" })
        return
      }
      const result = timedQuery("buy_in", () =>
        placeBuyIn({ address: ws.data.address!, side, stakeMicros: stake, roundId: body.roundId as number, requestId, now: recv }),
      )
      replyTo(result)
      if (result.ok) markRoundDirty()
    },
    close(ws) {
      wsPeers = Math.max(0, wsPeers - 1)
      hub.remove(ws)
    },
  },
})

console.log(`quick market api http://127.0.0.1:${port}`)
