import { CHAINS } from "../../shared/chain"
import { isUnrecognizedChain } from "./depositFlow"

export type ConnectKind = "modal" | "deeplink"
export type LoginAction = "browse" | "connect-and-sign" | "sign" | "done"
export type LoginPhase = "phantom" | "sign" | "session"

export const LOGIN_QUERY = "login"
export const SIGN_PROMPT = "Sign in to trade"
export const TESTNET_MODE = "Turn on Testnet Mode in Phantom: Settings → Developer Settings."

const BROWSE_ORIGIN = "https://phantom.com"

/** Mobile browsers without an injected Phantom get the browse link. Signing continues on the opened page. */
export function connectKind(input: { mobile: boolean; injected: boolean }): ConnectKind {
  return input.mobile && !input.injected ? "deeplink" : "modal"
}

/**
 * One press signs in. Browse only leaves the mobile browser. A matching session does not prompt.
 * `connected` means Phantom already authorized this page, so the press only signs.
 */
export function loginAction(input: {
  mobile: boolean
  injected: boolean
  connected: boolean
  sessionMatches: boolean
}): LoginAction {
  if (input.sessionMatches) return "done"
  if (input.mobile && !input.injected) return "browse"
  if (input.connected) return "sign"
  return "connect-and-sign"
}

/** Sentence for the sign-in row. The session step is the grant, not another Phantom prompt. */
export function loginStatus(phase: LoginPhase, testnet: boolean): string {
  if (phase === "phantom") return "Waiting for Phantom"
  if (phase === "sign") return "Approve the sign-in in Phantom"
  if (testnet) return "Signed. Adding your balance on Base Sepolia. This can take a bit."
  return "Confirming sign-in"
}

export function loginSteps(testnet: boolean): readonly [string, string, string] {
  return testnet ? ["Phantom", "Approve", "Balance"] : ["Phantom", "Approve", "Confirm"]
}

export function loginStepState(index: number, phase: LoginPhase): "done" | "now" | "later" {
  const current = phase === "phantom" ? 0 : phase === "sign" ? 1 : 2
  if (index < current) return "done"
  if (index === current) return "now"
  return "later"
}

export function grantWaitStatus(progress?: { seen: number; needed: number }): string {
  if (!progress) return "Minting the grant on Base Sepolia. This can take a bit."
  const needed = Math.max(0, Math.floor(progress.needed))
  const seen = Math.min(needed, Math.max(0, Math.floor(progress.seen)))
  const left = needed - seen
  if (left === 0) return "Confirmations in. Crediting the balance."
  return left === 1 ? "Waiting on 1 confirmation" : `Waiting on ${left} confirmations`
}

/**
 * Official browse route. The SDK helper still emits phantom.app; current docs use phantom.com.
 * `login=1` is on the opened page because sessionStorage does not survive the app hop.
 */
export function phantomBrowseUrl(pageHref: string, ref: string): string {
  const page = new URL(pageHref)
  if (page.protocol !== "http:" && page.protocol !== "https:") {
    throw new Error("Phantom needs an https link to this page.")
  }
  page.searchParams.set(LOGIN_QUERY, "1")
  const referrer = new URL(ref)
  if (referrer.protocol !== "http:" && referrer.protocol !== "https:") {
    throw new Error("Phantom needs an https link to this page.")
  }
  const target = encodeURIComponent(page.toString())
  const refParam = encodeURIComponent(referrer.origin)
  return `${BROWSE_ORIGIN}/ul/browse/${target}?ref=${refParam}`
}

/** Read `login=1` once. The cleaned URL is what replaceState should keep. */
export function takeLoginQuery(href: string): { continueLogin: boolean; clean: string } {
  const url = new URL(href)
  const continueLogin = url.searchParams.get(LOGIN_QUERY) === "1"
  url.searchParams.delete(LOGIN_QUERY)
  return { continueLogin, clean: url.toString() }
}

/**
 * Never add a chain. Base and Base Sepolia already ship in Phantom, and
 * wallet_addEthereumChain on either one leaves the request pending.
 */
export function shouldAddChain(chainId: number): boolean {
  if (chainId === CHAINS.base.id || chainId === CHAINS["base-sepolia"].id) return false
  return false
}

/** A failed switch stays a message. It never asks the wallet to add a chain. */
export function switchFault(chainId: number, error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const lower = message.toLowerCase()
  const code = errorCode(error)
  if (code === 4001 || lower.includes("user rejected") || lower.includes("user denied")) return "Switch cancelled"
  if (chainId === CHAINS["base-sepolia"].id && (isUnrecognizedChain(error) || lower.includes("testnet"))) {
    return TESTNET_MODE
  }
  if (isUnrecognizedChain(error)) return "This network is not available in Phantom."
  const brief = message.split("\n")[0]?.trim() ?? ""
  if (!brief || brief.length > 160) return "Could not switch network"
  return brief
}

function errorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  const code = (error as { code?: unknown }).code
  return typeof code === "number" ? code : null
}

