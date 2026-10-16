import { CONTROL_PATH, STATUS_PATH, readJson, writeJsonAtomic } from "./store"
import {
  parseControl,
  parseStatus,
  shortAddress,
  formatEth,
  formatUsdc,
  summarize,
  applyCommand,
  type ControlFile,
  type StatusFile,
} from "./status"

export function handleKey(input: {
  key: string
  selected: number
  status: StatusFile | null
  control: ControlFile
  commandId: string
}): { control: ControlFile; selected: number; quit: boolean } {
  const rows = input.status?.rows ?? []
  const last = Math.max(0, rows.length - 1)
  if (input.key === "q" || input.key === "\u0003") return { control: input.control, selected: input.selected, quit: true }
  if (rows.length === 0) return { control: input.control, selected: 0, quit: false }
  if (input.key === "\u001b[A" || input.key === "k") {
    return { control: input.control, selected: Math.max(0, input.selected - 1), quit: false }
  }
  if (input.key === "\u001b[B" || input.key === "j") {
    return { control: input.control, selected: Math.min(last, input.selected + 1), quit: false }
  }
  const selected = Math.min(input.selected, last)
  const row = rows[selected]
  if (!row) return { control: input.control, selected, quit: false }
  const addresses = rows.map((item) => item.address)
  if (input.key === "p") {
    const paused = input.control.paused.includes(row.address.toLowerCase())
    return {
      control: applyCommand(
        input.control,
        { id: input.commandId, action: paused ? "resume" : "pause", address: row.address },
        addresses,
      ),
      selected,
      quit: false,
    }
  }
  if (input.key === "P") {
    const allPaused = addresses.every((address) => input.control.paused.includes(address.toLowerCase()))
    return {
      control: applyCommand(input.control, { id: input.commandId, action: allPaused ? "resume-all" : "pause-all" }, addresses),
      selected,
      quit: false,
    }
  }
  if (input.key === "f" || input.key === "s") {
    return {
      control: applyCommand(
        input.control,
        { id: input.commandId, action: input.key === "f" ? "faucet" : "relogin", address: row.address },
        addresses,
      ),
      selected,
      quit: false,
    }
  }
  return { control: input.control, selected, quit: false }
}

function pad(text: string, width: number): string {
  const value = [...text].length > width ? [...text].slice(0, width).join("") : text
  return value.padEnd(width)
}

export function renderDashboard(status: StatusFile | null, selected: number, columns = 100, now = Date.now()): string {
  if (!status) {
    return ["Waiting for bun run agent.", "", "q closes this dashboard. The agent keeps running."].join("\n")
  }
  const totals = summarize(status.rows)
  const quiet = now - status.updatedAt > 15_000 ? " · agent quiet" : ""
  const header = [
    `${status.chain} · ${totals.wallets} wallets · ${totals.paused} paused · ${totals.stuck} stuck`,
    `ledger ${formatUsdc(totals.ledgerMicros)} · in ${formatUsdc(totals.inflowMicros)} · out ${formatUsdc(totals.outflowMicros)}${quiet}`,
  ].join("\n")
  const head = [
    "",
    pad("#", 3),
    pad("address", 13),
    pad("ETH", 10),
    pad("chain", 10),
    pad("ledger", 10),
    pad("in", 10),
    pad("out", 10),
    pad("phase", 9),
    pad("bet", 12),
    "detail",
  ].join(" ")
  const selectedIndex = status.rows.length === 0 ? 0 : Math.min(selected, status.rows.length - 1)
  const body = status.rows.map((row, index) => {
    const mark = index === selectedIndex ? ">" : " "
    const bet = row.roundId === null ? "-" : `${row.roundId}${row.side ? ` ${row.side}` : ""}`
    const detail = row.stuck ?? row.error ?? ""
    const line = [
      pad(String(row.index), 3),
      pad(shortAddress(row.address), 13),
      pad(formatEth(row.ethWei), 10),
      pad(formatUsdc(Number(row.chainUsdcMicros)), 10),
      pad(formatUsdc(row.ledgerMicros), 10),
      pad(formatUsdc(row.inflowMicros), 10),
      pad(formatUsdc(row.outflowMicros), 10),
      pad(row.phase, 9),
      pad(bet, 12),
      detail,
    ].join(" ")
    const text = `${mark}${line}`
    return text.length > columns ? text.slice(0, columns) : text
  })
  const help = "↑↓ or j/k select   p pause/resume   P all   f faucet   s sign in   q quit"
  return [header, "", head, ...body, "", help].join("\n")
}

function acknowledge(control: ControlFile, status: StatusFile): ControlFile {
  const applied = new Set(status.applied)
  const queue = control.queue.filter((item) => !applied.has(item.id))
  if (queue.length === control.queue.length) return control
  return { ...control, queue }
}

async function main() {
  let control = parseControl(readJson(CONTROL_PATH))
  let status = parseStatus(readJson(STATUS_PATH))
  let selected = 0
  let commandSeq = 0
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

  const draw = () => {
    const screen = renderDashboard(status, selected, process.stdout.columns || 100)
    if (!interactive) {
      console.log(screen)
      return
    }
    process.stdout.write(`\x1b[H\x1b[2J${screen}\n`)
  }

  const persist = () => writeJsonAtomic(CONTROL_PATH, control)

  if (status) {
    const acked = acknowledge(control, status)
    if (acked !== control) {
      control = acked
      if (interactive) persist()
    }
  }

  if (!interactive) {
    draw()
    return
  }

  process.stdout.write("\x1b[?1049h\x1b[?25l")
  process.stdin.setRawMode(true)
  process.stdin.resume()
  const restore = () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l")
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
  const shutdown = () => {
    restore()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.stdin.on("end", shutdown)
  const onKey = (key: string) => {
    const next = handleKey({
      key,
      selected,
      status,
      control,
      commandId: `${Date.now()}-${commandSeq++}`,
    })
    const changed = next.control !== control
    control = next.control
    selected = next.selected
    if (changed) persist()
    if (next.quit) shutdown()
    else draw()
  }
  process.stdin.on("data", (chunk) => {
    const text = chunk.toString("utf8")
    for (let i = 0; i < text.length; i++) {
      if (text.startsWith("\u001b[A", i) || text.startsWith("\u001b[B", i)) {
        onKey(text.slice(i, i + 3))
        i += 2
      } else {
        onKey(text[i]!)
      }
    }
  })
  const timer = setInterval(() => {
    const next = parseStatus(readJson(STATUS_PATH))
    if (next) {
      status = next
      const acked = acknowledge(control, status)
      if (acked !== control) {
        control = acked
        persist()
      }
    }
    draw()
  }, 1_000)
  timer.unref?.()
  draw()
  await new Promise(() => {})
}

if (import.meta.main) await main()
