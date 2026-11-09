import { expect, test } from "bun:test"
import * as ed from "@noble/ed25519"
import bs58 from "bs58"
import { generateNearSecret, seedFromSecret, sha256Bytes } from "../shared/nearKey"
import { encodeFunctionCall, encodeTransaction, jsonArgs, signTransaction } from "./nearTx"

test("a signed NEAR transaction reports the unsigned transaction hash", async () => {
  const made = await generateNearSecret()
  const seed = seedFromSecret(made.secretKey)!
  const publicKey = await ed.getPublicKeyAsync(seed)
  const blockHash = new Uint8Array(32).fill(3)
  const nonce = 7n
  const receiverId = "bb".repeat(32)
  const actions = [encodeFunctionCall("ft_transfer", jsonArgs({ receiver_id: "cc".repeat(32), amount: "1000000", memo: null }), 30_000_000_000_000n, 1n)]
  const signed = await signTransaction({ signerId: made.account, secretKey: made.secretKey, nonce, receiverId, blockHash, actions })
  const transaction = encodeTransaction({ signerId: made.account, publicKey, nonce, receiverId, blockHash, actions })

  expect(signed.hash).toBe(bs58.encode(sha256Bytes(transaction)))
  expect(signed.hash).not.toBe(bs58.encode(sha256Bytes(signed.signed)))
  expect(signed.signed.subarray(0, transaction.length)).toEqual(transaction)
  expect(signed.signed[transaction.length]).toBe(0)
  expect(await ed.verifyAsync(signed.signed.subarray(transaction.length + 1), sha256Bytes(transaction), publicKey)).toBe(true)
})
