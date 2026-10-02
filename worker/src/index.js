/**
 * WBB Worker -- the read/write bridge between the living on-chain brain and the 3D frontend.
 *
 * What it does:
 *   GET  /api/snapshot   aggregated read of WormBrain state (tick, V/gate/stim/spikeCount
 *                        for all 302 neurons, body position/heading, stateHash) with a short
 *                        server-side cache so the browser never fires 900 RPC calls itself.
 *   GET  /api/events     recent Advanced / Stimulated logs from the contract, so the
 *                        frontend can show on-chain history (read-only).
 *   GET  /api/status     cheap health check (contract, tick, cache age).
 *   POST /api/push-snapshot / /api/push-events  daemon-only (X-Daemon-Key) feeds so the
 *                        poll path costs zero extra RPC; the worker only ever READS the chain.
 *
 * Env (wrangler): BRAIN_ADDRESS, BSC_RPC, DAEMON_KEY, WBB_STORE (KV, shared snapshot/events
 * cache across isolates). This worker is a pure read-only bridge: it never enqueues or
 * sends any transaction and holds no private key.
 */

const SEL = {
  V: "0x76cf132b",
  gate: "0x87a99866",
  stim: "0x9ce72e78",
  M: "0xd6c85529",
  spikeCount: "0x4eb642ee",
  tick: "0x3eaf5d9f",
  totalSpikes: "0x3dda081a",
  px: "0x922469eb",
  py: "0xc130b9c6",
  hx: "0x022acf07",
  hy: "0x57c602c4",
  connRoot: "0x851be1c8",
  edgeCount: "0xee8a9fd6",
  stateHash: "0x701da98e",
};

const EV = {
  Advanced: "0xb7496a18e89474c0d4762a4afb060c98a0dc0928ba8e47dad1cba99b601209b9",
  Stimulated: "0x779d0d855bbe3d2772c871993b5828da906f38a7309ad2a7e596ac6730740bd6",
};

const N_NEURONS = 302;
const SNAPSHOT_TTL_S = 30;     // on-chain state only moves on ~300s beats; 1217 eth_calls per rebuild
const EVENTS_TTL_S = 30;       // getLogs is the other metered hot path; cache it too
const DEFAULT_BLOCKS = 400;    // ~20 min of BSC blocks at 3s

// ---- tiny helpers ----

const FALLBACK_RPCS = [
  "https://bsc-dataseed1.bnbchain.org",
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.defibit.io",
];

// Public dataseeds carry the polling load (free, no CU meter); a configured
// BSC_RPC (comma-separated private endpoints) is kept as LAST-resort failover
// so a metered provider is only touched when every public node fails.
const rpcUrls = (env) => [
  ...FALLBACK_RPCS,
  ...(env.BSC_RPC ? env.BSC_RPC.split(",").map((s) => s.trim()).filter(Boolean) : []),
];

const FETCH_TIMEOUT_MS = 12000; // fail fast to the next endpoint, never hang a poll

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-daemon-key",
    },
  });

function toSigned(hexWord) {
  // 32-byte big-endian hex -> JS number, decoding int256 two's complement.
  let v = BigInt(hexWord);
  const MOD = 1n << 256n;
  if (v >= 1n << 255n) v -= MOD;
  const f = Number(v);
  return f; // values are Q20 and far below 2^53, safe as double
}

async function rpc(env, method, params) {
  const urls = rpcUrls(env);
  const start = RR++ % urls.length; // spread singles across endpoints
  let lastErr = new Error("no rpc endpoints");
  for (let k = 0; k < urls.length; k++) {
    const url = urls[(start + k) % urls.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const j = await res.json();
      if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) {
      lastErr = e; // next endpoint: public dataseeds rate-limit per method
    }
  }
  throw lastErr;
}
let RR = 0;

// bounded-concurrency map; used by the serial eth_call fallback so a cold
// snapshot rebuild (1217 getters) finishes in tens of seconds, not minutes
async function poolMap(items, conc, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function rpcBatch(env, calls) {
  // calls: [{to,data}] -> array of hex results, order preserved.
  // Batch JSON-RPC is only attempted against configured PRIVATE endpoints
  // (public dataseeds cap batches at 100 and rate-limit batched eth_call);
  // the public path is concurrent single eth_calls rotated over endpoints.
  const privateUrls = env.BSC_RPC ? env.BSC_RPC.split(",").map((s) => s.trim()).filter(Boolean) : [];
  for (const url of privateUrls) {
    try {
      const out = [];
      for (let off = 0; off < calls.length; off += 100) {
        const chunk = calls.slice(off, off + 100);
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chunk.map((c, i) => ({
            jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"],
          }))),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const j = await res.json();
        if (!Array.isArray(j) || j.length !== chunk.length) throw new Error("bad batch response");
        for (const r of j.slice().sort((a, b) => a.id - b.id)) {
          if (r.error) throw new Error(JSON.stringify(r.error));
          out.push(r.result);
        }
      }
      return out;
    } catch (e) {
      // private endpoint down/limited: fall through to the public pool
    }
  }
  return poolMap(calls, 16, (c) => rpc(env, "eth_call", [{ to: c.to, data: c.data }, "latest"]));
}

