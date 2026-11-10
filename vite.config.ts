import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { brandHead } from "./brand/meta.ts"

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
  ],
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
