import { dirname, join } from "node:path"
import type { ChainKey } from "../shared/chain"
import { loadMarket, marketPreferences, requireExplicitChain, TICK_MS, type PublicConfig } from "../shared/market"
import { feeBps, marketMs, MIN_STAKE_MICROS, priceSource, viewMs, windowMs, type PriceSource } from "./config"
import { nextMarketAt, planWake, rollMarketAt, runWake, type MarketTiming } from "./clock"
import { takeTick } from "./tick"
import { enabledMarketKeys, loadEnv } from "./env"
import { pumpAccountKeyframe, pushAccountNow } from "./accountKeyframe"
import { activeChainKey, withChain } from "./activeChain"
import { startChainRuntime, type ChainRuntime } from "./chainRuntime"
import { pickChain } from "./markets"
import { readSessionToken, pruneExpiredAuth, sessionChainForToken } from "./session"
import { grantSettings, onGrantNoted } from "./grant"
import { hub, type MarketSocket } from "./hub"
import { bindHttp, handleInternal, handleSafe, json } from "./http"
import { collectFunding } from "./funding"
import { MarketStream } from "./stream"
import { orderLatency } from "./orderLatency"
import { noteClientOrderReport, rememberOrderReport } from "./orderReports"
import { lagEcho } from "./lag"
import { parseMicros } from "./money"
import {
  heartbeatProcessHealth,
  initProcessHealth,
  noteBootFailure,
  noteFeedAdopt,
  noteFeedBreak,
  noteFeedLive,
  noteTickOk,
  setProcessStatus,
  snapshotProcessHealth,
} from "./processHealth"
import { flushHealthSample, HEALTH_SAMPLE_MS, startLagWatchdog } from "./selfHealth"
import { archiveOldHealth, archiveOldRounds, archiveOldTicks, archivesSizeBytes, roundsArchiveRemains, ticksArchiveRemains } from "./archive"
import { getDb } from "./db"
import { startOracle } from "./oracle"
import {
  accountResults,
  adoptFeed,
  advance,
  board,
  failFeed,
  feedStatus,
  handoffNow,
  noteAlive,
  notePrint,
  placeBuyIn,
  tapeRange,
  tickerNow,
  youFor,
} from "./rounds"
import { nearCooldownStatus } from "./near"
import { sweepMcpSessions } from "./mcp"


const runtimes = new Map<ChainKey, ChainRuntime>()

function liveKeys(): ChainKey[] {
  return [...runtimes.keys()]
}

function runtimeFor(key: ChainKey = activeChainKey()): ChainRuntime {
  const found = runtimes.get(key)
  if (!found) throw new Error(`Market ${key} is off`)
  return found
}

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
  const wanted = enabledMarketKeys()
  if (wanted.length === 0) {
    throw new Error("Fill Base keys (TREASURY_PRIVATE_KEY and USDC_ADDRESS) or NEAR keys (NEAR_TREASURY_PRIVATE_KEY and TOKEN_ACCOUNT).")
  }
  for (const key of wanted) {
    try {
      runtimes.set(key, await startChainRuntime(key))
    } catch (error) {
      if (key !== "near-testnet" || runtimes.size === 0) throw error
      console.error(error instanceof Error ? error.message : error)
    }
  }
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
  return runtimeFor().grantsOpen
}

function mintTreasury(amount: number, report?: (progress: { txHash?: string; seen: number }) => void): Promise<void> {
  return runtimeFor().mint(amount, report)
}

let pending: { price: string; exchangeTs: number; source: PriceSource } | null = null
let lastTickAt = 0
let lastFeed: "live" | "stale" | null = null
let marketAt = 0
let awaitingStrike = false
let strikeKick = false

onGrantNoted((address, chainKey) => {
  pushAccountNow(chainKey, address)
})

const stream = new MarketStream({
  board: () => board(),
  tape: () => {
    const now = Date.now()
    const tailMs = Math.max(30_000, windowMs() * 2, viewMs() * 2)
    return tapeRange(now - tailMs, now)
  },
  feed: () => feedStatus(Date.now()),
  ticker: tickerNow,
  handoff: handoffNow,
  youFor: (address) => youFor(address),
  accountResults: (address) => accountResults(address),
  nearFunding: () => {
    try {
      if (activeChainKey() !== "near-testnet") return { cooling: false, retryAfterMs: 0, untilMs: null, reason: null }
      return nearCooldownStatus()
    } catch {
      return { cooling: false, retryAfterMs: 0, untilMs: null, reason: null }
    }
  },
})

