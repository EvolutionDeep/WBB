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
 *   POST /api/rpc        narrow read-only JSON-RPC proxy (whitelisted eth_call,
 *                        eth_getLogs, block/head reads; single request or batch) so the
 *                        browser can PREFER the metered gateway without carrying its
 *                        key inside a public bundle. No write method is ever forwarded.
 *   POST /api/push-snapshot / /api/push-events  daemon-only (X-Daemon-Key) feeds so the
 *                        poll path costs zero extra RPC; the worker only ever READS the chain.
 *
 * Env (wrangler): BRAIN_ADDRESS, BSC_RPC (the metered gateway; it LEADS every read),
 * DAEMON_KEY, WBB_STORE (KV, shared snapshot/events cache across isolates). This worker
 * is a pure read-only bridge: it never enqueues or sends any transaction and holds no
 * private key -- the only secret it carries is an RPC URL that embeds a read key.
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

// The metered gateway leads whenever it is configured: it answers every method here
// reliably, where the free dataseeds drop batch members and refuse eth_getLogs
// outright. The public pool is the failover, used once the preferred endpoint has
// actually failed -- running out of compute units is a reason to degrade a read, never
// a reason to refuse one up front.
export const rpcUrls = (env) => [
  ...(env.BSC_RPC ? env.BSC_RPC.split(",").map((s) => s.trim()).filter(Boolean) : []),
  ...FALLBACK_RPCS,
];

const FETCH_TIMEOUT_MS = 12000; // fail fast to the next endpoint, never hang a poll
const DOWN_COOLDOWN_MS = 30000; // per isolate: a gateway that just failed is skipped
const downUntil = new Map();    // url -> epoch ms

function attemptOrder(urls, preferred) {
  // With a configured gateway it leads: the first attempt is always its, and the free
  // pool only gets a turn after it actually failed. Without one the free endpoints are
  // rotated, so a poll never hammers a single public node.
  if (!urls.length) return [];
  const start = RR++ % urls.length;
  if (!preferred) return urls.map((_, i) => urls[(start + i) % urls.length]);
  const rest = urls.slice(1);
  if (!rest.length) return [urls[0]];
  const rstart = RR++ % rest.length;
  return [urls[0], ...rest.map((_, i) => rest[(rstart + i) % rest.length])];
}
const gatewayDown = (url) => { const t = downUntil.get(url); return !!t && Date.now() < t; };
function markGateway(url, err) {
  if (downUntil.size > 32) for (const [k, v] of downUntil) { if (v < Date.now()) downUntil.delete(k); }
  downUntil.set(url, Date.now() + DOWN_COOLDOWN_MS);
  return err;
}

// BSC_RPC embeds a read key in its path, and HTTP/RPC exceptions quote the endpoint
// they used -- so no error text may leave this worker before the URL is stripped.
export function scrub(env, text) {
  let s = String(text === null || text === undefined ? "" : text);
  for (const u of (env.BSC_RPC || "").split(",").map((x) => x.trim()).filter(Boolean)) s = s.split(u).join("***");
  return s.slice(0, 400);
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-daemon-key",
      ...extra,
    },
  });

// A browser POSTs an Origin header; curl and cron do not. This is a guard against some
// other site quietly spending this worker's gateway quota, not a lock -- the per-address
// budget below is what actually bounds a non-browser caller.
const ORIGIN_OK = /(^[a-z][a-z0-9+.-]*:\/\/(localhost|127\.0\.0\.1)(:\d+)?$)|(^https:\/\/([a-z0-9-]+\.)*(bscworm\.com|pages\.dev|workers\.dev)$)/i;
export const originAllowed = (origin) => !origin || ORIGIN_OK.test(origin);