export function phantomInjected(
  target: { phantom?: { ethereum?: unknown }; ethereum?: { isPhantom?: boolean } } | null | undefined,
): boolean {
  if (!target) return false
  return Boolean(target.phantom?.ethereum || target.ethereum?.isPhantom)
}

/** The account Phantom just authorized. Prefer the address already on screen, and keep Phantom's own string. */
export function authorizedAccount(granted: readonly string[], shown: string | null): string | null {
  const accounts = granted.filter((item) => item.length > 0)
  if (accounts.length === 0) return null
  if (shown) {
    const match = accounts.find((item) => item.toLowerCase() === shown.toLowerCase())
    if (match) return match
  }
  return accounts[0] ?? null
}

const SWALLOWED_CONNECT = new Set([
  "Failed to connect to Phantom.",
  "Failed to connect to any supported wallet provider",
])

const GENERIC_FAULT = new Set([
  ...SWALLOWED_CONNECT,
  "Failed to connect",
  "Sign-in failed",
])

type EthereumRequester = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

/** The injected provider. The SDK connect helper drops the JSON-RPC error from this request. */
export function phantomEthereumProvider(
  target: { phantom?: { ethereum?: unknown } } | null | undefined,
): EthereumRequester | null {
  const ethereum = target?.phantom?.ethereum
  if (!ethereum || typeof ethereum !== "object") return null
  const request = (ethereum as { request?: unknown }).request
  if (typeof request !== "function") return null
  return {
    request: (args) => Reflect.apply(request, ethereum, [args]) as Promise<unknown>,
  }
}

export async function requestPhantomAccounts(provider: EthereumRequester): Promise<string[]> {
  const accounts = await provider.request({ method: "eth_requestAccounts" })
  if (!Array.isArray(accounts)) return []
  return accounts.filter((item): item is string => typeof item === "string" && item.length > 0)
}

/** True when the SDK replaced a provider failure with its own empty connect message. */
export function swallowedConnectError(error: unknown): boolean {
  return error instanceof Error && SWALLOWED_CONNECT.has(error.message)
}

type FaultBits = { message: string; code: number | null; data: string | null }

function readCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value)
  return null
}

function shortData(value: unknown): string | null {
  if (value == null || value === "") return null
  let text = ""
  if (typeof value === "string") text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      return null
    }
  }
  const one = text.replace(/\s+/g, " ").trim()
  if (!one) return null
  return one.length > 120 ? `${one.slice(0, 117)}...` : one
}

function briefMessage(message: string): string {
  const line = message.split("\n")[0]?.trim() ?? ""
  if (!line) return "Sign-in failed"
  return line.length > 180 ? `${line.slice(0, 177)}...` : line
}

function bitsOf(value: unknown): FaultBits | null {
  if (typeof value === "string") return { message: value.trim(), code: null, data: null }
  if (!value || typeof value !== "object") return null
  const record = value as { code?: unknown; message?: unknown; shortMessage?: unknown; data?: unknown }
  const code = readCode(record.code)
  const message =
    typeof record.message === "string" && record.message.trim()
      ? record.message.trim()
      : typeof record.shortMessage === "string"
        ? record.shortMessage.trim()
        : ""
  const data = shortData(record.data)
  if (!message && code == null && !data) return null
  return { message, code, data }
}

function faultChain(error: unknown): FaultBits[] {
  const seen = new Set<unknown>()
  const list: unknown[] = []
  let current: unknown = error
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    list.push(current)
    current = (current as { cause?: unknown }).cause
  }
  if (list.length === 0 && error != null) list.push(error)
  return list.flatMap((item) => {
    const bits = bitsOf(item)
    return bits ? [bits] : []
  })
}

function isRejection(bits: FaultBits): boolean {
  if (bits.code === 4001) return true
  const lower = bits.message.toLowerCase()
  return lower.includes("user rejected") || lower.includes("user denied")
}

/**
 * A user rejection stays the short sign-in line. Anything else names the call
 * that failed, plus Phantom's message, code, and data.
 */
export function providerFault(error: unknown, source: string): string {
  const parts = faultChain(error)
  if (parts.some(isRejection)) return SIGN_PROMPT
  const specific =
    [...parts].reverse().find((item) => item.message && !GENERIC_FAULT.has(item.message)) ??
    parts[parts.length - 1]
  if (!specific) return `${source}: Sign-in failed`
  const message = briefMessage(specific.message)
  const code = specific.code != null ? ` (${specific.code})` : ""
  const data = specific.data && specific.data !== message ? ` · ${specific.data}` : ""
  return `${source}: ${message}${code}${data}`
}

/** Phantom EIP-1193 4100, including viem's wrapper around that code. */
export function isUnauthorized(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if (providerCode(error) === 4100) return true
  const cause = (error as { cause?: unknown }).cause
  if (cause && typeof cause === "object" && providerCode(cause) === 4100) return true
  const message = error instanceof Error ? error.message : ""
  return message.toLowerCase().includes("has not been authorized")
}

function providerCode(error: object): number | null {
  const code = (error as { code?: unknown }).code
  return typeof code === "number" ? code : null
}
