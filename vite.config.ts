import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  root: "web",
  envPrefix: ["VITE_", "CHAIN"],
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:3001", ws: true },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
})
