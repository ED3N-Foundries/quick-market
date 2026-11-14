import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

type Env = Record<string, string | undefined>

type Child = ReturnType<typeof Bun.spawn>

const root = resolve(import.meta.dir, "..")

export function demoPorts(env: Env) {
  const raw = env.DEMO_PORT_OFFSET?.trim() || "0"
  const offset = /^\d+$/.test(raw) ? Number(raw) : -1
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 50_000) throw new Error("DEMO_PORT_OFFSET must be an integer from 0 to 50000")
  return { api: 3001 + offset, internal: 3002 + offset, agent: 3011 + offset, health: 3101 + offset, web: 5173 + offset }
}

export function marketEnv(env: Env): Env {
  const ports = demoPorts(env)
  return {
    ...env,
    CHAIN: "near-testnet",
    NODE_ENV: "development",
    TREASURY_PRIVATE_KEY: "",
    USDC_ADDRESS: "",
    PORT: String(ports.api),
    INTERNAL_PORT: String(ports.internal),
    API_URL: `http://127.0.0.1:${ports.api}`,
    QM_WEB_PORT: String(ports.web),
    QM_PROXY_TARGET: `http://127.0.0.1:${ports.api}`,
  }
}

export function agentEnv(env: Env): Env {
  const ports = demoPorts(env)
  return {
    ...env,
    CHAIN: "near-testnet",
    API_URL: `http://127.0.0.1:${ports.api}`,
    DB_PATH: "data/quick-market-agent.sqlite",
    AGENT_SPLIT_BASE: "0",
    AGENT_SPLIT_NEAR: "100",
    STATS_PORT: String(ports.agent),
    SWARM_PIN: env.SWARM_PIN?.trim() || "30",
  }
}

export function healthEnv(env: Env): Env {
  const ports = demoPorts(env)
  return {
    ...env,
    PORT: String(ports.health),
    TARGET_URL: `http://127.0.0.1:${ports.api}`,
    INTERNAL_URL: `http://127.0.0.1:${ports.internal}`,
    AGENT_URL: `http://127.0.0.1:${ports.agent}`,
    RPC_URL: env.NEAR_RPC_1?.trim().split(/\s+/)[0] || "",
    DOCKER_SOCK: "",
  }
}

export function nearConfigProblem(env: Env): string | null {
  const missing = ["NEAR_TREASURY_PRIVATE_KEY", "TOKEN_ACCOUNT"].filter((name) => !env[name]?.trim())
  if (missing.length === 0) return null
  return `Missing ${missing.join(" and ")}. Run:\n  cp .env.example .env\n  CHAIN=near-testnet bun run treasury\n  CHAIN=near-testnet bun run token`
}

function repoProblem(path: string, name: string): string | null {
  if (existsSync(join(path, "package.json")) && existsSync(join(path, "node_modules"))) return null
  return `Missing ${name} or its dependencies. From ${dirname(root)} run:\n  git clone https://github.com/ED3N-Foundries/${name}.git\n  cd ${name} && bun install`
}

async function pipe(name: string, stream: ReadableStream<Uint8Array>, write: (text: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) write(`[${name}] ${line}\n`)
  }
  buffered += decoder.decode()
  if (buffered) write(`[${name}] ${buffered}\n`)
}

function launch(name: string, cwd: string, args: string[], env: Env): Child {
  const child = Bun.spawn(["bun", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  })
  void pipe(name, child.stdout, (text) => process.stdout.write(text))
  void pipe(name, child.stderr, (text) => process.stderr.write(text))
  return child
}

async function main() {
  const configProblem = nearConfigProblem(process.env)
  if (configProblem) throw new Error(configProblem)
  if (!existsSync(join(root, "contracts/near/res/quick_market.wasm"))) {
    throw new Error("Missing contracts/near/res/quick_market.wasm. Use the current quick-market submission branch.")
  }
  const agentRoot = resolve(root, "../quick-market-agent")
  const healthRoot = resolve(root, "../quick-market-health")
  const problem = repoProblem(agentRoot, "quick-market-agent") ?? repoProblem(healthRoot, "quick-market-health")
  if (problem) throw new Error(problem)

  const children = [
    launch("market", root, ["run", "dev"], marketEnv(process.env)),
    launch("agent", agentRoot, ["run", "agent"], agentEnv(process.env)),
    launch("health", healthRoot, ["run", "dev"], healthEnv(process.env)),
  ]
  const ports = demoPorts(process.env)
  console.log(`Quick Market: http://127.0.0.1:${ports.web}`)
  console.log(`Health:       http://127.0.0.1:${ports.health}`)
  console.log(`Agent stats:  http://127.0.0.1:${ports.agent}/api/health`)
  console.log(`Press Ctrl+C to stop the local demo. Ports ${ports.api}, ${ports.internal}, ${ports.agent}, ${ports.health}, and ${ports.web} must be free.`)

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    for (const child of children) child.kill()
    const exited = Promise.all(children.map((child) => child.exited))
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000))
    await Promise.race([exited, timeout])
    for (const child of children) if (child.exitCode === null) child.kill(9)
  }
  process.on("SIGINT", () => {
    void stop().then(() => process.exit(0))
  })
  process.on("SIGTERM", () => {
    void stop().then(() => process.exit(0))
  })

  const result = await Promise.race(
    children.map(async (child, index) => ({ name: ["market", "agent", "health"][index], code: await child.exited })),
  )
  if (!stopping) {
    console.error(`[demo] ${result.name} exited with code ${result.code}; stopping the other processes.`)
    await stop()
  }
  process.exit(result.code ?? 1)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[demo] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  })
}
