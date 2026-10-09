export {}

const server = Bun.spawn(["bun", "--hot", "server/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: { ...process.env, PORT: process.env.PORT ?? "3001" },
})

const web = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
})

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  server.kill()
  web.kill()
}

process.on("SIGINT", () => {
  shutdown()
  process.exit(0)
})
process.on("SIGTERM", () => {
  shutdown()
  process.exit(0)
})

const code = await Promise.race([server.exited, web.exited])
shutdown()
process.exit(code ?? 0)
