import * as ed from "@noble/ed25519"
import bs58 from "bs58"
import { sha256Bytes, seedFromSecret } from "../shared/nearKey"

const textEncoder = new TextEncoder()

function pushU32(out: number[], value: number) {
  out.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255)
}

function pushU64(out: number[], value: bigint) {
  let rest = value
  for (let i = 0; i < 8; i++) {
    out.push(Number(rest & 255n))
    rest >>= 8n
  }
}

function pushU128(out: number[], value: bigint) {
  let rest = value
  for (let i = 0; i < 16; i++) {
    out.push(Number(rest & 255n))
    rest >>= 8n
  }
}

function pushStr(out: number[], value: string) {
  const bytes = textEncoder.encode(value)
  pushU32(out, bytes.length)
  for (const byte of bytes) out.push(byte)
}

function pushBytes(out: number[], bytes: Uint8Array) {
  pushU32(out, bytes.length)
  for (const byte of bytes) out.push(byte)
}

export function encodeTransfer(deposit: bigint): number[] {
  const out = [3]
  pushU128(out, deposit)
  return out
}

export function encodeFunctionCall(method: string, args: Uint8Array, gas: bigint, deposit: bigint): number[] {
  const out = [2]
  pushStr(out, method)
  pushBytes(out, args)
  pushU64(out, gas)
  pushU128(out, deposit)
  return out
}

export function encodeDeploy(code: Uint8Array): number[] {
  const out = [1]
  pushBytes(out, code)
  return out
}

export function encodeTransaction(input: {
  signerId: string
  publicKey: Uint8Array
  nonce: bigint
  receiverId: string
  blockHash: Uint8Array
  actions: number[][]
}): Uint8Array {
  if (input.publicKey.length !== 32) throw new Error("Public key is invalid")
  if (input.blockHash.length !== 32) throw new Error("Block hash is invalid")
  const out: number[] = []
  pushStr(out, input.signerId)
  out.push(0)
  for (const byte of input.publicKey) out.push(byte)
  pushU64(out, input.nonce)
  pushStr(out, input.receiverId)
  for (const byte of input.blockHash) out.push(byte)
  pushU32(out, input.actions.length)
  for (const action of input.actions) for (const byte of action) out.push(byte)
  return Uint8Array.from(out)
}

export async function signTransaction(input: {
  signerId: string
  secretKey: string
  nonce: bigint
  receiverId: string
  blockHash: Uint8Array
  actions: number[][]
}): Promise<{ signed: Uint8Array; hash: string }> {
  const seed = seedFromSecret(input.secretKey)
  if (!seed) throw new Error("TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
  const publicKey = await ed.getPublicKeyAsync(seed)
  const tx = encodeTransaction({ ...input, publicKey })
  const hash = sha256Bytes(tx)
  const signature = await ed.signAsync(hash, seed)
  const signed = new Uint8Array(tx.length + 1 + signature.length)
  signed.set(tx, 0)
  signed[tx.length] = 0
  signed.set(signature, tx.length + 1)
  return { signed, hash: bs58.encode(hash) }
}

export function jsonArgs(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value))
}
