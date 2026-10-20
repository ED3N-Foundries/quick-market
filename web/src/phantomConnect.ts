export type ConnectKind = "modal" | "deeplink"

/** Mobile browsers without an injected Phantom get the browse link. The modal has no button there. */
export function connectKind(input: { mobile: boolean; injected: boolean }): ConnectKind {
  return input.mobile && !input.injected ? "deeplink" : "modal"
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
