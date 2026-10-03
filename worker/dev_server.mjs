/**
 * Local dev bridge: runs the worker's fetch handler on plain Node (>=18) so
 * the frontend can be developed without installing wrangler. Reads secrets
 * from contracts/.env (git-ignored) exactly like the deployed worker would.
 *
 * Usage:  node dev_server.mjs           # listens on :8790
 *         PORT=8800 node dev_server.mjs
 * Production deploys use `npx wrangler deploy` instead; this file is dev-only.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import worker from "./src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* missing .env just means fewer endpoints */ }
  return out;
}

const dotenv = loadEnvFile(join(here, "..", "contracts", ".env"));

// In-memory stand-in for the Cloudflare KV binding (WBB_STORE, the shared
// snapshot/event cache), so the dev bridge behaves exactly like the deployed
// read-only worker.
function makeKV() {
  const m = new Map();
  return {
    async put(k, v) { m.set(String(k), String(v)); },
    async get(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    async delete(k) { m.delete(String(k)); },
    async list({ limit = 1000 } = {}) {
      return { keys: [...m.keys()].slice(0, limit).map((name) => ({ name })) };
    },
  };
}
const kv = makeKV();

const env = {
  BRAIN_ADDRESS: "0xC33B1a8ad0edC91ac7eC7c09326777CF3Dfaf24B",
  WBB_STORE: kv,
  // The metered gateway leads, exactly like the deployed worker: it answers the reads
  // the free dataseeds refuse. Opt out of spending compute units locally with
  // BSC_RPC=public, or point at another endpoint with BSC_RPC=<url>.
  BSC_RPC:
    process.env.BSC_RPC === "public"
      ? ""
      : process.env.BSC_RPC || dotenv.ALCHEMY_BSC_RPC || "",
  DAEMON_KEY: process.env.DAEMON_KEY || dotenv.DAEMON_KEY || "",
};

const port = Number(process.env.PORT || 8790);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let body;
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body,
  });
  const response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, () => {
  const shown = env.BSC_RPC ? env.BSC_RPC.replace(/[^/]+$/, "***") : "(public dataseeds)";
  console.log(`wbb worker dev bridge on http://localhost:${port}`);
  console.log(`RPC: ${shown}  daemon key: ${env.DAEMON_KEY ? "set" : "ABSENT"}`);
});
