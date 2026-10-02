// gen_replay_data.mjs — build frontend/public/data/replay.json: a frame-per-
// heartbeat recording of the worm's historical on-chain state.
//
// For every Advanced event row in worm/node/life_log.csv the script reads the
// brain's state AT THAT EVENT BLOCK from the archive endpoint configured as
// ALCHEMY_BSC_RPC in contracts/.env (306 batched eth_call per frame: V(0..301)
// plus px,py,hx,hy). Values are quantized for display only:
//   V    -> signed int8 of 127 * V / V_THRESH (the ±V_THRESH viewer display band)
//   pose -> signed int16 of value / 1024 (Q10 body units)
// Nothing is simulated or interpolated: every frame is a replayed on-chain fact.
// The archive URL contains a key; it is read from disk and never printed.
//
// COST GUARDS (learned the hard way: a full rebuild burned ~24M compute units):
//   - INCREMENTAL: frames already present in replay.json are never refetched,
//     a refresh run only captures heartbeats newer than the last frame;
//   - a metered archive endpoint (ALCHEMY_BSC_RPC) is used ONLY when the run
//     is explicitly opted in with --allow-metered; without it the script runs
//     against free gateways and refuses archive-block reads it cannot serve.
//
// Usage: node scripts/gen_replay_data.mjs [--allow-metered]   (run from anywhere)

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { ethers } = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "node_modules", "ethers"));

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN = "0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3";
const V_THRESH = 650117n;           // Q20 threshold, same constant the viewer uses
const SCALE = 1048576n;             // Q20
const N = 302;
const THROTTLE_MS = 280;            // free tiers throttle hard; steady beats fast