function toSigned(hexWord) {
  // Accept a word with OR without the 0x prefix. A raw 64-hex slice (an event data
  // word split out below) has NO prefix, and BigInt() would then read it as DECIMAL
  // -- wrong for all-digits, SyntaxError on any a-f (e.g. a fired count of 26 = ..1a)
  // that crashed /api/events with a 502. Normalize to hex, then decode int256.
  const hex = typeof hexWord === "string" && !hexWord.startsWith("0x") ? "0x" + hexWord : hexWord;
  let v = BigInt(hex);
  const MOD = 1n << 256n;
  if (v >= 1n << 255n) v -= MOD;
  const f = Number(v);
  return f; // values are Q20 and far below 2^53, safe as double
}

// Decode raw eth_getLogs entries into the API's event shape. Exported so the
// hex-parsing (the historical fired=26 -> 502 crash) is unit-testable in isolation.
export function decodeLogs(logs) {
  return logs.map((lg) => {
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
      fired: toSigned(lg.data.slice(2, 66)),       // raw 64-hex word (no 0x) -> toSigned adds it
      totalSpikes: toSigned(lg.data.slice(66, 130)),
    };
  });
}

async function rpc(env, method, params) {
  const order = attemptOrder(rpcUrls(env), !!env.BSC_RPC);
  let lastErr = new Error("no rpc endpoints");
  for (const url of order) {
    if (gatewayDown(url)) { lastErr = new Error(`${method}: gateway cooling down`); continue; }
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
      // next endpoint: a refused or cooling gateway is parked for a moment so a
      // single poll does not knock on it once per getter
      lastErr = markGateway(url, e); // public dataseeds rate-limit eth_call per method
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

async function rpcBatch(env, calls, blockTag = "latest") {
  // calls: [{to,data}] -> array of hex results, order preserved, all read at the
  // SAME blockTag so an aggregated snapshot is internally consistent (see #4).
  // Batch JSON-RPC is only attempted against configured PRIVATE endpoints
  // (public dataseeds cap batches at 100 and rate-limit batched eth_call);
  // the public path is concurrent single eth_calls rotated over endpoints.
  const privateUrls = env.BSC_RPC ? env.BSC_RPC.split(",").map((s) => s.trim()).filter(Boolean) : [];
  for (const url of privateUrls) {
    if (gatewayDown(url)) continue; // metered gateway out for a moment: use the free pool
    try {
      const out = [];
      for (let off = 0; off < calls.length; off += 100) {
        const chunk = calls.slice(off, off + 100);
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chunk.map((c, i) => ({
            jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: c.to, data: c.data }, blockTag],
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
  return poolMap(calls, 16, (c) => rpc(env, "eth_call", [{ to: c.to, data: c.data }, blockTag]));
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
  // the live WormBrainV2; the legacy reverse-synapse brain 0x18174bb0... and v1
  // 0xC33B1a8a... are immutable history and must never be a fallback default
  const addr = env.BRAIN_ADDRESS || "0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3";
  // pin every getter to ONE block so V/gate/stim/M/spikes and stateHash all
  // describe the same on-chain state; without this a beat landing mid-rebuild
  // would splice two blocks together and the arrays would not match stateHash.
  const blockTag = await rpc(env, "eth_blockNumber", []);
  const scalars = ["tick", "totalSpikes", "px", "py", "hx", "hy", "connRoot", "edgeCount", "stateHash"];
  const calls = [];
  for (const s of scalars) calls.push({ to: addr, data: SEL[s] });
  const ARRAYS = [["V", SEL.V], ["gate", SEL.gate], ["stim", SEL.stim], ["M", SEL.M], ["spikeCount", SEL.spikeCount]];
  for (const [, sel] of ARRAYS) for (let i = 0; i < N_NEURONS; i++) calls.push({ to: addr, data: word(sel, i) });

  // one logical read of 1519 getters, all at blockTag; rpcBatch pools it over endpoints
  const results = await rpcBatch(env, calls, blockTag);

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
  out.readBlock = Number(BigInt(blockTag)); // block every value above was read at
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
  const addr = env.BRAIN_ADDRESS || "0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3";
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
  const evs = decodeLogs(logs);
  const payload = { count: evs.length, events: evs.slice(-120) };
  evCache = { key, at: Date.now() / 1000, data: payload };
  return json(payload);
}

// ---- browser read proxy (POST /api/rpc) ----

// The dashboard, the wall and the poke feed all only ever READ: every transaction on this
// site is signed inside the visitor's own wallet. So this endpoint forwards exactly the
// methods those reads need and nothing that could spend, broadcast or impersonate.
const RPC_READ_METHODS = new Set([
  "eth_call",
  "eth_getLogs",
  "eth_blockNumber",
  "eth_chainId",
  "eth_getBlockByNumber",
]);

const MAX_BATCH = 100;          // measured: the metered gateway answers a 100-member batch in order
const MAX_SPAN = 20000;         // blocks per eth_getLogs; the widest scan on the site is 9000
const MAX_BODY_BYTES = 262144;  // a 100-call eth_call batch is ~25 KB; above this it is abuse
const WINDOW_MS = 60000;
const WINDOW_WEIGHT = 6000;     // inner JSON-RPC calls per minute per client address

// Blocks between two eth_getLogs bounds, or null when either bound is a word like
// "latest" -- an open-ended range is the gateway's own cap to enforce, not ours.
function logSpan(q) {
  if (!q || typeof q !== "object") return null;
  const num = (v) => (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? Number(BigInt(v)) : null);
  const a = num(q.fromBlock);
  const b = num(q.toBlock);
  return a === null || b === null ? null : Math.max(0, b - a);
}

/**
 * Decide what may leave the worker. Pure: no network, no env, no secret -- so the
 * policy (read-only methods, batch size, log span) is unit-testable on its own.
 * Refused members come back as JSON-RPC errors carrying their own id, which keeps a
 * partially refused batch honest about its holes instead of silently dropping rows.
 */
export function gateRpc(payload) {
  const batched = Array.isArray(payload);
  const items = batched ? payload : [payload];
  if (!items.length || items.length > MAX_BATCH) {
    return { err: { code: -32600, message: `between 1 and ${MAX_BATCH} requests per call` } };
  }
  const answers = [];
  const forward = [];
  for (const it of items) {
    const id = it && it.id !== undefined ? it.id : null;
    const refuse = (code, message) => answers.push({ jsonrpc: "2.0", id, error: { code, message } });
    if (!it || typeof it.method !== "string") { refuse(-32600, "not a JSON-RPC request"); continue; }
    if (!RPC_READ_METHODS.has(it.method)) { refuse(-32601, `${it.method} is not served here: read-only proxy`); continue; }
    if (it.method === "eth_getLogs") {
      const span = logSpan(it.params && it.params[0]);
      if (span !== null && span > MAX_SPAN) { refuse(-32005, `log range of ${span} blocks exceeds the ${MAX_SPAN}-block cap`); continue; }
    }
    forward.push(it);
  }
  return { batched, forward, answers, weight: forward.length };
}

// Per-isolate budget. Cloudflare isolates do not share memory and a KV write costs a
// fraction of the free daily quota, so this is a rough guard against one address
// hammering the gateway -- not an exact ledger of who used what.
const budget = new Map(); // address -> { at, used }
function spend(ip, weight) {
  const now = Date.now();
  const b = budget.get(ip);
  if (!b || now - b.at > WINDOW_MS) {
    if (budget.size > 4096) { for (const [k, v] of budget) { if (now - v.at > WINDOW_MS) budget.delete(k); } }
    budget.set(ip, { at: now, used: weight });
    return true;
  }
  b.used += weight;
  return b.used <= WINDOW_WEIGHT;
}

// The reply to a hard refusal: one error envelope for a single request, an array for a
// batch, always with the caller's own id so ethers and the wall scan can match it up.
const rpcError = (gate, err) =>
  gate && gate.batched
    ? gate.forward.map((f) => ({ jsonrpc: "2.0", id: f.id ?? null, error: err }))
    : { jsonrpc: "2.0", id: (gate && gate.forward[0] && gate.forward[0].id) ?? null, error: err };

// A reverted eth_call is a real answer from the chain and has to reach the browser
// unchanged; only a transport-level refusal (rate limit, unavailable) is worth asking
// another gateway about.
const GATEWAY_RETRY = /limit|too many|throttl|unavail|busy|capacity|rate/i;
const retryAtNextGateway = (err) => !!err && (err.code === -32005 || err.code === 429 || GATEWAY_RETRY.test(String(err.message || "")));

async function forwardRpc(env, items, batched) {
  const order = attemptOrder(rpcUrls(env), !!env.BSC_RPC);
  let lastErr = new Error("no rpc endpoints");
  for (const url of order) {
    if (gatewayDown(url)) { lastErr = new Error("gateway cooling down"); continue; }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batched ? items : items[0]),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw markGateway(url, new Error(`gateway answered ${res.status}`));
      const j = await res.json();
      // a node that answers a 100-member batch with 23 items, or with a bare error
      // object, must not be passed on as if it had served the reads
      if (batched && (!Array.isArray(j) || j.length !== items.length)) {
        throw markGateway(url, new Error(`gateway broke a ${items.length}-member batch`));
      }
      if (!batched && j && j.error && retryAtNextGateway(j.error)) {
        throw markGateway(url, new Error(JSON.stringify(j.error)));
      }
      return j;
    } catch (e) {
      lastErr = e; // next gateway: the free pool is there precisely for this
    }
  }
  throw lastErr;
}

async function apiRpc(env, req) {
  if (!originAllowed(req.headers.get("origin"))) return json({ error: "origin not allowed" }, 403);
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json({ error: `body over ${MAX_BODY_BYTES} bytes` }, 413);
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "body must be JSON-RPC" }, 400); }
  const gate = gateRpc(payload);
  if (gate.err) return json({ jsonrpc: "2.0", id: null, error: gate.err }, 400);
  if (!gate.forward.length) return json(gate.answers.length === 1 ? gate.answers[0] : gate.answers);
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
  if (!spend(ip, gate.weight)) {
    return json(rpcError(gate, { code: -32005, message: `over ${WINDOW_WEIGHT} reads per minute from this address` }), 429, { "retry-after": "60" });
  }
  let out;
  try {
    out = await forwardRpc(env, gate.forward, gate.batched);
  } catch (e) {
    return json(rpcError(gate, { code: -32000, message: scrub(env, e && e.message || e) }), 502);
  }
  // locally refused members are stitched back in: the caller sees its own ids and a
  // visible hole, never a confidently shorter answer
  if (!gate.batched) return json(out);
  return json(Array.isArray(out) ? out.concat(gate.answers) : [out].concat(gate.answers));
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
        case "/api/rpc": return req.method === "POST" ? await apiRpc(env, req) : json({ error: "POST only" }, 405);
        case "/api/status": {
          // A cold isolate has nothing cached yet. The rebuild has to stamp the
          // cache: measuring age against the initial at = 0 reported a snapshot as
          // ~56 years old at the very second it was computed.
          const now = Date.now() / 1000;
          let s = cache.data;
          let ageAt = cache.at;
          if (pushCache.data && now - pushCache.at < PUSH_TTL_S) { s = pushCache.data; ageAt = pushCache.at; }
          if (!s) { s = await buildSnapshot(env); cache = { at: now, data: s }; ageAt = now; }
          return json({ ok: true, address: s.address, tick: s.tick, totalSpikes: s.totalSpikes, cacheAgeS: Math.round(now - ageAt) });
        }
        default:
          return json({
            name: "WBB worker",
            worm: "the fully on-chain C. elegans brain on BSC mainnet",
            endpoints: ["/api/snapshot", "/api/events?blocks=N", "/api/rpc (POST, read-only)", "/api/status"],
          });
      }
    } catch (e) {
      // scrub first: an exception from fetch quotes the gateway URL, and that URL is a
      // metered key in its path
      return json({ error: scrub(env, e && e.message || e) }, 502);
    }
  },
};