const word = (sel, idx) => sel + BigInt.asUintN(256, BigInt(idx)).toString(16).padStart(64, "0");

// ---- snapshot ----

let cache = { at: 0, data: null }; // per-isolate cache; CF gives us seconds-scale reuse

// Daemon-pushed snapshots: the resident node reads the full on-chain state
// once per beat (~300s) and POSTs it here, so the poll path costs ZERO rpc
// calls. A metered provider therefore only ever sees a rebuild when no push
// has arrived (cold start or a dead daemon).
const PUSH_TTL_S = 900;
let pushCache = { at: 0, data: null };

async function buildSnapshot(env) {
  const addr = env.BRAIN_ADDRESS || "0x18174bb0049d43fA75f468a037dfC32899f01dBB";
  const scalars = ["tick", "totalSpikes", "px", "py", "hx", "hy", "connRoot", "edgeCount", "stateHash"];
  const calls = [];
  for (const s of scalars) calls.push({ to: addr, data: SEL[s] });
  const ARRAYS = [["V", SEL.V], ["gate", SEL.gate], ["stim", SEL.stim], ["M", SEL.M], ["spikeCount", SEL.spikeCount]];
  for (const [, sel] of ARRAYS) for (let i = 0; i < N_NEURONS; i++) calls.push({ to: addr, data: word(sel, i) });

  // one logical read of 1519 getters; rpcBatch pools it over public endpoints
  const results = await rpcBatch(env, calls);

  const out = {};
  scalars.forEach((s, i) => {
    const r = results[i];
    out[s] = s === "connRoot" || s === "stateHash" ? r : toSigned(r);
  });
  let p = scalars.length;
  for (const [name, ] of ARRAYS) {
    const arr = new Array(N_NEURONS);
    for (let i = 0; i < N_NEURONS; i++) arr[i] = toSigned(results[p + i]);
    out[name === "spikeCount" ? "spikes" : name] = arr;
    p += N_NEURONS;
  }
  out.q = 1048576; // SCALE, Q20 fixed point of the spec
  out.address = addr;
  return out;
}

async function apiSnapshot(env) {
  const now = Date.now() / 1000;
  if (pushCache.data && now - pushCache.at < PUSH_TTL_S) {
    return json({ ...pushCache.data, cached: true, source: "daemon-push" });
  }
  // memory is per-isolate: a push only lands on ONE of them, so the shared
  // KV copy is what makes daemon-push consistent across the whole edge
  if (env.WBB_STORE) {
    const raw = await env.WBB_STORE.get("snapshot");
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (p && p.data && now - p.at < PUSH_TTL_S) {
          pushCache = { at: p.at, data: p.data };
          return json({ ...p.data, cached: true, source: "daemon-push" });
        }
      } catch { /* corrupt value: fall through to a rebuild */ }
    }
  }
  if (cache.data && now - cache.at < SNAPSHOT_TTL_S) return json({ ...cache.data, cached: true });
  const data = await buildSnapshot(env);
  cache = { at: now, data };
  return json({ ...data, cached: false });
}