const runtime = globalThis as unknown as {
  quickMarketTimer?: ReturnType<typeof setTimeout>
  quickMarketStopOracle?: () => void
}
runtime.quickMarketStopOracle?.()
runtime.quickMarketStopOracle = startOracle({
  onPrint(print) {
    notePrint(print)
    pending = { price: print.price, exchangeTs: print.exchangeTs, source: print.source }
    if (awaitingStrike) strikeKick = true
    arm()
  },
  onAlive(at) {
    noteAlive(at)
  },
  onBreak(event) {
    try {
      noteFeedBreak(event.from, event.to, event.to ? "switched" : "waiting for a fresh venue")
    } catch {
      // ignore
    }
    for (const key of liveKeys()) {
      withChain(key, () => {
        const settled = failFeed(event.from, event.to, event.at)
        for (const item of settled) stream.settled(item, event.at)
        publishRound(event.at)
      })
    }
    arm(event.at)
  },
  onAdopt(event) {
    try {
      noteFeedAdopt(event.to)
    } catch {
      // ignore
    }
    for (const key of liveKeys()) {
      withChain(key, () => {
        adoptFeed(event.to, event.at)
        publishRound(event.at)
      })
    }
    arm(event.at)
  },
})

function timing(): MarketTiming {
  return { windowMs: windowMs(), marketMs: marketMs(), handoffResumeAt: handoffNow()?.resumeAt ?? null }
}

function markRoundDirty() {
  publishRound()
}

function rememberAcceptedOrder(ws: MarketSocket, requestId: string, now: number): void {
  if (!requestId) return
  const reports = ws.data.orderReports ?? new Map<string, { at: number; ack: boolean }>()
  ws.data.orderReports = reports
  rememberOrderReport(reports, requestId, now)
}

function publishRound(now = Date.now()) {
  const feed = feedStatus(now)
  lastFeed = feed
  stream.book(now, feed)
}

function arm(now = Date.now()) {
  if (runtime.quickMarketTimer) clearTimeout(runtime.quickMarketTimer)
  const next = nextMarketAt(now, timing())
  const due = marketAt > 0 && now >= marketAt
  marketAt = rollMarketAt(now, marketAt, next)
  if (strikeKick || due) {
    runtime.quickMarketTimer = setTimeout(wake, 0)
    runtime.quickMarketTimer.unref?.()
    return
  }
  let at = marketAt
  if (pending) {
    const tickAt = lastTickAt > 0 ? lastTickAt + TICK_MS : now
    if (tickAt < at) at = Math.max(now, tickAt)
  }
  const delay = Math.max(0, at - Date.now())
  runtime.quickMarketTimer = setTimeout(wake, delay)
  runtime.quickMarketTimer.unref?.()
}

function wake() {
  const now = Date.now()
  const kick = strikeKick
  strikeKick = false
  let failed = false
  try {
    const plan = planWake({
      now,
      marketAt,
      lastTickAt,
      tickMs: TICK_MS,
      hasPending: pending != null,
      strikeKick: kick,
    })
    runWake(plan, {
      advance: () => {
        let awaiting = false
        const feedState: { value: "live" | "stale" } = { value: "stale" }
        for (const key of liveKeys()) {
          withChain(key, () => {
            const result = advance(now)
            if (result.awaitingPrice) awaiting = true
            const feed = feedStatus(now)
            feedState.value = feed
            for (const event of result.settled) stream.settled(event, now)
            if (result.broadcastRound || feed !== lastFeed) publishRound(now)
          })
        }
        // A live feed and a completed advance clear feed/tick failure markers.
        if (feedState.value === "live") noteFeedLive()
        noteTickOk(feedState.value)
        awaitingStrike = awaiting
        marketAt = nextMarketAt(now, timing())
        return { awaitingPrice: awaiting }
      },
      fanout: () => {
        if (!pending) return
        const due = takeTick(pending, lastTickAt, now, TICK_MS)
        if (!due.send) return
        pending = null
        lastTickAt = due.lastSentAt
        const price = due.send.price
        const exchangeTs = due.send.exchangeTs
        for (const key of liveKeys()) {
          withChain(key, () => {
            stream.tick(price, exchangeTs, now, feedStatus(now))
          })
        }
      },
    })
  } catch (error) {
    failed = true
    console.error(error)
  } finally {
    try {
      for (const key of liveKeys()) pumpAccountKeyframe(key, now)
    } catch (error) {
      console.error(error)
    }
    if (failed) marketAt = Date.now() + 250
    arm()
  }
}

