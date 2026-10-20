import { CHAINS } from "../../shared/chain"
import { isUnrecognizedChain } from "./depositFlow"

export type ConnectKind = "modal" | "deeplink"
export type LoginAction = "browse" | "connect-and-sign" | "sign" | "done"

export const LOGIN_QUERY = "login"
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
