import { nearLoginMessage } from "../../shared/login"

const RECIPIENT = "quick-market"

export const NEAR_WALLET_ORIGIN = "https://testnet.mynearwallet.com"

const PENDING_KEY = "qm.near.pending"

export type NearPending = {
  issued: number
  nonce: string
  accountId: string | null
}

export type NearCallback = {
  accountId: string
  publicKey: string
  signature: string
}

export function nearLoginUrl(successUrl: string): string {
  const url = new URL("/login/", NEAR_WALLET_ORIGIN)
  url.searchParams.set("success_url", successUrl)
  url.searchParams.set("failure_url", successUrl)
  return url.toString()
}

export function nearSignUrl(message: string, nonce: string, callbackUrl: string): string {
  const url = new URL("/sign-message", NEAR_WALLET_ORIGIN)
  url.searchParams.set("message", message)
  url.searchParams.set("nonce", nonce)
  url.searchParams.set("recipient", RECIPIENT)
  url.searchParams.set("callbackUrl", callbackUrl)
  return url.toString()
}

export function newNonce(): { bytes: Uint8Array; base64: string } {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { bytes, base64: btoa(binary) }
}

export function saveNearPending(pending: NearPending) {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
}

export function readNearPending(): NearPending | null {
  const raw = sessionStorage.getItem(PENDING_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as NearPending
    if (!parsed || typeof parsed.issued !== "number" || typeof parsed.nonce !== "string") return null
    return parsed
  } catch {
    return null
  }
}

export function clearNearPending() {
  sessionStorage.removeItem(PENDING_KEY)
}

export function parseNearAccount(params: URLSearchParams): string | null {
  const account = params.get("account_id") ?? params.get("accountId")
  return account && account.length > 0 ? account : null
}

export function parseNearCallback(params: URLSearchParams): NearCallback | null {
  const accountId = params.get("accountId")
  const publicKey = params.get("publicKey")
  const signature = params.get("signature")
  if (!accountId || !publicKey || !signature) return null
  return { accountId, publicKey, signature }
}

export function signMessageFor(accountId: string, issued: number, nonce: string, callbackUrl: string): string {
  return nearSignUrl(nearLoginMessage(accountId, issued), nonce, callbackUrl)
}

export function stripNearParams(href: string): string {
  const url = new URL(href)
  for (const key of ["account_id", "accountId", "public_key", "publicKey", "all_keys", "signature"]) url.searchParams.delete(key)
  const search = url.searchParams.toString()
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`
}
