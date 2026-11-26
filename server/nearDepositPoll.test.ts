import { expect, test } from "bun:test"
import { marketPreferences } from "../shared/market"
import {
  nearDepositIndexAtOrBefore,
  nearDepositIndexKey,
  nearDepositIndexUrl,
  nearDepositPollMs,
  nearDepositScanActive,
  nearDepositScanAfterMs,
  parseNearDepositIndexEvent,
  pollNearDepositIndex,
  resetNearDepositPollForTest,
} from "./nearDepositPoll"
import { nearDepositLag, resetNearRpcQuiet, startNearCustody, type NearCustodyLoop } from "./near"
import { getDb, useDatabase } from "./db"
import { youFor } from "./rounds"

const treasury = "aa".repeat(32)
const token = "bb".repeat(32)
const sender = "cc".repeat(32)
const other = "ee".repeat(32)

function log(event: string, data: Record<string, unknown>): string {
  return `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event, data: [data] })}`
}

function outcome(executor: string, logs: string[], failed = false) {
  return { outcome: { executor_id: executor, logs, status: failed ? { Failure: {} } : { SuccessValue: "" } } }
}

/** A tx_status payload carrying one successful QM transfer into the treasury. */
function transferReceipt(hash: string, from: string, amount: string, failed = false): unknown {
  return {
    transaction: { hash },
    receipts_outcome: [outcome(token, [log("ft_transfer", { old_owner_id: from, new_owner_id: treasury, amount })], failed)],
  }
}

/** A v3 ft-txns row. Defaults describe a player deposit into the treasury. */
function ftEvent(fields: {
  block: number
  cause?: string
  delta?: string
  contract?: string
  affected?: string
  involved?: string | null
  tx?: string
  receipt?: string
  eventIndex?: number
}): Record<string, unknown> {
  return {
    affected_account_id: fields.affected ?? treasury,
    block: { block_hash: `Bh${fields.block}`, block_height: String(fields.block), block_timestamp: String(fields.block * 1e9) },
    block_timestamp: String(fields.block * 1e9 + 1000),
    cause: fields.cause ?? "TRANSFER",
    contract_account_id: fields.contract ?? token,
    delta_amount: fields.delta ?? "2500000",
    event_index: fields.eventIndex ?? 0,
    involved_account_id: fields.involved === undefined ? sender : fields.involved,
    receipt_id: fields.receipt ?? `Rc${fields.block}`,
    transaction_hash: fields.tx ?? `Tx${fields.block}`,
    shard_id: 9,
  }
}

type IndexOptions = {
  pages: () => unknown[][]
  status?: () => number
  retryAfter?: string
}

/** A NearBlocks v3 stand-in: newest-first pages behind our own simple cursor. */
function mockIndex(options: IndexOptions) {
  const counter = { fetches: 0 }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.split("/").pop() !== "ft-txns") return new Response("not found", { status: 404 })
      counter.fetches += 1
      const status = options.status?.() ?? 200
      if (status !== 200) {
        const headers = options.retryAfter ? { "retry-after": options.retryAfter } : {}
        return new Response(JSON.stringify({ data: null, errors: [{ message: "unavailable" }] }), { status, headers })
      }
      const pages = options.pages()
      const index = url.searchParams.get("cursor") == null ? 0 : Number(url.searchParams.get("cursor"))
      const page = pages[Math.min(index, pages.length - 1)] ?? []
      return Response.json({ data: page, meta: { next_page: index + 1 < pages.length ? String(index + 1) : null } })
    },
  })
  return { server, counter }
}

type RpcOptions = {
  statuses?: Map<string, unknown>
  failTxStatus?: () => boolean
  head?: () => number
}