if (runtime.quickMarketTimer) clearTimeout(runtime.quickMarketTimer)
wake()

function publicConfig(): PublicConfig {
  const current = runtimeFor()
  const grant = current.grantsOpen ? grantSettings() : { amount: 0, intervalMs: 0 }
  return {
    windowSeconds: windowMs() / 1000,
    marketSeconds: marketMs() / 1000,
    viewSeconds: viewMs() / 1000,
    feeBps: feeBps(),
    minStakeMicros: MIN_STAKE_MICROS,
    source: priceSource(),
    chainId: current.chain.id,
    chainKey: current.chain.key,
    chainName: current.chain.name,
    usdc: current.token,
    treasury: current.treasury,
    moneyLabel: current.moneyLabel,
    tokenKind: current.tokenKind,
    tokenLabel: current.tokenLabel,
    grantMicros: grant.amount,
    grantIntervalMs: grant.intervalMs,
    confirmations: marketPreferences.confirmations,
  }
}

function marketsPayload() {
  const live = liveKeys()
  const defaultChainKey: ChainKey = live.includes("near-testnet") ? "near-testnet" : live[0]!
  return {
    defaultChainKey,
    markets: live.map((key) => withChain(key, () => publicConfig())),
  }
}

bindHttp({
  config: publicConfig,
  markets: marketsPayload,
  liveChains: liveKeys,
  chainKey: () => activeChainKey(),
  treasuryReport: () => runtimeFor().treasuryReport(),
  fundingReport: () => collectFunding({
    chains: liveKeys().map((key) => {
      const current = runtimeFor(key)
      return {
        chain: current.chain,
        treasury: current.treasury,
        token: current.token,
        tokenLabel: current.tokenLabel,
        near: current.treasuryReport(),
        cooling: key === "near-testnet" ? nearCooldownStatus() : null,
      }
    }),
    db: getDb(),
  }),
  grantsOpen,
  mint: mintTreasury,
  withdraw: (address, amount) => runtimeFor().withdraw(address, amount),
  publish: markRoundDirty,
  streamMetrics: () => stream.metrics(),
  serveUi,
  distDir,
})

// --- slow disk check, hang rows, and process heartbeat. No histogram writes. ---

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

// Expired sessions and sign-in signatures are pruned on boot and then from the
// health interval every 10 minutes. A request never prunes: the DELETEs stay
// off the hot path.
let lastAuthPruneAt = 0
try {
  lastAuthPruneAt = Date.now()
  pruneExpiredAuth(lastAuthPruneAt)
} catch {
  // boot prune is best effort
}

