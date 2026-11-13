import { expect, test } from "bun:test"
import {
  DEFAULT_NEAR_RPCS,
  NEAR_DRPC,
  NEAR_FALLBACK_RPC,
  NEAR_PUBLIC_RPC,
  callNearRpc,
  nearHistoryMissing,
  nearRpcEndpoints,
  nearRpcOrder,
  nearSendOrder,
  parseNearRpcLine,
  prunedDepositResume,
  resetNearRpcQuiet,
} from "./near"

const drpc = DEFAULT_NEAR_RPCS[0]
const fastnear = DEFAULT_NEAR_RPCS[1]

test("a NEAR RPC line is a url and three millisecond budgets", () => {
  expect(parseNearRpcLine(" https://near-testnet.drpc.org/ 1800 1800 1000 ")).toEqual({
    url: NEAR_DRPC,
    timeoutMs: 1_800,
    sendTimeoutMs: 1_800,
    backoffMs: 1_000,
  })
  expect(() => parseNearRpcLine("https://near-testnet.drpc.org")).toThrow("NEAR_RPC must be")
  expect(() => parseNearRpcLine("https://near-testnet.drpc.org 50 1800 1000")).toThrow("timeout must be")
  expect(() => parseNearRpcLine("https://near-testnet.drpc.org 1800 90000 1000")).toThrow("send timeout")
  expect(() => parseNearRpcLine("https://near-testnet.drpc.org 1800 1800 -1")).toThrow("backoff")
})

test("four NEAR lines replace the default list and a fifth is refused", () => {
  const configured = nearRpcEndpoints({
    RPC_URL: "https://example.test/near",
    NEAR_RPC_1: "https://one.example/near 1800 1800 1000",
    NEAR_RPC_3: "https://three.example/near 4000 8000 1500",
  })
  expect(configured.map((endpoint) => endpoint.url)).toEqual(["https://one.example/near", "https://three.example/near"])
  expect(() => nearRpcEndpoints({ NEAR_RPC_5: "https://five.example/near 1800 1800 1000" })).toThrow("4 endpoints")
})

test("an unset list prefers dRPC and leaves the official node out", () => {
  const urls = nearRpcEndpoints({}).map((endpoint) => endpoint.url)
  expect(urls).toEqual([
    NEAR_DRPC,
    NEAR_FALLBACK_RPC,
    "https://api.zan.top/near-testnet",
    "https://testnet-rpc.intea.rs",
  ])
  expect(urls).not.toContain(NEAR_PUBLIC_RPC)
  expect(drpc.sendTimeoutMs).toBe(1_800)
  expect(fastnear.sendTimeoutMs).toBe(20_000)
  const legacy = nearRpcEndpoints({ RPC_URL: "https://example.test/near/" })
  expect(legacy).toEqual([{ url: "https://example.test/near", timeoutMs: 8_000, sendTimeoutMs: 20_000, backoffMs: 1_000 }])
  expect(nearRpcEndpoints({ RPC_URL: "https://sepolia.base.org" }).map((endpoint) => endpoint.url)).toEqual(urls)
})

test("a cooling endpoint is skipped and a waiting send starts on a patient node", () => {
  const quiet = new Map<string, number>([[drpc.url, 5_000]])
  expect(nearRpcOrder(DEFAULT_NEAR_RPCS, 4_000, quiet).map((endpoint) => endpoint.url)[0]).toBe(NEAR_FALLBACK_RPC)
  expect(nearRpcOrder(DEFAULT_NEAR_RPCS, 5_000, quiet)[0]?.url).toBe(NEAR_DRPC)
  const allQuiet = new Map(DEFAULT_NEAR_RPCS.map((endpoint, index) => [endpoint.url, 10_000 + index]))
  expect(nearRpcOrder(DEFAULT_NEAR_RPCS, 1_000, allQuiet)).toEqual([drpc])
  expect(nearSendOrder([drpc, fastnear], "EXECUTED").map((endpoint) => endpoint.url)).toEqual([fastnear.url, drpc.url])
  expect(nearSendOrder([drpc, fastnear], "NONE").map((endpoint) => endpoint.url)).toEqual([drpc.url, fastnear.url])
  expect(nearSendOrder([drpc, fastnear], "INCLUDED")[0]?.url).toBe(fastnear.url)
})

test("a pruned deposit cursor resumes at the block before the head", () => {
  expect(prunedDepositResume(277_224_080, 277_536_386)).toBe(277_536_385)
  expect(prunedDepositResume(100, 200)).toBeNull()
  expect(nearHistoryMissing(new Error("DB Not Found Error: BLOCK: abc"))).toBe(true)
  expect(nearHistoryMissing(new Error('{"ActionError":"mint failed"}'))).toBe(false)
})

test("an HTTP 422 that names a missing block is still a missing block", async () => {
  resetNearRpcQuiet()
  const missing = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: "quick-market",
          error: { message: "Server error", data: "DB Not Found Error: BLOCK: abc", cause: { name: "UNKNOWN_BLOCK" } },
        },
        { status: 422 },
      )
    },
  })
  const ready = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: { header: { height: 11 }, chunks: [] } })
    },
  })
  const endpoints = [
    { url: `http://127.0.0.1:${missing.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_000, backoffMs: 60_000 },
    { url: `http://127.0.0.1:${ready.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_000, backoffMs: 1_000 },
  ]
  try {
    expect(await callNearRpc(endpoints, "block", { block_id: 11 })).toEqual({ header: { height: 11 }, chunks: [] })
    expect(nearHistoryMissing(new Error('HANDLER_ERROR {"name":"UNKNOWN_BLOCK"}'))).toBe(true)
  } finally {
    resetNearRpcQuiet()
    missing.stop(true)
    ready.stop(true)
  }
})

