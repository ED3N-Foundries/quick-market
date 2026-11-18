import { createHash, randomBytes } from "node:crypto"
import tls from "node:tls"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const MAX_FRAME = 1_000_000
/** A pinned connect may wait behind the same event-loop stall as the native open arm. */
const PINNED_CONNECT_MS = 10_000

export type FeedHandlers = {
  onOpen: (send: (text: string) => void) => void
  onMessage: (text: string) => void
  onDown: () => void
}

export type FeedConn = {
  close: () => void
}

type Frame = { size: number; opcode: number; fin: boolean; payload: Buffer }

/** Server frames already in `buf`. Returns null when the next frame is incomplete. */
export function readFrame(buf: Buffer): Frame | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const fin = (buf[0] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(MAX_FRAME)) return { size: buf.length, opcode: 8, fin: true, payload: Buffer.alloc(0) }
    len = Number(big)
    offset = 10
  }
  if (len > MAX_FRAME) return { size: buf.length, opcode: 8, fin: true, payload: Buffer.alloc(0) }
  const masked = (buf[1] & 0x80) !== 0
  const maskAt = offset
  if (masked) offset += 4
  if (buf.length < offset + len) return null
  let payload = buf.subarray(offset, offset + len)
  if (masked) {
    const mask = buf.subarray(maskAt, maskAt + 4)
    const copy = Buffer.alloc(len)
    for (let i = 0; i < len; i++) copy[i] = payload[i] ^ mask[i & 3]
    payload = copy
  }
  return { size: offset + len, opcode, fin, payload }
}

const pinnedHosts = new Set<string>()
const addressCache = new Map<string, { ips: string[]; exp: number }>()

/** Only a real certificate/TLS validation failure earns the pinned DNS path. */
const PIN_REASON = /certificate|cert_/i

export function pinHostForFailure(reason: string): boolean {
  return PIN_REASON.test(reason)
}

/** Clear fallback pins after every venue has been unreachable for a while. */
export function resetFeedPins(): void {
  pinnedHosts.clear()
  addressCache.clear()
}

export function failureText(event: unknown): string {
  if (typeof event === "string") return event
  if (!event || typeof event !== "object") return ""
  const row = event as { message?: unknown; reason?: unknown; code?: unknown; error?: unknown }
  const error = row.error
  const cause =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : error
  return [row.message, row.reason, cause, row.code].filter((part) => part != null && part !== "").map(String).join(" ")
}

/**
 * Public trade socket. Uses the platform client first. Only an explicit
 * certificate/TLS validation failure switches the host to public DNS with the
 * real hostname as the TLS server name. Timeouts and ordinary closes retry the
 * native socket instead.
 */
export function openFeed(url: string, handlers: FeedHandlers): FeedConn {
  let current: FeedConn = { close() {} }
  let closed = false
  const host = new URL(url).hostname
  const handoff = () => {
    if (closed) return
    pinnedHosts.add(host)
    current = openPinned(url, handlers, () => closed)
  }
  if (pinnedHosts.has(host)) handoff()
  else current = openNative(url, handlers, handoff)
  return {
    close() {
      closed = true
      current.close()
    },
  }
}

function openNative(url: string, handlers: FeedHandlers, onPin: () => void): FeedConn {
  const ws = new WebSocket(url)
  let opened = false
  let handed = false
  const early = (reason: string) => {
    if (opened || handed) return
    handed = true
    try {
      ws.close()
    } catch {
      /* already closing */
    }
    // A timeout or an ordinary early close retries the native socket. Only a
    // TLS name/certificate mismatch can benefit from pinned DNS addresses.
    if (pinHostForFailure(reason)) onPin()
    else handlers.onDown()
  }
  ws.addEventListener("open", () => {
    if (handed) return
    opened = true
    handlers.onOpen((text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
    })
  })
  ws.addEventListener("message", (event) => {
    if (!handed) handlers.onMessage(String(event.data))
  })
  ws.addEventListener("error", (event) => early(failureText(event)))
  ws.addEventListener("close", (event) => {
    if (handed) return
    if (opened) handlers.onDown()
    else early(failureText(event))
  })
  return {
    close() {
      handed = true
      try {
        ws.close()
      } catch {
        /* already closing */
      }
    },
  }
}