if (process.env.QM_HEALTH_LOG !== "0") {
  let lastArchive = 0
  let archivePump: ReturnType<typeof setTimeout> | null = null
  const pumpArchive = () => {
    archivePump = null
    try {
      const { dataDir: dir } = selfHealthPaths()
      const db = getDb()
      const at = Date.now()
      try {
        archiveOldHealth(db, dir, at)
      } catch {
        // ignore
      }
      try {
        archiveOldTicks(db, dir, at)
      } catch {
        // ignore
      }
      try {
        archiveOldRounds(db, dir, at)
      } catch {
        // ignore
      }
      if (!ticksArchiveRemains(db, at) && !roundsArchiveRemains(db, at)) return
      archivePump = setTimeout(pumpArchive, 250)
      ;(archivePump as unknown as { unref?: () => void }).unref?.()
    } catch {
      // ignore
    }
  }
  selfHealthRuntime.qmSelfHealthTimer = setInterval(() => {
    try {
      const now = Date.now()
      try {
        heartbeatProcessHealth()
      } catch {
        // ignore
      }
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
      if (now - lastAuthPruneAt >= 10 * 60 * 1000) {
        lastAuthPruneAt = now
        try {
          pruneExpiredAuth(now)
        } catch {
          // ignore
        }
      }
      if (now - lastArchive >= 60 * 60 * 1000) {
        lastArchive = now
        if (!archivePump) {
          archivePump = setTimeout(pumpArchive, 0)
          ;(archivePump as unknown as { unref?: () => void }).unref?.()
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

// --- MCP session sweep: the TTL backstop for dropped agent connections. ---

const mcpSweepRuntime = globalThis as unknown as { quickMarketMcpSweepTimer?: ReturnType<typeof setInterval> }
if (mcpSweepRuntime.quickMarketMcpSweepTimer) clearInterval(mcpSweepRuntime.quickMarketMcpSweepTimer)
mcpSweepRuntime.quickMarketMcpSweepTimer = setInterval(() => {
  try {
    sweepMcpSessions()
  } catch {
    // the sweep must never break the market
  }
}, 60_000)
;(mcpSweepRuntime.quickMarketMcpSweepTimer as unknown as { unref?: () => void }).unref?.()

const host = process.env.HOST?.trim() || "127.0.0.1"

try {
  Bun.serve({
    port: Number(process.env.INTERNAL_PORT || 3002),
    hostname: "0.0.0.0",
    idleTimeout: 30,
    fetch(req) {
      return handleInternal(req).catch((error) => {
        console.error(error)
        return json({ error: "Server error" }, 500)
      })
    },
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
}

Bun.serve<{ address: string | null; chain: ChainKey }>({
  port,
  hostname: host,
  // Default is 10s. A mint submit plus three blocks can run longer, and cutting
  // the request there reported a failure while the credit still landed.
  idleTimeout: 90,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === "/ws") {
      const picked = pickChain({
        raw: url.searchParams.get("chain"),
        sessionChain: null,
        live: liveKeys(),
      })
      if (!picked.ok) return json({ error: picked.error }, picked.status)
      if (server.upgrade(req, { data: { address: null, chain: picked.chain } })) return undefined as unknown as Response
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
    // One shared deflate context for every peer. Client frames are ≤2 KB, so
    // the server never needs to decompress anything.
    perMessageDeflate: { compress: "shared", decompress: false },
    open(ws) {
      wsPeers += 1
      hub.add(ws)
      stream.snapshot(ws)
    },
    message(ws, raw) {
      withChain(ws.data.chain, () => {
      const size = typeof raw === "string" ? raw.length : raw.byteLength
      if (size > 2_048) return
      const text = typeof raw === "string" ? raw : raw.toString()
      const recv = Date.now()
      const received = performance.now()
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
      if (body.type === "account") {
        stream.account(ws, false)
        return
      }
      if (body.type === "hello") {
        const offered = typeof body.token === "string" ? sessionChainForToken(body.token) : null
        if (offered && offered !== ws.data.chain) {
          ws.data.address = null
          stream.account(ws, true)
          return
        }
        const session = readSessionToken(body.token)
        ws.data.address = session.address
        stream.account(ws, session.rejected)
        return
      }
      if (body.type === "resync") {
        stream.snapshot(ws)
        return
      }
      if (body.type === "order-latency") {
        noteClientOrderReport(ws.data.orderReports, body, recv)
        return
      }
      if (body.type !== "buy-in") return
      const requestId = typeof body.requestId === "string" ? body.requestId : ""
      const replyTo = (result: { ok: boolean; you?: ReturnType<typeof youFor>; error?: string; code?: string }) => {
        if (!result.ok) orderLatency.reject("user", recv)
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
      const result = placeBuyIn({
        address: ws.data.address!,
        side,
        stakeMicros: stake,
        roundId: body.roundId as number,
        requestId,
        now: recv,
      })
      const accepted = performance.now()
      if (result.ok) {
        orderLatency.note("user", "serverAcceptMs", accepted - received, recv)
        rememberAcceptedOrder(ws, requestId, recv)
      }
      replyTo(result)
      if (result.ok) {
        markRoundDirty()
        orderLatency.note("user", "serverBookMs", performance.now() - accepted, recv)
      }
      })
    },
    close(ws) {
      wsPeers = Math.max(0, wsPeers - 1)
      hub.remove(ws)
    },
  },
})

console.log(`quick market api http://127.0.0.1:${port}`)
