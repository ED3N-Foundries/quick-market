import { recoverMessageAddress, type Hex } from "viem"
import { botEnrollMessage, nearBotEnrollMessage, LOGIN_SKEW_MS } from "../shared/login"
import { isImplicitAccount } from "../shared/near"
import { verifyNearMessage } from "../shared/nearKey"
import { agentMarketAllowed, parseAgentSplit } from "../shared/split"
import { activeChainKey } from "./activeChain"
import { requestBurn } from "./custody"
import { getDb } from "./db"
import { chainConfig } from "./env"
import { normalizeAccount } from "./money"
import { requestNearBurn } from "./near"
import { credit, openBook, placeBuyIns, recentSettles, settledSince, tapeTail, youFor, type BuyInOrder } from "./rounds"

const SIGNATURE = /^0x[0-9a-fA-F]+$/

/**
 * Bot bank band. Duplicated from the agent repo's `agent/config.ts` (`bank`
 * slice) so the server does not depend on the runner. Keep both in sync:
 * floor $3, seed $8–$250, refill pocket $6–$24 (cap enforced here).
 */
const BOT_BANK = {
  floorMicros: 3_000_000,
  seedMinMicros: 8_000_000,
  seedMaxMicros: 250_000_000,
  refillMaxMicros: 24_000_000,
} as const

export async function enrollBot(input: {
  address: string
  signature: string
  issued: number
  seedMicros: number
  now: number
  mint: (amountMicros: number) => Promise<void>
}): Promise<{ ok: true; balanceMicros: number; seeded: boolean } | { ok: false; error: string }> {
  let chainKey: ReturnType<typeof chainConfig>["key"]
  let chainId: number
  try {
    const chain = chainConfig()
    chainKey = chain.key
    chainId = chain.id
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Chain is invalid" }
  }
  const address = normalizeAccount(input.address, chainKey)
  if (!address) return { ok: false, error: "Address is invalid" }
  const bank = BOT_BANK
  if (!Number.isSafeInteger(input.seedMicros) || input.seedMicros < bank.seedMinMicros || input.seedMicros > bank.seedMaxMicros) {
    return { ok: false, error: "Seed is outside the band" }
  }
  if (!Number.isInteger(input.issued) || Math.abs(input.now - input.issued) > LOGIN_SKEW_MS) {
    return { ok: false, error: "Sign-in expired" }
  }
  if (chainKey === "near-testnet") {
    if (!isImplicitAccount(address)) return { ok: false, error: "Address is invalid" }
    const ok = await verifyNearMessage(nearBotEnrollMessage(address, input.issued, input.seedMicros), address, input.signature)
    if (!ok) return { ok: false, error: "Signature is invalid" }
  } else {
    if (!SIGNATURE.test(input.signature)) return { ok: false, error: "Signature is invalid" }
    const message = botEnrollMessage(chainId, address, input.issued, input.seedMicros)
    let recovered = ""
    try {
      recovered = (await recoverMessageAddress({ message, signature: input.signature as Hex })).toLowerCase()
    } catch {
      return { ok: false, error: "Signature is invalid" }
    }
    if (recovered !== address) return { ok: false, error: "Signature is invalid" }
  }

  const existing = userRow(address)
  if (existing && existing.is_bot !== 1) return { ok: false, error: "That address is a person" }
  if (existing?.is_bot === 1) return { ok: true, balanceMicros: existing.balance_micros, seeded: false }

  await input.mint(input.seedMicros)
  const tx = getDb().transaction(() => {
    const again = userRow(address)
    if (again && again.is_bot !== 1) throw new Error("That address is a person")
    if (again?.is_bot === 1) return { balanceMicros: again.balance_micros, seeded: false }
    getDb()
      .query("INSERT INTO users (chain_key, address, balance_micros, created_at, is_bot) VALUES (?, ?, ?, ?, 1)")
      .run(activeChainKey(), address, input.seedMicros, input.now)
    return { balanceMicros: input.seedMicros, seeded: true }
  })
  try {
    const row = tx()
    return { ok: true, ...row }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Enroll failed"
    return { ok: false, error: messageText }
  }
}

export async function resurrectBot(input: {
  address: string
  amountMicros: number
  mint: (amountMicros: number) => Promise<void>
}): Promise<{ ok: true; balanceMicros: number } | { ok: false; error: string }> {
  const address = normalizeAccount(input.address)
  if (!address) return { ok: false, error: "Address is invalid" }
  const bank = BOT_BANK
  if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0 || input.amountMicros > bank.refillMaxMicros) {
    return { ok: false, error: "Amount is outside the refill" }
  }
  const row = userRow(address)
  if (!row || row.is_bot !== 1) return { ok: false, error: "Not a bot" }
  if (row.balance_micros >= bank.floorMicros) return { ok: false, error: "Balance is inside the band" }
  await input.mint(input.amountMicros)
  const added = credit(address, input.amountMicros)
  if (!added.ok) return added
  return { ok: true, balanceMicros: added.you.balanceMicros }
}

