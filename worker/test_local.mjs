// Local smoke test for the WBB worker handler (Node 18+ has global fetch).
// Run: node worker/test_local.mjs
// The RPC is read from contracts/.env (ALCHEMY_BSC_RPC preferred, else BSC_RPC_URL);
// nothing is printed that could reveal a key.
import { readFileSync } from "node:fs";
import worker from "./src/index.js";

const envText = readFileSync(new URL("../contracts/.env", import.meta.url), "utf8");
const pick = (k) => (envText.match(new RegExp("^" + k + "=(.*)$", "m")) || [1, ""])[1].trim();
const RPC = pick("ALCHEMY_BSC_RPC") || pick("BSC_RPC_URL") || "https://bsc-dataseed1.bnbchain.org";
console.log("using RPC:", RPC.replace(/[^/]+$/, "***"));

const env = {
  BRAIN_ADDRESS: "0xC33B1a8ad0edC91ac7eC7c09326777CF3Dfaf24B",
  BSC_RPC: RPC,
};

const call = async (path, init) => {
  const res = await worker.fetch(new Request("https://wbb.test" + path, init), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

let r = await call("/api/snapshot");
console.log("snapshot:", r.status, "tick=", r.body.tick, "totalSpikes=", r.body.totalSpikes,
  "V.len=", r.body.V.length, "V[0]=", r.body.V[0], "spikes[0..3]=", r.body.spikes.slice(0, 4),
  "px=", r.body.px, "hx=", r.body.hx, "stateHash=", String(r.body.stateHash).slice(0, 18));
if (r.body.V.length !== 302) throw new Error("V array wrong");

r = await call("/api/events?blocks=1500");
console.log("events:", r.status, JSON.stringify(r.body).slice(0, 300));

r = await call("/api/status");
console.log("status:", r.status, JSON.stringify(r.body).slice(0, 140));
console.log("ALL WORKER SMOKE CHECKS DONE");