/** A minimal NEAR RPC: tx_status from the map, block by id or head. */
function mockRpc(options: RpcOptions = {}) {
  const counter = { txStatus: 0, blocks: 0 }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { method?: string; params?: { tx_hash?: string; block_id?: number } }
      if (body.method === "EXPERIMENTAL_tx_status") {
        counter.txStatus += 1
        if (options.failTxStatus?.()) {
          return new Response(JSON.stringify({ error: { message: "Server error" } }), { status: 500 })
        }
        const payload =
          options.statuses?.get(body.params?.tx_hash ?? "") ?? { transaction: { hash: body.params?.tx_hash }, receipts_outcome: [] }
        return Response.json({ jsonrpc: "2.0", id: "quick-market", result: payload })
      }
      if (body.method === "block") {
        counter.blocks += 1
        const height = body.params?.block_id
        if (height === undefined) {
          return Response.json({
            jsonrpc: "2.0",
            id: "quick-market",
            result: { header: { height: options.head?.() ?? 500 }, chunks: [] },
          })
        }
        return Response.json({
          jsonrpc: "2.0",
          id: "quick-market",
          result: { header: { height, timestamp_nanosec: "1000" }, chunks: [] },
        })
      }
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: {} })
    },
  })
  return { server, counter }
}

function envPatch(values: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key]
    process.env[key] = values[key]
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function seedDb(): void {
  useDatabase(":memory:")
  marketPreferences.chain = "near-testnet"
  resetNearDepositPollForTest()
  resetNearRpcQuiet()
}

test("index env: default url, blank disables, knobs clamp", () => {
  expect(nearDepositIndexUrl({})).toBe("https://api-testnet.nearblocks.io/v3")
  expect(nearDepositIndexUrl({ NEAR_DEPOSIT_INDEX_URL: "" })).toBe(null)
  expect(nearDepositIndexUrl({ NEAR_DEPOSIT_INDEX_URL: "http://host/v9/ " })).toBe("http://host/v9")
  expect(nearDepositIndexKey({ NEAR_DEPOSIT_INDEX_KEY: " abc " })).toBe("abc")
  expect(nearDepositPollMs({})).toBe(20_000)
  expect(nearDepositPollMs({ NEAR_DEPOSIT_POLL_MS: "1000" })).toBe(5_000)
  expect(nearDepositPollMs({ NEAR_DEPOSIT_POLL_MS: "999999" })).toBe(300_000)
  expect(nearDepositScanAfterMs({})).toBe(600_000)
  expect(nearDepositScanAfterMs({ NEAR_DEPOSIT_SCAN_AFTER_MS: "10" })).toBe(5_000)
  expect(nearDepositScanAfterMs({ NEAR_DEPOSIT_SCAN_AFTER_MS: "99999999" })).toBe(3_600_000)
})

test("a v3 event parses defensively and orders by block, index, receipt", () => {
  const event = parseNearDepositIndexEvent(ftEvent({ block: 12, eventIndex: 1 }))
  expect(event).toMatchObject({ blockHeight: 12, eventIndex: 1, receiptId: "Rc12", txHash: "Tx12", cause: "TRANSFER" })
  expect(event?.delta).toBe(2_500_000)
  expect(parseNearDepositIndexEvent({ ...ftEvent({ block: 12 }), receipt_id: "" })).toBe(null)
  expect(parseNearDepositIndexEvent({ ...ftEvent({ block: 12 }), delta_amount: "soon" })).toBe(null)
  expect(parseNearDepositIndexEvent({ ...ftEvent({ block: 12 }), block: { block_height: "x" } })).toBe(null)
  const marker = { blockHeight: 12, eventIndex: 1, receiptId: "Rc12" }
  expect(nearDepositIndexAtOrBefore({ blockHeight: 12, eventIndex: 1, receiptId: "Rc12" }, marker)).toBe(true)
  expect(nearDepositIndexAtOrBefore({ blockHeight: 12, eventIndex: 1, receiptId: "Rc13" }, marker)).toBe(false)
  expect(nearDepositIndexAtOrBefore({ blockHeight: 12, eventIndex: 2, receiptId: "Rc00" }, marker)).toBe(false)
  expect(nearDepositIndexAtOrBefore({ blockHeight: 11, eventIndex: 9, receiptId: "Rc99" }, marker)).toBe(true)
})