export function agentBalances(addresses: string[]): { address: string; balanceMicros: number }[] {
  const clean = [...new Set(addresses.flatMap((item) => {
    const address = normalizeAccount(item)
    return address ? [address] : []
  }))].slice(0, 200)
  if (clean.length === 0) return []
  const marks = clean.map(() => "?").join(",")
  const rows = getDb()
    .query(`SELECT address, balance_micros FROM users WHERE chain_key = ? AND address IN (${marks}) AND is_bot = 1`)
    .all(activeChainKey(), ...clean) as { address: string; balance_micros: number }[]
  return rows.map((row) => ({ address: row.address, balanceMicros: row.balance_micros }))
}

function userRow(address: string): { balance_micros: number; is_bot: number } | null {
  return (
    (getDb().query("SELECT balance_micros, is_bot FROM users WHERE chain_key = ? AND address = ?").get(activeChainKey(), address) as
      | { balance_micros: number; is_bot: number }
      | null) ?? null
  )
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function handleAgents(
  req: Request,
  url: URL,
  deps: { mint: (amountMicros: number) => Promise<void>; publish: () => void },
): Promise<Response> {
  let split
  try {
    split = parseAgentSplit(process.env.AGENT_SPLIT_BASE, process.env.AGENT_SPLIT_NEAR)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Split is invalid" }, 500)
  }
  if (!agentMarketAllowed(activeChainKey(), split)) return json({ error: "Agents are not running on NEAR." }, 403)

  if (req.method === "GET" && url.pathname === "/api/agents/book") {
    const since = Number(url.searchParams.get("since") ?? 0)
    const tail = Number(url.searchParams.get("tail") ?? 90_000)
    const now = Date.now()
    const book = openBook(now)
    return json({
      ...book,
      tape: tapeTail(now, Number.isFinite(tail) ? Math.min(Math.max(tail, 1_000), 120_000) : 90_000),
      settled: settledSince(Number.isFinite(since) ? since : 0),
      recent: recentSettles(),
    })
  }

  if (req.method === "GET" && url.pathname === "/api/agents/balances") {
    const addresses = (url.searchParams.get("addresses") ?? "").split(",").filter(Boolean)
    return json({ balances: agentBalances(addresses) })
  }

  if (req.method === "POST" && url.pathname === "/api/agents/enroll") {
    const body = await readJson(req)
    const issued = body?.issued
    const seedMicros = body?.seedMicros
    if (typeof issued !== "number" || typeof seedMicros !== "number") return json({ error: "Enroll is invalid" }, 400)
    const result = await enrollBot({
      address: String(body?.address ?? ""),
      signature: String(body?.signature ?? ""),
      issued,
      seedMicros,
      now: Date.now(),
      mint: deps.mint,
    })
    if (!result.ok) return json({ error: result.error }, 400)
    return json(result)
  }

  if (req.method === "POST" && url.pathname === "/api/agents/buy-ins") {
    const now = Date.now()
    const body = await readJson(req)
    const orders = Array.isArray(body?.orders) ? (body.orders as BuyInOrder[]) : null
    const roundId = body?.roundId
    if (!orders) return json({ error: "Orders are invalid" }, 400)
    if (typeof roundId !== "number") return json({ error: "Market is invalid" }, 400)
    const result = placeBuyIns({ orders, roundId, now })
    if (!result.ok) return json(result.code ? { error: result.error, code: result.code } : { error: result.error }, 400)
    if (result.accepted > 0) deps.publish()
    return json({ results: result.results, accepted: result.accepted })
  }

  if (req.method === "POST" && url.pathname === "/api/agents/burn") {
    const body = await readJson(req)
    const amount = body?.amountMicros
    if (typeof amount !== "number") return json({ error: "Amount is invalid" }, 400)
    const who = normalizeAccount(String(body?.address ?? "")) ?? ""
    const result = activeChainKey() === "near-testnet" ? await requestNearBurn(who, amount) : await requestBurn(who, amount)
    if (!result.ok) return json({ error: result.error, you: youFor(who) }, 400)
    return json({ txHash: result.txHash, you: youFor(who) })
  }

  if (req.method === "POST" && url.pathname === "/api/agents/resurrect") {
    const body = await readJson(req)
    const amount = body?.amountMicros
    if (typeof amount !== "number") return json({ error: "Amount is invalid" }, 400)
    const result = await resurrectBot({
      address: String(body?.address ?? ""),
      amountMicros: amount,
      mint: deps.mint,
    })
    if (!result.ok) return json({ error: result.error }, 400)
    return json(result)
  }

  return json({ error: "Not found" }, 404)
}
