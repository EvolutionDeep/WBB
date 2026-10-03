// Local smoke test for the WBB worker handler (Node 18+ has global fetch).
// Run: node worker/test_local.mjs
// The RPC is read from contracts/.env (ALCHEMY_BSC_RPC preferred, else BSC_RPC_URL);
// nothing is printed that could reveal a key.
//
// COST NOTE: /api/snapshot without a daemon push to read from is a full rebuild,
// 1,217 eth_calls -- about 121k compute units when the metered gateway leads. Set
// LOCAL_RPC=public to point the worker at the free nodes for this run, or
// LOCAL_SKIP_SNAPSHOT=1 to skip that endpoint and keep the smoke essentially free.
import { readFileSync } from "node:fs";
import worker from "./src/index.js";

const envText = readFileSync(new URL("../contracts/.env", import.meta.url), "utf8");
const pick = (k) => (envText.match(new RegExp("^" + k + "=(.*)$", "m")) || [1, ""])[1].trim();
const METERED = pick("ALCHEMY_BSC_RPC") || pick("BSC_RPC_URL");
const RPC = process.env.LOCAL_RPC === "public" ? "" : METERED || "https://bsc-dataseed1.bnbchain.org";
console.log("gateway:", RPC ? RPC.replace(/[^/]+$/, "***") : "(free dataseeds only)");

const env = {
  // the live WormBrainV2; the reversed 0x1817... brain is immutable history and must
  // never be the default anything is checked against
  BRAIN_ADDRESS: "0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3",
  BSC_RPC: RPC,
};

const call = async (path, init) => {
  const res = await worker.fetch(new Request("https://wbb.test" + path, init), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

if (process.env.LOCAL_SKIP_SNAPSHOT !== "1") {
  const r = await call("/api/snapshot");
  console.log("snapshot:", r.status, "tick=", r.body.tick, "totalSpikes=", r.body.totalSpikes,
    "readBlock=", r.body.readBlock,
    "V.len=", r.body.V.length, "V[0]=", r.body.V[0], "spikes[0..3]=", r.body.spikes.slice(0, 4),
    "px=", r.body.px, "hx=", r.body.hx, "stateHash=", String(r.body.stateHash).slice(0, 18));
  if (r.body.V.length !== 302) throw new Error("V array wrong");
  if (!Number.isInteger(r.body.readBlock)) throw new Error("snapshot not pinned to a block");
  if (String(r.body.address).toLowerCase() !== env.BRAIN_ADDRESS.toLowerCase()) throw new Error("snapshot read the wrong brain");
} else {
  console.log("snapshot: skipped (LOCAL_SKIP_SNAPSHOT=1)");
}

const ev = await call("/api/events?blocks=1500");
console.log("events:", ev.status, JSON.stringify(ev.body).slice(0, 300));

// the browser's read proxy: a scalar, then a small batch, then a method it must refuse
const head = await call("/api/rpc", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
});
const headNum = Number(BigInt(head.body.result || "0x0"));
console.log("rpc head:", head.status, headNum.toLocaleString());
if (!Number.isInteger(headNum) || headNum <= 0) throw new Error("proxy could not read the head");

const bat = await call("/api/rpc", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify([
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: env.BRAIN_ADDRESS, data: "0x3eaf5d9f" }, "latest"] },
    { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] },
    { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x00"] },
  ]),
});
if (!Array.isArray(bat.body) || bat.body.length !== 3) throw new Error("batch answer is not 3 items");
const tickWord = bat.body.find((x) => x.id === 0).result;
const refused = bat.body.find((x) => x.id === 2).error;
console.log("rpc batch: tick =", tickWord, "| refused write =", refused && refused.code);
if (refused.code !== -32601) throw new Error("proxy did not refuse a transaction method");
if (!bat.body.find((x) => x.id === 1).result) throw new Error("proxy could not read a block");

const denied = await call("/api/rpc", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://evil.example" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
});
console.log("rpc foreign origin:", denied.status);
if (denied.status !== 403) throw new Error("proxy served another site's origin");

const st = await call("/api/status");
console.log("status:", st.status, JSON.stringify(st.body).slice(0, 140));
console.log("ALL WORKER SMOKE CHECKS PASSED");
