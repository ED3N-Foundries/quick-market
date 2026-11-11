import { readFileSync } from "node:fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { brandHead } from "./brand/meta.ts"

/** Vite's dev prebundle folds `process.env.NODE_ENV === "development"` to true inside Meteor, which renders Dev Web and the Dev/Prod switch. */
function meteorProductionEnv(code: string): string | null {
  if (!code.includes("process.env.NODE_ENV")) return null
  return code.replaceAll("process.env.NODE_ENV", "globalThis.__QUICK_MARKET_NODE_ENV")
}

function meteorSdkSource(id: string): boolean {
  return id.includes("@meteorwallet/sdk/dist/index.js")
}

export default defineConfig({
  root: "web",
  envPrefix: "VITE_",
  plugins: [
    react(),
    {
      name: "qm-brand",
      transformIndexHtml: {
        order: "pre",
        handler(html: string) {
          if (html.includes('property="og:image"')) return html
          return html.replace("</head>", `${brandHead()}\n  </head>`)
        },
      },
    },
    {
      name: "qm-tunnel",
      transformIndexHtml: {
        order: "post",
        handler(html: string) {
          if (!process.env.QM_TUNNEL) return html
          return html.replace(/\s*<script type="module" src="\/@vite\/client"><\/script>/, "")
        },
      },
    },
    {
      name: "qm-meteor-production",
      enforce: "pre",
      transform(code: string, id: string) {
        if (!meteorSdkSource(id)) return
        return meteorProductionEnv(code)
      },
    },
  ],
  optimizeDeps: {
    rolldownOptions: {
      plugins: [
        {
          name: "qm-meteor-production",
          load(id: string) {
            if (!meteorSdkSource(id)) return null
            return meteorProductionEnv(readFileSync(id, "utf8"))
          },
          transform(code: string, id: string) {
            if (!meteorSdkSource(id)) return null
            return meteorProductionEnv(code)
          },
        },
      ],
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ["qm-aurora-m4.ed3n.com", "qm.ed3n.com"],
    hmr: process.env.QM_TUNNEL ? false : undefined,
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
