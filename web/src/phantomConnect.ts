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
