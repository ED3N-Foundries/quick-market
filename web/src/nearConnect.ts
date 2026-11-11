import type { MeteorConnect } from "@meteorwallet/sdk"
import { LOGIN_SKEW_MS, nearLoginMessage } from "../../shared/login"

const RECIPIENT = "quick-market"

const CANCELLED = new Set([
  "Action was cancelled",
  "User cancelled the action",
  "User closed the window",
  "User closed the window before completing the action",
  "User didn't complete the action",
  "mobile_bridge_cancelled",
  "mobile_bridge_wallet_declined",
])

/** Meteor's success handler checks `window.closed` in the same turn the popup closes, and that rejects a finished sign-in. Keep `closed` false briefly so the success message wins. */
export const METEOR_POPUP_GRACE_MS = 1000

const METEOR_WALLET_POPUP = /^https:\/\/(?:[\w-]+\.)?meteorwallet\.app\//

export function meteorPopupClosed(actuallyClosed: boolean, seenClosedAt: number, now: number): { closed: boolean; seenClosedAt: number } {
  if (!actuallyClosed) return { closed: false, seenClosedAt: 0 }
  const seen = seenClosedAt || now
  return { closed: now - seen >= METEOR_POPUP_GRACE_MS, seenClosedAt: seen }
}

export type NearSignParams = {
  message: string
  recipient: string
  nonce: Uint8Array
}

export type NearSigned = {
  accountId: string
  publicKey: string
  signature: string
}

let opening: Promise<MeteorConnect> | null = null

/** NEP-413 fields for Meteor. The login message names the account, so this runs after sign-in. No callback URL: the server verifies the payload with that field absent. */
export function nearSignParams(accountId: string, issued: number, nonce: Uint8Array): NearSignParams {
  return {
    message: nearLoginMessage(accountId, issued),
    recipient: RECIPIENT,
    nonce,
  }
}

export function newNonce(): { bytes: Uint8Array; base64: string } {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return { bytes, base64: encodeBase64(bytes) }
}

const POPUP_BLOCKED = new Set([
  "Couldn't open popup window to complete wallet action",
  "Popup window failed to open",
  "User refused to allow the popup window to open",
])

/** Shown as a wallet toast. Kept short so the toast line is the whole sentence. */
export const METEOR_POPUP_BLOCKED = "The browser blocked Meteor's sign-in window. Allow popups, then tap again."

export type NearLoginDraft = {
  accountId: string
  issued: number
  nonce: { bytes: Uint8Array; base64: string }
}

/** A finished Meteor sign-in can retry the signature alone until the login message expires. */
export function nearLoginResume(draft: NearLoginDraft | null, now: number): NearLoginDraft | null {
  if (!draft || now - draft.issued > LOGIN_SKEW_MS) return null
  return draft
}

export function meteorCancelled(error: unknown): boolean {
  return error instanceof Error && CANCELLED.has(error.message)
}

export function meteorPopupBlocked(error: unknown): boolean {
  return error instanceof Error && POPUP_BLOCKED.has(error.message)
}

/** Meteor returns a public-key object and raw signature bytes. The session POST still wants `ed25519:` and base64. */
export function nearSignedFrom(value: unknown): NearSigned | null {
  if (!value || typeof value !== "object") return null
  const row = value as { accountId?: unknown; publicKey?: unknown; signature?: unknown }
  if (typeof row.accountId !== "string" || row.accountId.length === 0) return null
  const publicKey = publicKeyText(row.publicKey)
  const signature = signatureText(row.signature)
  if (!publicKey || !signature) return null
  return { accountId: row.accountId, publicKey, signature }
}

function meteorClient(): Promise<MeteorConnect> {
  opening ??= openMeteor().catch((error: unknown) => {
    opening = null
    throw error
  })
  return opening
}

export async function meteorSignIn(): Promise<string> {
  const meteor = await meteorClient()
  const action = await meteor.createAction({
    id: "near::sign_in",
    input: { target: { blockchain: "near", network: "testnet" } },
  })
  const account = await action.promptForExecution()
  const accountId = account?.identifier?.accountId
  if (!accountId) throw new Error("Sign-in failed")
  return accountId
}

export async function meteorSignMessage(accountId: string, issued: number, nonce: Uint8Array): Promise<NearSigned> {
  const meteor = await meteorClient()
  const action = await meteor.createAction({
    id: "near::sign_message",
    input: {
      target: { blockchain: "near", network: "testnet", accountId },
      messageParams: nearSignParams(accountId, issued, nonce),
    },
  })
  const signed = nearSignedFrom(await action.promptForExecution())
  if (!signed || signed.accountId !== accountId) throw new Error("Sign-in failed")
  return signed
}

export async function meteorSignOut(): Promise<void> {
  const meteor = await meteorClient()
  const account = await meteor.getAccount({ blockchain: "near", network: "testnet" })
  if (!account) return
  const action = await meteor.createAction({
    id: "near::sign_out",
    input: { target: account.identifier },
  })
  await action.promptForExecution()
}