function openPinned(url: string, handlers: FeedHandlers, isClosed: () => boolean): FeedConn {
  const target = new URL(url)
  const port = Number(target.port || 443)
  const hostHeader = port === 443 ? target.hostname : `${target.hostname}:${port}`
  const path = `${target.pathname}${target.search}` || "/"
  let dead = false
  let opened = false
  let sock: tls.TLSSocket | null = null

  const stop = () => {
    dead = true
    sock?.destroy()
  }

  const run = async () => {
    let ips: string[] = []
    try {
      ips = await lookup(target.hostname)
    } catch {
      ips = []
    }
    if (dead || isClosed()) return
    for (const ip of ips.slice(0, 4)) {
      if (dead || isClosed()) return
      const up = await connectIp(ip)
      if (up) return
    }
    if (!dead && !isClosed() && !opened) handlers.onDown()
  }

  const connectIp = (ip: string) =>
    new Promise<boolean>((resolve) => {
      if (dead || isClosed()) return resolve(false)
      const key = randomBytes(16).toString("base64")
      const expect = createHash("sha1").update(key + GUID).digest("base64")
      const socket = tls.connect({
        host: ip,
        port,
        servername: target.hostname,
        rejectUnauthorized: true,
      })
      sock = socket
      let header = Buffer.alloc(0)
      let buf = Buffer.alloc(0)
      let upgraded = false
      let settled = false
      const text: Buffer[] = []
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (!ok) socket.destroy()
        resolve(ok)
      }
      timer = setTimeout(() => settle(false), PINNED_CONNECT_MS)
      socket.on("error", () => {
        if (!upgraded) settle(false)
        else if (!dead) {
          dead = true
          handlers.onDown()
        }
      })
      socket.on("secureConnect", () => {
        if (dead || isClosed()) {
          socket.destroy()
          settle(false)
          return
        }
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        )
      })
      const send = (payload: string) => {
        if (!socket.destroyed) socket.write(clientFrame(0x1, Buffer.from(payload)))
      }
      socket.on("data", (chunk: Buffer) => {
        if (!upgraded) {
          header = header.length ? Buffer.concat([header, chunk]) : chunk
          const end = header.indexOf("\r\n\r\n")
          if (end < 0) return
          const head = header.subarray(0, end).toString("latin1")
          const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(head)?.[1]?.trim()
          if (!/^HTTP\/1\.[01] 101/.test(head) || accept !== expect) {
            socket.destroy()
            settle(false)
            return
          }
          upgraded = true
          opened = true
          settle(true)
          const rest = header.subarray(end + 4)
          header = Buffer.alloc(0)
          handlers.onOpen(send)
          if (rest.length) consume(rest)
          return
        }
        consume(chunk)
      })
      socket.on("close", () => {
        if (!settled) settle(false)
        else if (upgraded && !dead) {
          dead = true
          handlers.onDown()
        }
      })

      const consume = (chunk: Buffer) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
        for (;;) {
          const frame = readFrame(buf)
          if (!frame) break
          buf = buf.subarray(frame.size)
          if (frame.opcode === 8) {
            socket.end()
            return
          }
          if (frame.opcode === 9) {
            socket.write(clientFrame(0xa, frame.payload))
            continue
          }
          if (frame.opcode === 1 || frame.opcode === 0) {
            text.push(frame.payload)
            if (!frame.fin) continue
            const message = Buffer.concat(text).toString("utf8")
            text.length = 0
            handlers.onMessage(message)
          }
        }
        if (buf.length === 0) buf = Buffer.alloc(0)
      }
    })

  void run()
  return {
    close() {
      dead = true
      sock?.destroy()
    },
  }
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]
  const header = payload.length < 126 ? Buffer.alloc(2) : payload.length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
  header[0] = 0x80 | opcode
  if (payload.length < 126) header[1] = 0x80 | payload.length
  else if (payload.length < 65536) {
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

async function lookup(host: string): Promise<string[]> {
  const hit = addressCache.get(host)
  if (hit && hit.exp > Date.now()) return hit.ips
  const headers = { accept: "application/dns-json" }
  const pull = async (type: string) => {
    const res = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers,
      signal: AbortSignal.timeout(1_500),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { Answer?: { type: number; data: string }[] }
    return body.Answer ?? []
  }
  const [aaaa, a] = await Promise.all([pull("AAAA"), pull("A")])
  const ips = [
    ...aaaa.filter((row) => row.type === 28 && row.data).map((row) => row.data),
    ...a.filter((row) => row.type === 1 && row.data).map((row) => row.data),
  ]
  if (ips.length) addressCache.set(host, { ips, exp: Date.now() + 60_000 })
  return ips
}