test("only treasury QM transfers credit; filtered events still advance the marker", async () => {
  seedDb()
  const rpc = mockRpc({ statuses: new Map([["Tx300", transferReceipt("Tx300", sender, "2500000")]]) })
  const index = mockIndex({
    pages: () => [
      [
        ftEvent({ block: 301, cause: "MINT", involved: null, delta: "100" }),
        ftEvent({ block: 300 }),
        ftEvent({ block: 299, affected: other }),
        ftEvent({ block: 298, contract: other }),
        ftEvent({ block: 297, delta: "-5" }),
      ],
    ],
  })
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
  })
  try {
    const run = await pollNearDepositIndex(treasury)
    expect(run).toMatchObject({ ok: true, pages: 1, credits: 1, events: 5 })
    expect(rpc.counter.txStatus).toBe(1)
    expect(youFor(sender)?.balanceMicros).toBe(2_500_000)
    const rows = getDb().query("SELECT tx_hash, address, amount_micros FROM deposits").all()
    expect(rows).toEqual([{ tx_hash: "Tx300", address: sender, amount_micros: 2_500_000 }])
    const health = nearDepositLag("near-testnet")
    expect(health.source).toBe("indexer")
    expect(health.credits).toBe(1)
    expect(health.marker).toEqual({ blockHeight: 301, eventIndex: 0, receiptId: "Rc301" })
    expect(health.cursor).toBeUndefined()
    expect(health.lag).toBeUndefined()
    const stored = getDb().query("SELECT value FROM meta WHERE key = 'near-testnet:near_deposit_index_marker'").get() as {
      value: string
    }
    expect(JSON.parse(stored.value)).toEqual({ blockHeight: 301, eventIndex: 0, receiptId: "Rc301" })
  } finally {
    restore()
    index.server.stop(true)
    rpc.server.stop(true)
  }
})

test("repeat polls are idempotent and stop at the marker without extra verification", async () => {
  seedDb()
  const rpc = mockRpc({ statuses: new Map([["Tx300", transferReceipt("Tx300", sender, "2500000")]]) })
  const pages: unknown[][] = [[ftEvent({ block: 301, cause: "MINT", involved: null }), ftEvent({ block: 300 })]]
  const index = mockIndex({ pages: () => pages })
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
  })
  try {
    const first = await pollNearDepositIndex(treasury)
    expect(first.credits).toBe(1)
    const second = await pollNearDepositIndex(treasury)
    expect(second).toMatchObject({ ok: true, credits: 0, events: 0 })
    // The newest-first walk stopped at the persisted marker: no second page walk, no second verify.
    expect(index.counter.fetches).toBe(2)
    expect(rpc.counter.txStatus).toBe(1)
    expect(youFor(sender)?.balanceMicros).toBe(2_500_000)
    expect(getDb().query("SELECT COUNT(*) c FROM deposits").get().c).toBe(1)
  } finally {
    restore()
    index.server.stop(true)
    rpc.server.stop(true)
  }
})

test("a first boot without a marker sweeps the whole history oldest-first", async () => {
  seedDb()
  const rpc = mockRpc({
    statuses: new Map([
      ["Tx400", transferReceipt("Tx400", sender, "2500000")],
      ["Tx300", transferReceipt("Tx300", sender, "1250000")],
    ]),
  })
  const index = mockIndex({
    pages: () => [
      [ftEvent({ block: 501, cause: "MINT", involved: null }), ftEvent({ block: 499, cause: "MINT", involved: null })],
      [ftEvent({ block: 400, tx: "Tx400" })],
      [ftEvent({ block: 300, tx: "Tx300" })],
    ],
  })
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
  })
  try {
    const run = await pollNearDepositIndex(treasury)
    expect(run).toMatchObject({ ok: true, pages: 3, credits: 2 })
    expect(youFor(sender)?.balanceMicros).toBe(3_750_000)
    expect(nearDepositLag("near-testnet").marker).toEqual({ blockHeight: 501, eventIndex: 0, receiptId: "Rc501" })
  } finally {
    restore()
    index.server.stop(true)
    rpc.server.stop(true)
  }
})