test("a node that dropped a block is skipped for one that still has it", async () => {
  resetNearRpcQuiet()
  const hits: string[] = []
  const missing = Bun.serve({
    port: 0,
    fetch() {
      hits.push("missing")
      return Response.json({
        jsonrpc: "2.0",
        id: "quick-market",
        error: { message: "Server error", data: "DB Not Found Error: BLOCK: abc" },
      })
    },
  })
  const ready = Bun.serve({
    port: 0,
    fetch() {
      hits.push("ready")
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: { header: { height: 10 }, chunks: [] } })
    },
  })
  const endpoints = [
    { url: `http://127.0.0.1:${missing.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_000, backoffMs: 60_000 },
    { url: `http://127.0.0.1:${ready.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_000, backoffMs: 1_000 },
  ]
  try {
    expect(await callNearRpc(endpoints, "block", { block_id: 10 })).toEqual({ header: { height: 10 }, chunks: [] })
    expect(hits).toEqual(["missing", "ready"])
  } finally {
    resetNearRpcQuiet()
    missing.stop(true)
    ready.stop(true)
  }
})

test("a refused hop is parked and the next endpoint answers", async () => {
  resetNearRpcQuiet()
  const hits: string[] = []
  const refused = Bun.serve({
    port: 0,
    fetch(request) {
      hits.push(`refused ${request.headers.get("user-agent")}`)
      return new Response("no", { status: 429 })
    },
  })
  const ready = Bun.serve({
    port: 0,
    fetch() {
      hits.push("ready")
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: { amount: "1" } })
    },
  })
  const endpoints = [
    { url: `http://127.0.0.1:${refused.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_000, backoffMs: 60_000 },
    { url: `http://127.0.0.1:${ready.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_000, backoffMs: 1_000 },
  ]
  try {
    expect(await callNearRpc(endpoints, "query", { request_type: "view_account" })).toEqual({ amount: "1" })
    expect(hits).toEqual(["refused quick-market", "ready"])
    hits.length = 0
    expect(await callNearRpc(endpoints, "query", {})).toEqual({ amount: "1" })
    expect(hits).toEqual(["ready"])
  } finally {
    resetNearRpcQuiet()
    refused.stop(true)
    ready.stop(true)
  }
})

test("an execution failure does not fall through", async () => {
  resetNearRpcQuiet()
  const hits: string[] = []
  const failed = Bun.serve({
    port: 0,
    fetch() {
      hits.push("failed")
      return Response.json({ jsonrpc: "2.0", id: "quick-market", error: { message: "Server error", data: { ActionError: "mint failed" } } })
    },
  })
  const ready = Bun.serve({
    port: 0,
    fetch() {
      hits.push("ready")
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: { ok: true } })
    },
  })
  const endpoints = [
    { url: `http://127.0.0.1:${failed.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_000, backoffMs: 1_000 },
    { url: `http://127.0.0.1:${ready.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_000, backoffMs: 1_000 },
  ]
  try {
    await expect(callNearRpc(endpoints, "send_tx", { wait_until: "NONE" })).rejects.toThrow("ActionError")
    expect(hits).toEqual(["failed"])
  } finally {
    resetNearRpcQuiet()
    failed.stop(true)
    ready.stop(true)
  }
})

test("a waiting send starts on the patient endpoint", async () => {
  resetNearRpcQuiet()
  const hits: string[] = []
  const quick = Bun.serve({
    port: 0,
    fetch() {
      hits.push("quick")
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: { from: "quick" } })
    },
  })
  const patient = Bun.serve({
    port: 0,
    fetch() {
      hits.push("patient")
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: { from: "patient" } })
    },
  })
  const endpoints = [
    { url: `http://127.0.0.1:${quick.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_800, backoffMs: 1_000 },
    { url: `http://127.0.0.1:${patient.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 20_000, backoffMs: 1_000 },
  ]
  try {
    expect(await callNearRpc(endpoints, "send_tx", { wait_until: "EXECUTED" })).toEqual({ from: "patient" })
    expect(hits).toEqual(["patient"])
    hits.length = 0
    expect(await callNearRpc(endpoints, "send_tx", { wait_until: "NONE" })).toEqual({ from: "quick" })
    expect(hits).toEqual(["quick"])
  } finally {
    resetNearRpcQuiet()
    quick.stop(true)
    patient.stop(true)
  }
})

test("a short send timeout falls through inside the shared budget", async () => {
  resetNearRpcQuiet()
  const hits: string[] = []
  const hung = Bun.serve({
    port: 0,
    fetch() {
      hits.push("hung")
      return new Promise(() => undefined)
    },
  })
  const ready = Bun.serve({
    port: 0,
    fetch() {
      hits.push("ready")
      return Response.json({ jsonrpc: "2.0", id: "quick-market", result: { from: "ready" } })
    },
  })
  const endpoints = [
    { url: `http://127.0.0.1:${hung.port}/near`, timeoutMs: 200, sendTimeoutMs: 200, backoffMs: 1_000 },
    { url: `http://127.0.0.1:${ready.port}/near`, timeoutMs: 1_000, sendTimeoutMs: 1_000, backoffMs: 1_000 },
  ]
  try {
    const started = Date.now()
    expect(await callNearRpc(endpoints, "send_tx", { signed_tx_base64: "aa", wait_until: "NONE" })).toEqual({ from: "ready" })
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(hits).toEqual(["hung", "ready"])
  } finally {
    resetNearRpcQuiet()
    hung.stop(true)
    ready.stop(true)
  }
})