async function openMeteor(): Promise<MeteorConnect> {
  await installMeteorBuffer()
  const sdk = await import("@meteorwallet/sdk")
  const meteor = new sdk.MeteorConnect()
  await meteor.initialize({
    storage: sdk.webpage_local_storage,
    mobileBridge: {
      enabled: true,
      partnerMetadata: {
        name: "Quick Market",
        description: "Sign in to Quick Market on NEAR Testnet",
        iconUrl: `${location.origin}/favicon.ico`,
        originUrl: location.origin,
      },
    },
  })
  return meteor
}

function publicKeyText(value: unknown): string | null {
  const text = typeof value === "string" ? value : value && typeof value === "object" && "toString" in value ? String(value) : ""
  const trimmed = text.trim()
  return trimmed.startsWith("ed25519:") ? trimmed : null
}

function signatureText(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value.trim()
  if (value instanceof Uint8Array && value.length === 64) return encodeBase64(value)
  return null
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Meteor's browser build calls Node's `Buffer`, `global`, and `process` while turning a wallet signature into bytes. A development `NODE_ENV` also prints Dev Web and the Dev/Prod switch on the page. */
async function installMeteorBuffer() {
  const host = globalThis as {
    Buffer?: unknown
    global?: unknown
    process?: { env: Record<string, string | undefined> }
    __QUICK_MARKET_NODE_ENV?: string
  }
  host.global ??= host
  host.__QUICK_MARKET_NODE_ENV = "production"
  host.process ??= { env: {} }
  host.process.env.NODE_ENV = "production"
  installMeteorPopupGrace()
  watchMeteorDevControls()
  if (host.Buffer) return
  const { Buffer } = await import("buffer")
  host.Buffer = Buffer
}

type WindowOpen = (url?: string | URL, target?: string, features?: string) => Window | null

let reservedPopup: Window | null = null

/** Open the signature window in this click. Meteor calls `window.open` only after its own awaits, which the browser then blocks. */
export function reserveMeteorPopup(): boolean {
  releaseMeteorPopup()
  const popup = window.open("about:blank", "_blank", "popup=1,width=420,height=760")
  if (!popup) return false
  reservedPopup = popup
  return true
}

export function releaseMeteorPopup() {
  const popup = reservedPopup
  reservedPopup = null
  if (!popup) return
  try {
    if (!popup.closed) popup.close()
  } catch {
    // The browser already dropped the unused window.
  }
}

function takeReservedPopup(url: string): Window | null {
  const popup = reservedPopup
  if (!popup || !METEOR_WALLET_POPUP.test(url)) return null
  reservedPopup = null
  try {
    if (popup.closed) return null
    popup.location.replace(url)
    return popup
  } catch {
    try {
      popup.close()
    } catch {
      // Already gone.
    }
    return null
  }
}

function installMeteorPopupGrace() {
  const current = window.open as WindowOpen & { qmMeteorGrace?: boolean }
  if (current.qmMeteorGrace) return
  const open = window.open.bind(window) as WindowOpen
  const wrapped: WindowOpen & { qmMeteorGrace?: boolean } = (url, target, features) => {
    const reserved = takeReservedPopup(String(url ?? ""))
    const child = reserved ?? open(url, target, features)
    if (!child || !METEOR_WALLET_POPUP.test(String(url ?? ""))) return child
    return graceClosed(child)
  }
  wrapped.qmMeteorGrace = true
  window.open = wrapped as typeof window.open
}

function graceClosed(child: Window): Window {
  let seenClosedAt = 0
  return new Proxy(child, {
    get(target, prop) {
      if (prop === "closed") {
        const next = meteorPopupClosed(target.closed, seenClosedAt, Date.now())
        seenClosedAt = next.seenClosedAt
        return next.closed
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  }) as Window
}

const METEOR_DEV_STYLE = ".platform-button.dev,.dev-mobile-wallet-switch,.dev-mobile-wallet-options{display:none !important}"

function watchMeteorDevControls() {
  const host = window as Window & { __qmMeteorDev?: boolean }
  if (host.__qmMeteorDev) return
  host.__qmMeteorDev = true
  const seen = new WeakSet<ShadowRoot>()
  const hide = (shadow: ShadowRoot) => {
    if (shadow.querySelector("style[data-qm-hide-dev]")) return
    const style = document.createElement("style")
    style.dataset.qmHideDev = "1"
    style.textContent = METEOR_DEV_STYLE
    shadow.appendChild(style)
  }
  const scan = () => {
    for (const node of document.querySelectorAll("meteor-action-ui-overlay, meteor-action-ui-container, meteor-mobile-bridge-panel")) {
      const shadow = node.shadowRoot
      if (!shadow || seen.has(shadow)) continue
      seen.add(shadow)
      hide(shadow)
      new MutationObserver(() => hide(shadow)).observe(shadow, { childList: true, subtree: true })
    }
  }
  scan()
  new MutationObserver(scan).observe(document.body, { childList: true })
}
