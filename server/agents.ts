import { recoverMessageAddress, type Hex } from "viem"
import { swarmConfig } from "../agent/config"
import { botEnrollMessage, LOGIN_SKEW_MS } from "../shared/login"
import { requestBurn } from "./custody"
import { getDb } from "./db"
import { configuredChain } from "./env"
import { normalizeAddress } from "./money"
import { credit, openBook, placeBets, settledSince, tapeTail, youFor, type BetOrder } from "./rounds"

const SIGNATURE = /^0x[0-9a-fA-F]+$/

export async function enrollBot(input: {
  address: string
  signature: string
  issued: number
  seedMicros: number
  now: number
  mint: (amountMicros: number) => Promise<void>
}): Promise<{ ok: true; balanceMicros: number; seeded: boolean } | { ok: false; error: string }> {
  const address = normalizeAddress(input.address)
  if (!address) return { ok: false, error: "Address is invalid" }
  const bank = swarmConfig.bank
  if (!Number.isSafeInteger(input.seedMicros) || input.seedMicros < bank.seedMinMicros || input.seedMicros > bank.seedMaxMicros) {
    return { ok: false, error: "Seed is outside the band" }
  }
  if (!Number.isInteger(input.issued) || Math.abs(input.now - input.issued) > LOGIN_SKEW_MS) {
    return { ok: false, error: "Sign-in expired" }
  }
  if (!SIGNATURE.test(input.signature)) return { ok: false, error: "Signature is invalid" }

  let chainId: number
  try {
    chainId = configuredChain().id
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Chain is invalid" }
  }
  const message = botEnrollMessage(chainId, address, input.issued, input.seedMicros)
  let recovered = ""
  try {
    recovered = (await recoverMessageAddress({ message, signature: input.signature as Hex })).toLowerCase()
  } catch {
    return { ok: false, error: "Signature is invalid" }
  }
  if (recovered !== address) return { ok: false, error: "Signature is invalid" }

  const existing = userRow(address)
  if (existing && existing.is_bot !== 1) return { ok: false, error: "That address is a person" }
  if (existing?.is_bot === 1) return { ok: true, balanceMicros: existing.balance_micros, seeded: false }

  await input.mint(input.seedMicros)
  const tx = getDb().transaction(() => {
    const again = userRow(address)
    if (again && again.is_bot !== 1) throw new Error("That address is a person")
    if (again?.is_bot === 1) return { balanceMicros: again.balance_micros, seeded: false }
    getDb()
      .query("INSERT INTO users (address, balance_micros, created_at, is_bot) VALUES (?, ?, ?, 1)")
      .run(address, input.seedMicros, input.now)
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
  const address = normalizeAddress(input.address)
  if (!address) return { ok: false, error: "Address is invalid" }
  const bank = swarmConfig.bank
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
    const address = normalizeAddress(item)
    return address ? [address] : []
  }))].slice(0, 200)
  if (clean.length === 0) return []
  const marks = clean.map(() => "?").join(",")
  const rows = getDb()
    .query(`SELECT address, balance_micros FROM users WHERE address IN (${marks}) AND is_bot = 1`)
    .all(...clean) as { address: string; balance_micros: number }[]
  return rows.map((row) => ({ address: row.address, balanceMicros: row.balance_micros }))
}

function userRow(address: string): { balance_micros: number; is_bot: number } | null {
  return (
    (getDb().query("SELECT balance_micros, is_bot FROM users WHERE address = ?").get(address) as
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
  if (req.method === "GET" && url.pathname === "/api/agents/book") {
    const since = Number(url.searchParams.get("since") ?? 0)
    const tail = Number(url.searchParams.get("tail") ?? 90_000)
    const now = Date.now()
    const book = openBook(now)
    return json({
      ...book,
      tape: tapeTail(now, Number.isFinite(tail) ? Math.min(Math.max(tail, 1_000), 120_000) : 90_000),
      settled: settledSince(Number.isFinite(since) ? since : 0),
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

  if (req.method === "POST" && url.pathname === "/api/agents/bets") {
    const now = Date.now()
    const body = await readJson(req)
    const orders = Array.isArray(body?.orders) ? (body.orders as BetOrder[]) : null
    const roundId = body?.roundId
    if (!orders) return json({ error: "Orders are invalid" }, 400)
    if (typeof roundId !== "number") return json({ error: "Market is invalid" }, 400)
    const result = placeBets({ orders, roundId, now })
    if (!result.ok) return json(result.code ? { error: result.error, code: result.code } : { error: result.error }, 400)
    if (result.accepted > 0) deps.publish()
    return json({ results: result.results, accepted: result.accepted })
  }

  if (req.method === "POST" && url.pathname === "/api/agents/burn") {
    const body = await readJson(req)
    const amount = body?.amountMicros
    if (typeof amount !== "number") return json({ error: "Amount is invalid" }, 400)
    const result = await requestBurn(String(body?.address ?? ""), amount)
    if (!result.ok) return json({ error: result.error, you: youFor(normalizeAddress(body?.address) ?? "") }, 400)
    return json({ txHash: result.txHash, you: youFor(normalizeAddress(String(body?.address ?? "")) ?? "") })
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