function envUrl() {
  const line = readFileSync(path.join(ROOT, "contracts", ".env"), "utf8")
    .split(/\r?\n/).find((l) => l.startsWith("ALCHEMY_BSC_RPC=")) || "";
  return line.slice("ALCHEMY_BSC_RPC=".length).trim().replace(/^["']|["']$/g, "");
}
// free public gateway: fine for latest-state reads, no per-call metering
const PUBLIC_RPC = "https://bsc-rpc.publicnode.com";
const ALLOW_METERED = process.argv.includes("--allow-metered");
const RPC = ALLOW_METERED ? (envUrl() || PUBLIC_RPC) : PUBLIC_RPC;
if (ALLOW_METERED && envUrl() && RPC !== PUBLIC_RPC) {
  console.error(`WARNING: running against a METERED archive endpoint; each historical eth_call costs compute units (~100-200). Estimated cost of a FULL rebuild: ~${(500 * 306 * 150 / 1e6).toFixed(1)}M CU.`);
}

const iface = new ethers.Interface([
  "function V(uint256) view returns (int256)",
  "function px() view returns (int256)",
  "function py() view returns (int256)",
  "function hx() view returns (int256)",
  "function hy() view returns (int256)",
]);
const SEL = {
  V: iface.getFunction("V").selector,
  px: iface.getFunction("px").selector,
  py: iface.getFunction("py").selector,
  hx: iface.getFunction("hx").selector,
  hy: iface.getFunction("hy").selector,
};

function word(i) { return i.toString(16).padStart(64, "0"); }

function toInt8Hex(v) {
  const q = Math.round((Number(v) * 127) / Number(V_THRESH));
  const c = Math.max(-127, Math.min(127, q));
  return ((c + 256) & 0xff).toString(16).padStart(2, "0");
}
function toInt16Hex(v) {
  const q = Math.round((Number(v) * 1024) / Number(SCALE));
  const c = Math.max(-32767, Math.min(32767, q));
  return ((c + 65536) & 0xffff).toString(16).padStart(4, "0");
}

async function batch(reqs) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(reqs),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error((j && j.error && j.error.message) || "not an array");
  const map = new Map(j.map((x) => [x.id, x.result]));
  if (reqs.some((q) => typeof map.get(q.id) !== "string")) throw new Error("missing results");
  return (id) => map.get(id);
}

async function main() {
  const dest = path.join(ROOT, "frontend", "public", "data", "replay.json");
  const csv = readFileSync(path.join(ROOT, "worm", "node", "life_log.csv"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("tick"));
  const rows = csv.map((l) => l.split(",")).map(([t, b, ts, tx, fired, spikes]) =>
    ({ tick: +t, block: +b, ts, fired: +fired, spikes: +spikes }));
  console.log(`life_log has ${rows.length} heartbeats (tick ${rows[0]?.tick} -> ${rows.at(-1)?.tick})`);

  // INCREMENTAL: reuse every frame already captured; only missing ticks are fetched
  let prior = { meta: null, frames: [] };
  try { prior = JSON.parse(readFileSync(dest, "utf8")); } catch { /* first run */ }
  const have = new Set(prior.frames.map((f) => f.t));
  const todo = rows.filter((r) => !have.has(r.tick));
  const frames = prior.frames.filter((f) => rows.some((r) => r.tick === f.t));
  console.log(`${have.size} frames already on disk, ${todo.length} new to capture`);
  if (!todo.length) { console.log("nothing to do, replay.json is current"); return; }
  const metered = RPC !== PUBLIC_RPC;
  if (metered) console.error(`est. cost of this run: ~${(todo.length * 306 * 150 / 1e6).toFixed(2)}M compute units (metered endpoint)`);
  else console.error("note: free gateway may reject historical blocks; if frames fail, re-run with --allow-metered knowingly");

  async function capture(r, attempts = 3, base = 800) {
    const reqs = [];
    for (let i = 0; i < N; i++) reqs.push({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: BRAIN, data: SEL.V + word(i) }, "0x" + r.block.toString(16)] });
    for (const [id, name] of [[N, "px"], [N + 1, "py"], [N + 2, "hx"], [N + 3, "hy"]])
      reqs.push({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: BRAIN, data: SEL[name] }, "0x" + r.block.toString(16)] });
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const get = await batch(reqs);
        let vhex = "";
        for (let i = 0; i < N; i++) {
          vhex += toInt8Hex(iface.decodeFunctionResult("V", get(i))[0]);
        }
        const pose = ["px", "py", "hx", "hy"].map((n, k) => toInt16Hex(iface.decodeFunctionResult(n, get(N + k))[0])).join("");
        return { t: r.tick, b: r.block, ts: r.ts, fired: r.fired, spikes: r.spikes, v: vhex, pose };
      } catch (e) {
        if (attempt === attempts - 1) {
          failed++;
          console.error(`tick ${r.tick} @ block ${r.block}: ${e.message}`);
          return null;
        }
        await new Promise((res) => setTimeout(res, base * (attempt + 1)));
      }
    }
    return null;
  }

  // four frames in flight: well under free-tier concurrency, ~4x faster
  let failed = 0;
  const missed = [];
  for (let k = 0; k < todo.length; k += 4) {
    const got = await Promise.all(todo.slice(k, k + 4).map((r) => capture(r)));
    got.forEach((f, i) => (f ? frames.push(f) : missed.push(todo[k + i])));
    if (k % 100 === 0) console.log(`frame tick=${todo[k].tick} (${frames.length}/${rows.length})`);
    await new Promise((res) => setTimeout(res, THROTTLE_MS));
  }
  // second pass: serial, patient retries for frames the batch gate dropped
  if (missed.length) {
    console.log(`retrying ${missed.length} dropped frames serially…`);
    failed = 0; // recount failures from the retry pass only
    for (const r of missed) {
      const f = await capture(r, 6, 1500);
      if (f) frames.push(f);
      await new Promise((res) => setTimeout(res, THROTTLE_MS));
    }
  }
  frames.sort((a, b) => a.t - b.t);

  const out = {
    meta: {
      source: "WormBrainV2 " + BRAIN,
      generated: new Date().toISOString(),
      frames: frames.length, missing: failed,
      quantV: "signed int8 of 127*V/650117 (display band +/-V_THRESH, gamma applied by the player)",
      quantPose: "signed int16 of value/1024 (Q10 body units), order px,py,hx,hy",
      honesty: "every frame is the on-chain state read at that heartbeat's block; nothing is simulated or interpolated",
    },
    frames,
  };
  writeFileSync(dest, JSON.stringify(out));
  console.log(`wrote ${dest}: ${frames.length} frames, ${failed} missing, ${(JSON.stringify(out).length / 1e6).toFixed(2)} MB`);
}

main();
