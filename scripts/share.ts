const tunnel = Bun.spawn(
  ["cloudflared", "tunnel", "--config", `${process.env.HOME}/.cloudflared/config.yml`, "--no-autoupdate", "run", "qm-laptop"],
  { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
)

const dev = Bun.spawn(["bun", "run", "server/dev.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: { ...process.env, QM_TUNNEL: "1" },
})

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  tunnel.kill()
  dev.kill()
}

process.on("SIGINT", () => {
  shutdown()
  process.exit(0)
})
process.on("SIGTERM", () => {
  shutdown()
  process.exit(0)
})

const code = await Promise.race([tunnel.exited, dev.exited])
shutdown()
process.exit(code ?? 0)
