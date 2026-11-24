import { beforeEach, expect, test } from "bun:test"
import { KeyPairEd25519 } from "@near-js/crypto"
import { KeyPairSigner } from "@near-js/signers"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { chainFromEnv } from "../shared/chain"
import { loginMessage, nearLoginMessage, SESSION_MS } from "../shared/login"
import { marketPreferences } from "../shared/market"
import { NEP413_RECIPIENT, bs58, generateNearSecret, nep413Bytes, seedFromSecret } from "../shared/nearKey"
import * as ed from "@noble/ed25519"
import { useDatabase, getDb } from "./db"
import { lastAuthPrune, NEAR_BUSY, openSession, pruneExpiredAuth, readSessionToken } from "./session"
import { resetNearRpcQuiet } from "./near"


beforeEach(() => {
  marketPreferences.chain = "base-sepolia"
  process.env.CHAIN = "base-sepolia"
  resetNearRpcQuiet()
  useDatabase(":memory:")
})

async function sign(chainId: number, issued = Date.now()) {
  const account = privateKeyToAccount(generatePrivateKey())
  const signature = await account.signMessage({ message: loginMessage(chainId, account.address, issued) })
  return { account, signature, issued }
}

test("a signed session is accepted once", async () => {
  const chain = chainFromEnv("base-sepolia")
  const { account, signature, issued } = await sign(chain.id)
  const opened = await openSession({ address: account.address, signature, issued, now: issued })
  expect(opened.ok).toBe(true)
  if (opened.ok) expect(opened.you.address).toBe(account.address.toLowerCase())
  const again = await openSession({ address: account.address, signature, issued, now: issued })
  expect(again.ok).toBe(false)
})

test("a signature for another chain is rejected", async () => {
  const issued = Date.now()
  const { account, signature } = await sign(8453, issued)
  const opened = await openSession({ address: account.address, signature, issued, now: issued })
  expect(opened.ok).toBe(false)
})

test("an old signature is rejected", async () => {
  const chain = chainFromEnv("base-sepolia")
  const issued = Date.now() - 5 * 60 * 1000
  const { account, signature } = await sign(chain.id, issued)
  const opened = await openSession({ address: account.address, signature, issued, now: Date.now() })
  expect(opened.ok).toBe(false)
})

test("a missing hello token is anonymous and a bad token is rejected", async () => {
  const chain = chainFromEnv("base-sepolia")
  const { account, signature, issued } = await sign(chain.id)
  const opened = await openSession({ address: account.address, signature, issued, now: issued })
  expect(opened.ok).toBe(true)
  if (!opened.ok) return
  const address = account.address.toLowerCase()
  expect(readSessionToken(undefined, issued)).toEqual({ address: null, rejected: false })
  expect(readSessionToken(null, issued)).toEqual({ address: null, rejected: false })
  expect(readSessionToken("nope", issued)).toEqual({ address: null, rejected: true })
  expect(readSessionToken(opened.token, issued)).toEqual({ address, rejected: false })
  expect(readSessionToken(opened.token, issued + SESSION_MS)).toEqual({ address: null, rejected: true })
})

test("pruneExpiredAuth deletes expired rows, keeps fresh ones, and is idempotent", () => {
  const db = getDb()
  const now = Date.now()
  db.query("INSERT INTO sessions (chain_key, token, address, expires_at) VALUES ('base-sepolia', 'gone', '0x1', ?)").run(now - 1)
  db.query("INSERT INTO sessions (chain_key, token, address, expires_at) VALUES ('base-sepolia', 'kept', '0x2', ?)").run(now + SESSION_MS)
  db.query("INSERT INTO login_sigs (chain_key, signature, expires_at) VALUES ('base-sepolia', 'gone-sig', ?)").run(now - 1)
  db.query("INSERT INTO login_sigs (chain_key, signature, expires_at) VALUES ('base-sepolia', 'kept-sig', ?)").run(now + 60_000)
  expect(pruneExpiredAuth(now)).toBe(2)
  expect(lastAuthPrune()).toEqual({ deleted: 2, at: now })
  expect(db.query("SELECT token FROM sessions").all()).toEqual([{ token: "kept" }])
  expect(db.query("SELECT signature FROM login_sigs").all()).toEqual([{ signature: "kept-sig" }])
  expect(pruneExpiredAuth(now)).toBe(0)
  expect(lastAuthPrune()).toEqual({ deleted: 0, at: now })
})