test("a failed receipt or a wrong hint never credits, and the mismatch is counted", async () => {
  seedDb()
  const rpc = mockRpc({
    statuses: new Map([
      ["Tx300", transferReceipt("Tx300", sender, "2500000", true)],
      ["Tx301", transferReceipt("Tx301", sender, "2500000")],
    ]),
  })
  const index = mockIndex({
    pages: () => [
      [
        // The delta is a dotted decimal while the receipt carries whole micros:
        // the chain is truth, the credit lands, the hint is flagged.
        ftEvent({ block: 301, delta: "2.5" }),
        ftEvent({ block: 300 }),
      ],
    ],
  })
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
  })
  try {
    const run = await pollNearDepositIndex(treasury)
    expect(run).toMatchObject({ ok: true, credits: 1 })
    const health = nearDepositLag("near-testnet")
    expect(health.hintMismatches).toBe(2)
    expect(health.credits).toBe(1)
    expect(youFor(sender)?.balanceMicros).toBe(2_500_000)
    // The failed transfer is not a deposit, but it is handled: the marker moved past it.
    expect(health.marker?.blockHeight).toBe(301)
  } finally {
    restore()
    index.server.stop(true)
    rpc.server.stop(true)
  }
})

test("an RPC outage keeps the hint for the next poll instead of skipping it", async () => {
  seedDb()
  let rpcDown = true
  const rpc = mockRpc({
    statuses: new Map([["Tx300", transferReceipt("Tx300", sender, "2500000")]]),
    failTxStatus: () => rpcDown,
  })
  const index = mockIndex({ pages: () => [[ftEvent({ block: 300 })]] })
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
  })
  try {
    const down = await pollNearDepositIndex(treasury)
    expect(down.ok).toBe(false)
    expect(down.credits).toBe(0)
    expect(getDb().query("SELECT COUNT(*) c FROM deposits").get().c).toBe(0)
    const health = nearDepositLag("near-testnet")
    expect(health.marker).toBe(null)
    expect(health.lastError).toBeTruthy()
    // Inside the grace window the block walk stays idle.
    expect(nearDepositScanActive()).toBe(false)
    rpcDown = false
    // The failed hop parked the endpoint for its backoff window; the next
    // production poll is 20 s out, so give the park time to lapse here too.
    await Bun.sleep(200)
    const retry = await pollNearDepositIndex(treasury)
    expect(retry).toMatchObject({ ok: true, credits: 1 })
    expect(youFor(sender)?.balanceMicros).toBe(2_500_000)
    expect(nearDepositLag("near-testnet").marker?.blockHeight).toBe(300)
  } finally {
    restore()
    index.server.stop(true)
    rpc.server.stop(true)
  }
})

test("a 429 without retry-after still parks the poll", async () => {
  seedDb()
  const index = mockIndex({ pages: () => [[]], status: () => 429 })
  const rpc = mockRpc()
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
  })
  try {
    const throttled = await pollNearDepositIndex(treasury)
    expect(throttled.ok).toBe(false)
    expect(throttled.held).toBe(false)
    expect(index.counter.fetches).toBe(1)
    const held = await pollNearDepositIndex(treasury)
    expect(held.held).toBe(true)
    expect(index.counter.fetches).toBe(1)
  } finally {
    restore()
    index.server.stop(true)
    rpc.server.stop(true)
  }
})

test("a throttled index holds the poll and honors retry-after", async () => {
  seedDb()
  const index = mockIndex({ pages: () => [[]], status: () => 429, retryAfter: "30" })
  const rpc = mockRpc()
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
  })
  try {
    const throttled = await pollNearDepositIndex(treasury)
    expect(throttled.ok).toBe(false)
    expect(index.counter.fetches).toBe(1)
    const held = await pollNearDepositIndex(treasury)
    expect(held.held).toBe(true)
    expect(index.counter.fetches).toBe(1)
    expect(nearDepositLag("near-testnet").lastError).toContain("429")
  } finally {
    restore()
    index.server.stop(true)
    rpc.server.stop(true)
  }
})

test("a hint without a sender stays for retry and never credits blindly", async () => {
  seedDb()
  const rpc = mockRpc({ statuses: new Map([["Tx300", transferReceipt("Tx300", sender, "2500000")]]) })
  const index = mockIndex({ pages: () => [[ftEvent({ block: 300, involved: null })]] })
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
  })
  try {
    const run = await pollNearDepositIndex(treasury)
    expect(run.ok).toBe(false)
    expect(rpc.counter.txStatus).toBe(0)
    expect(getDb().query("SELECT COUNT(*) c FROM deposits").get().c).toBe(0)
    const health = nearDepositLag("near-testnet")
    expect(health.marker).toBe(null)
    expect(health.lastError).toContain("without a sender")
  } finally {
    restore()
    index.server.stop(true)
    rpc.server.stop(true)
  }
})

