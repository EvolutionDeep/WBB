import { defineConfig } from "vite";

// In dev, /api is proxied to the local worker bridge (node worker/dev_server.mjs
// or `wrangler dev`, both on 8787/8790). Point VITE_API_TARGET at a deployed
// worker URL to fetch live chain data through Cloudflare instead.
export default defineConfig({
  server: {
    host: "127.0.0.1", // bind IPv4 explicitly (some environments cannot reach ::1)
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://127.0.0.1:8790",
        changeOrigin: true,
      },
    },
  },
});