test("the auth prune is index-backed", () => {
  const now = Date.now()
  const sessions = getDb().query("EXPLAIN QUERY PLAN DELETE FROM sessions WHERE expires_at <= ?").all(now) as { detail: string }[]
  expect(sessions.some((row) => row.detail.includes("sessions_expires"))).toBe(true)
  const sigs = getDb().query("EXPLAIN QUERY PLAN DELETE FROM login_sigs WHERE expires_at <= ?").all(now) as { detail: string }[]
  expect(sigs.some((row) => row.detail.includes("login_sigs_expires"))).toBe(true)
})

async function meteorSignature(account: string, secretKey: string, issued: number, nonce: Uint8Array) {
  const signer = new KeyPairSigner(new KeyPairEd25519(secretKey.slice("ed25519:".length)))
  const signed = await signer.signNep413Message(nearLoginMessage(account, issued), account, NEP413_RECIPIENT, nonce)
  return {
    publicKey: signed.publicKey.toString(),
    signature: Buffer.from(signed.signature).toString("base64"),
  }
}

test("a NEAR NEP-413 signature opens a session only with its nonce", async () => {
  const previousKey = process.env.TREASURY_PRIVATE_KEY
  marketPreferences.chain = "near-testnet"
  try {
    const made = await generateNearSecret()
    process.env.TREASURY_PRIVATE_KEY = made.secretKey
    const issued = Date.now()
    const nonce = new Uint8Array(32).fill(4)
    const signed = await meteorSignature(made.account, made.secretKey, issued, nonce)
    const opened = await openSession({
      address: made.account,
      signature: signed.signature,
      issued,
      now: issued,
      nonce: Buffer.from(nonce).toString("base64"),
      publicKey: signed.publicKey,
    })
    expect(opened.ok).toBe(true)

    const otherIssued = issued + 1
    const wrongNonce = new Uint8Array(32).fill(5)
    const other = await meteorSignature(made.account, made.secretKey, otherIssued, nonce)
    const rejected = await openSession({
      address: made.account,
      signature: other.signature,
      issued: otherIssued,
      now: otherIssued,
      nonce: Buffer.from(wrongNonce).toString("base64"),
      publicKey: other.publicKey,
    })
    expect(rejected).toEqual({
      ok: false,
      error: "Signature is invalid\nThe signature does not match the sign-in message (NEP-413, sha256, recipient quick-market, no callback URL).",
    })

    const rawIssued = issued + 2
    const raw = Buffer.from(
      await ed.signAsync(
        nep413Bytes(nearLoginMessage(made.account, rawIssued), nonce, NEP413_RECIPIENT),
        seedFromSecret(made.secretKey)!,
      ),
    ).toString("hex")
    const rawRejected = await openSession({
      address: made.account,
      signature: raw,
      issued: rawIssued,
      now: rawIssued,
      nonce: Buffer.from(nonce).toString("base64"),
      publicKey: signed.publicKey,
    })
    expect(rawRejected).toEqual({
      ok: false,
      error: "Signature is invalid\nThe signature does not match the sign-in message (NEP-413, sha256, recipient quick-market, no callback URL).",
    })
  } finally {
    marketPreferences.chain = "base-sepolia"
    if (previousKey === undefined) delete process.env.TREASURY_PRIVATE_KEY
    else process.env.TREASURY_PRIVATE_KEY = previousKey
  }
})

