import type { ChainKey } from "../shared/chain"
import type { You } from "../shared/stream"

export type AccountNotice = { serverNow: number; yous: You[] }

/** One MCP connection that can take a private account notification. */
export type PushSession = {
  id: string
  chain: ChainKey
  addresses(): readonly string[]
  fingerprint(address: string): string | undefined
  remember(address: string, fingerprint: string): void
  /** True when the notification was accepted onto the session stream. */
  notify(body: AccountNotice): boolean
}

const sessions = new Set<PushSession>()

export function addPushSession(session: PushSession): () => void {
  sessions.add(session)
  return () => {
    sessions.delete(session)
  }
}

export function pushSessions(chain: ChainKey): PushSession[] {
  const found: PushSession[] = []
  for (const session of sessions) {
    if (session.chain === chain) found.push(session)
  }
  return found
}