test("a green poll idles the block walk even with a catch-up-sized backlog", async () => {
  seedDb()
  getDb().query("INSERT INTO meta (key, value) VALUES ('near-testnet:near_deposit_height', '0')").run()
  const rpc = mockRpc({ head: () => 500 })
  const index = mockIndex({ pages: () => [[]] })
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
    NEAR_DEPOSIT_POLL_MS: "5000",
  })
  const loop: NearCustodyLoop = startNearCustody(treasury)
  try {
    // The scan would take 200-block bites immediately if it ran; a green poll
    // keeps it idle, so the cursor never moves and health stays indexer-shaped.
    await Bun.sleep(1200)
    const health = nearDepositLag("near-testnet")
    expect(health.source).toBe("indexer")
    expect(health.lastOkAt).toBeTruthy()
    expect(health.cursor).toBeUndefined()
    const cursor = getDb().query("SELECT value FROM meta WHERE key = 'near-testnet:near_deposit_height'").get() as
      | { value: string }
      | undefined
    expect(cursor?.value).toBe("0")
    expect(rpc.counter.blocks).toBe(0)
  } finally {
    loop.stop()
    restore()
    resetNearRpcQuiet()
    index.server.stop(true)
    rpc.server.stop(true)
  }
})

test("a failing poll engages the block walk after the grace window and recovery idles it", async () => {  seedDb()
  getDb().query("INSERT INTO meta (key, value) VALUES ('near-testnet:near_deposit_height', '0')").run()
  let indexUp = false
  const index = mockIndex({ pages: () => [[]], status: () => (indexUp ? 200 : 500) })
  // A tall head keeps the walk in catch-up cadence (250 ms ticks) for the whole
  // test, so recovery is observed on a tick instead of a 20 s custody interval.
  const rpc = mockRpc({ head: () => 5_000 })
  const restore = envPatch({
    TOKEN_ACCOUNT: token,
    NEAR_DEPOSIT_INDEX_URL: `http://127.0.0.1:${index.server.port}`,
    NEAR_RPC_1: `http://127.0.0.1:${rpc.server.port}/near 500 500 100`,
    NEAR_RPC_GAP_MS: "0",
    NEAR_DEPOSIT_POLL_MS: "5000",
    NEAR_DEPOSIT_SCAN_AFTER_MS: "5000",
    NEAR_DEPOSIT_CATCHUP_LAG: "100",
    NEAR_DEPOSIT_CATCHUP_GAP_MS: "250",
    NEAR_DEPOSIT_CATCHUP_BATCH: "40",
  })
  const loop: NearCustodyLoop = startNearCustody(treasury)
  try {
    // Grace: the first failing tick does not fire the walk.
    await Bun.sleep(600)
    expect(nearDepositLag("near-testnet").source).toBe("indexer")
    // Past the window the walk engages on its own and drains in bounded bites.
    await Bun.sleep(10_000)
    const scanned = nearDepositLag("near-testnet")
    expect(scanned.source).toBe("scan")
    expect(scanned.cursor ?? 0).toBeGreaterThan(0)
    expect(scanned.mode).toBe("catchup")
    // The index comes back: the next tick polls green and the walk idles again.
    indexUp = true
    await Bun.sleep(1200)
    const health = nearDepositLag("near-testnet")
    expect(health.source).toBe("indexer")
    expect(health.lastOkAt).toBeTruthy()
    expect(health.cursor).toBeUndefined()
    const frozen = Number(
      (getDb().query("SELECT value FROM meta WHERE key = 'near-testnet:near_deposit_height'").get() as { value: string })
        .value,
    )
    await Bun.sleep(600)
    const still = Number(
      (getDb().query("SELECT value FROM meta WHERE key = 'near-testnet:near_deposit_height'").get() as { value: string })
        .value,
    )
    expect(still).toBe(frozen)
  } finally {
    loop.stop()
    restore()
    resetNearRpcQuiet()
    resetNearDepositPollForTest()
    index.server.stop(true)
    rpc.server.stop(true)
  }
}, 20_000)
