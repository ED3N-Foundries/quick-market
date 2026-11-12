export const SESSION_MS = 7 * 24 * 60 * 60 * 1000
export const LOGIN_SKEW_MS = 2 * 60 * 1000

export function loginMessage(chainId: number, address: string, issued: number): string {
  return `quick-market\nchainId: ${chainId}\naddress: ${address.toLowerCase()}\nissued: ${issued}`
}

export function nearLoginMessage(account: string, issued: number): string {
  return `quick-market\nchain: near-testnet\naccount: ${account}\nissued: ${issued}`
}