test("a NEAR sign-in names the check that failed", async () => {
  marketPreferences.chain = "near-testnet"
  const made = await generateNearSecret()
  const issued = Date.now()
  const nonce = Buffer.from(new Uint8Array(32)).toString("base64")
  const publicKey = `ed25519:${bs58.encode(Buffer.from(made.account, "hex"))}`
  const missingNonce = await openSession({
    address: made.account,
    signature: "aa",
    issued,
    now: issued,
    publicKey,
  })
  expect(missingNonce).toEqual({
    ok: false,
    error: "Signature is invalid\nThe sign-in nonce is missing or not 32 bytes.",
  })
  const missingKey = await openSession({
    address: made.account,
    signature: "aa",
    issued,
    now: issued,
    nonce,
    publicKey: "secp256k1:nope",
  })
  expect(missingKey).toEqual({
    ok: false,
    error: "Signature is invalid\nThe public key is missing or not an ed25519 key.",
  })
  const otherKey = `ed25519:${bs58.encode(Buffer.alloc(32, 9))}`
  const implicit = await openSession({
    address: made.account,
    signature: "aa",
    issued,
    now: issued,
    nonce,
    publicKey: otherKey,
  })
  expect(implicit).toEqual({
    ok: false,
    error: "Signature is invalid\nThe public key does not match this implicit account.",
  })
  const short = await openSession({
    address: made.account,
    signature: "aa",
    issued,
    now: issued,
    nonce,
    publicKey,
  })
  expect(short).toEqual({
    ok: false,
    error: "Signature is invalid\nThe signature is not 64 bytes.",
  })
  marketPreferences.chain = "base-sepolia"
})

test("a NEAR account key that is not on the account says so", async () => {
  const previousRpc = process.env.RPC_URL
  const previousChain = process.env.CHAIN
  const previousSlots = [1, 2, 3, 4].map((slot) => process.env[`NEAR_RPC_${slot}`])
  for (let slot = 1; slot <= 4; slot++) delete process.env[`NEAR_RPC_${slot}`]
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ jsonrpc: "2.0", id: "quick-market", error: { message: "Account alice.testnet does not exist" } })
    },
  })
  marketPreferences.chain = "near-testnet"
  process.env.CHAIN = "near-testnet"
  process.env.RPC_URL = `http://127.0.0.1:${server.port}/near`
  const issued = Date.now()
  try {
    const opened = await openSession({
      address: "alice.testnet",
      signature: Buffer.alloc(64).toString("base64"),
      issued,
      now: issued,
      nonce: Buffer.from(new Uint8Array(32)).toString("base64"),
      publicKey: `ed25519:${bs58.encode(Buffer.alloc(32, 7))}`,
    })
    expect(opened).toEqual({
      ok: false,
      error: "Signature is invalid\nThis public key is not an access key on the account.",
    })
  } finally {
    server.stop(true)
    marketPreferences.chain = "base-sepolia"
    process.env.CHAIN = previousChain
    if (previousRpc === undefined) delete process.env.RPC_URL
    else process.env.RPC_URL = previousRpc
    previousSlots.forEach((value, index) => {
      if (value === undefined) delete process.env[`NEAR_RPC_${index + 1}`]
      else process.env[`NEAR_RPC_${index + 1}`] = value
    })
  }
})

test("a refused NEAR access-key check is a busy sign-in", async () => {
  const previousRpc = process.env.RPC_URL
  const previousChain = process.env.CHAIN
  const previousSlots = [1, 2, 3, 4].map((slot) => process.env[`NEAR_RPC_${slot}`])
  for (let slot = 1; slot <= 4; slot++) delete process.env[`NEAR_RPC_${slot}`]
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("slow", { status: 429 })
    },
  })
  marketPreferences.chain = "near-testnet"
  process.env.CHAIN = "near-testnet"
  process.env.RPC_URL = `http://127.0.0.1:${server.port}/near`
  const issued = Date.now()
  try {
    const opened = await openSession({
      address: "alice.testnet",
      signature: "00",
      issued,
      now: issued,
      nonce: Buffer.from(new Uint8Array(32)).toString("base64"),
      publicKey: `ed25519:${bs58.encode(Buffer.alloc(32, 7))}`,
    })
    expect(opened).toEqual({ ok: false, error: NEAR_BUSY })
  } finally {
    server.stop(true)
    marketPreferences.chain = "base-sepolia"
    process.env.CHAIN = previousChain
    if (previousRpc === undefined) delete process.env.RPC_URL
    else process.env.RPC_URL = previousRpc
    previousSlots.forEach((value, index) => {
      if (value === undefined) delete process.env[`NEAR_RPC_${index + 1}`]
      else process.env[`NEAR_RPC_${index + 1}`] = value
    })
  }
}, 20_000)
