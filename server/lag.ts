export const LAG_MAX_BYTES = 200

export function lagEcho(text: string, recv: number, send: number): string | null {
  if (text.length > LAG_MAX_BYTES) return null
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!body || typeof body !== "object") return null
  const record = body as Record<string, unknown>
  if (record.type !== "lag" || typeof record.t !== "number" || !Number.isFinite(record.t)) return null
  return JSON.stringify({ type: "lag", t: record.t, serverRecv: recv, serverNow: send })
}