async function apiPushSnapshot(env, req) {
  if (!env.DAEMON_KEY || req.headers.get("x-daemon-key") !== env.DAEMON_KEY) return json({ error: "forbidden" }, 403);
  let d;
  try { d = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const okShape =
    Number.isInteger(d.tick) && Number.isInteger(d.totalSpikes) &&
    ["V", "gate", "stim", "M", "spikes"].every((k) => Array.isArray(d[k]) && d[k].length === N_NEURONS);
  if (!okShape) return json({ error: "snapshot shape rejected" }, 400);
  pushCache = { at: Date.now() / 1000, data: d };
  if (env.WBB_STORE) {
    await env.WBB_STORE.put("snapshot", JSON.stringify({ at: pushCache.at, data: d }));
  }
  return json({ pushed: true, tick: d.tick });
}

// ---- events ----

let evCache = { key: "", at: 0, data: null };

// Daemon-pushed event ring: public BSC endpoints refuse eth_getLogs outright
// (and the metered fallback is CU-exhausted), so the resident node decodes the
// logs of ITS OWN receipts (advance) and pushes them here; the browser only ever
// reads this ring to show on-chain history.
let evPush = [];

async function apiPushEvents(env, req) {
  if (!env.DAEMON_KEY || req.headers.get("x-daemon-key") !== env.DAEMON_KEY) return json({ error: "forbidden" }, 403);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const evs = Array.isArray(body.events) ? body.events : [];
  // adopt the shared KV ring first so pushes from different isolates merge
  let ring = evPush;
  if (env.WBB_STORE) {
    const raw = await env.WBB_STORE.get("events");
    if (raw) { try { const kv = JSON.parse(raw); if (Array.isArray(kv) && kv.length) ring = kv; } catch { /* rebuild */ } }
  }
  for (const ev of evs) {
    if (!ev || (ev.kind !== "Advanced" && ev.kind !== "Stimulated") || typeof ev.tx !== "string") continue;
    if (ring.some((x) => x.tx === ev.tx && x.kind === ev.kind && x.idx === ev.idx && x.tick === ev.tick)) continue;
    ring.push(ev);
  }
  if (ring.length > 240) ring = ring.slice(-240);
  evPush = ring;
  if (env.WBB_STORE) await env.WBB_STORE.put("events", JSON.stringify(ring));
  return json({ pushed: evs.length, total: ring.length });
}

async function apiEvents(env, url) {
  const addr = env.BRAIN_ADDRESS || "0x18174bb0049d43fA75f468a037dfC32899f01dBB";
  let blocks = Math.min(2000, parseInt(url.searchParams.get("blocks") || DEFAULT_BLOCKS, 10));
  if (!evPush.length && env.WBB_STORE) {
    const raw = await env.WBB_STORE.get("events");
    if (raw) { try { const kv = JSON.parse(raw); if (Array.isArray(kv)) evPush = kv; } catch { /* ignore */ } }
  }
  if (evPush.length) {
    return json({ count: evPush.length, events: evPush.slice(-120), cached: true, source: "daemon-push" });
  }
  const key = `${addr}:${blocks}`;
  const now = Date.now() / 1000;
  if (evCache.data && evCache.key === key && now - evCache.at < EVENTS_TTL_S) {
    return json({ ...evCache.data, cached: true });
  }
  const latest = BigInt(await rpc(env, "eth_blockNumber", []));
  // public dataseeds throttle eth_getLogs by range; halve until one fits (we only need recent events)
  let logs = null;
  let lastErr = null;
  while (blocks >= 24) {
    const from = "0x" + (latest > BigInt(blocks) ? latest - BigInt(blocks) : 0n).toString(16);
    try {
      logs = await rpc(env, "eth_getLogs", [{ address: addr, fromBlock: from, topics: [[EV.Advanced, EV.Stimulated]] }]);
      break;
    } catch (e) {
      lastErr = e;
      blocks = Math.floor(blocks / 2);
    }
  }
  if (!logs) throw lastErr;
  const evs = logs.map((lg) => {
    const t = lg.topics[0];
    if (t === EV.Stimulated) {
      return {
        kind: "Stimulated",
        block: parseInt(lg.blockNumber, 16),
        tx: lg.transactionHash,
        idx: toSigned(lg.topics[1]),
        amp: toSigned(lg.data),
      };
    }
    return {
      kind: "Advanced",
      block: parseInt(lg.blockNumber, 16),
      tx: lg.transactionHash,
      tick: toSigned(lg.topics[1]),
      fired: toSigned(lg.data.slice(2, 66)),
      totalSpikes: toSigned(lg.data.slice(66, 130)),
    };
  });
  const payload = { count: evs.length, events: evs.slice(-120) };
  evCache = { key, at: Date.now() / 1000, data: payload };
  return json(payload);
}

// ---- router ----

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-daemon-key",
        "max-age": "86400",
      },
    });
    try {
      switch (url.pathname) {
        case "/api/snapshot": return await apiSnapshot(env);
        case "/api/events":   return await apiEvents(env, url);
        case "/api/push-snapshot": return req.method === "POST" ? await apiPushSnapshot(env, req) : json({ error: "POST only" }, 405);
        case "/api/push-events": return req.method === "POST" ? await apiPushEvents(env, req) : json({ error: "POST only" }, 405);
        case "/api/status": {
          const s = cache.data || (await buildSnapshot(env));
          return json({ ok: true, address: s.address, tick: s.tick, totalSpikes: s.totalSpikes, cacheAgeS: Math.round(Date.now() / 1000 - cache.at) });
        }
        default:
          return json({
            name: "WBB worker",
            worm: "the fully on-chain C. elegans brain on BSC mainnet",
            endpoints: ["/api/snapshot", "/api/events?blocks=N", "/api/status"],
          });
      }
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
  },
};
