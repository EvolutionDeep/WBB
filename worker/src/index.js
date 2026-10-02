/**
 * WBB Worker -- the read/write bridge between the living on-chain brain and the 3D frontend.
 *
 * What it does:
 *   GET  /api/snapshot   aggregated read of WormBrain state (tick, V/gate/stim/spikeCount
 *                        for all 302 neurons, body position/heading, stateHash) with a short
 *                        server-side cache so the browser never fires 900 RPC calls itself.
 *   GET  /api/events     recent Advanced / Stimulated logs from the contract (on-chain proof
 *                        that a stimulation landed -> the frontend reacts to THAT, not to the
 *                        optimistic click), plus pending->landed correlation.
 *   GET  /api/status     cheap health check (contract, tick, cache age).
 *   POST /api/stimulate  enqueue a stimulation REQUEST {idx, amp} (the worker never holds a
 *                        private key -- nothing is signed here). The resident daemon drains
 *                        the queue and pays for the real stimulate() tx on BSC mainnet.
 *   GET  /api/pending    daemon-only (X-Daemon-Key) list of queued requests.
 *   POST /api/ack        daemon-only confirmation that a request landed on-chain (txHash).
 *
 * Env (wrangler): BRAIN_ADDRESS, BSC_RPC, DAEMON_KEY, STIM_QUEUE (KV, optional; falls back
 * to in-memory queue which is per-isolate and best-effort -- fine for demos, KV is 1 source
 * of truth when attached).
 */

const SEL = {
  V: "0x76cf132b",
  gate: "0x87a99866",
  stim: "0x9ce72e78",
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
const SNAPSHOT_TTL_S = 8;      // server-side cache age for snapshots
const DEFAULT_BLOCKS = 400;    // ~20 min of BSC blocks at 3s
const MAX_QUEUE_PER_IP = 6;    // crude rate limit against UI spam

// ---- tiny helpers ----

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
  const res = await fetch(env.BSC_RPC || "https://bsc-dataseed1.bnbchain.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function rpcBatch(env, calls) {
  // calls: [{to,data}] -> array of hex results, order preserved; falls back to serial.
  const body = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));
  try {
    const res = await fetch(env.BSC_RPC || "https://bsc-dataseed1.bnbchain.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (Array.isArray(j)) {
      const out = new Array(calls.length);
      for (const r of j) {
        if (r.error) throw new Error(JSON.stringify(r.error));
        out[r.id - 1] = r.result;
      }
      return out;
    }
  } catch (e) {
    // some public endpoints disable batching -> serial fallback (slower but correct)
  }
  const out = [];
  for (const c of calls) out.push(await rpc(env, "eth_call", [{ to: c.to, data: c.data }, "latest"]));
  return out;
}

const word = (sel, idx) => sel + BigInt.asUintN(256, BigInt(idx)).toString(16).padStart(64, "0");

// ---- snapshot ----

let cache = { at: 0, data: null }; // per-isolate cache; CF gives us seconds-scale reuse

async function buildSnapshot(env) {
  const addr = env.BRAIN_ADDRESS || "0xC33B1a8ad0edC91ac7eC7c09326777CF3Dfaf24B";
  const scalars = ["tick", "totalSpikes", "px", "py", "hx", "hy", "connRoot", "edgeCount", "stateHash"];
  const calls = [];
  for (const s of scalars) calls.push({ to: addr, data: SEL[s] });
  const ARRAYS = [["V", SEL.V], ["gate", SEL.gate], ["stim", SEL.stim], ["spikeCount", SEL.spikeCount]];
  for (const [, sel] of ARRAYS) for (let i = 0; i < N_NEURONS; i++) calls.push({ to: addr, data: word(sel, i) });

  // chunked batches: 1 batch request per 300 calls -> ~4 requests total
  const results = [];
  for (let off = 0; off < calls.length; off += 300) {
    const part = await rpcBatch(env, calls.slice(off, off + 300));
    results.push(...part);
  }

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
  if (cache.data && now - cache.at < SNAPSHOT_TTL_S) return json({ ...cache.data, cached: true });
  const data = await buildSnapshot(env);
  cache = { at: now, data };
  return json({ ...data, cached: false });
}

// ---- events ----

async function apiEvents(env, url) {
  const addr = env.BRAIN_ADDRESS || "0xC33B1a8ad0edC91ac7eC7c09326777CF3Dfaf24B";
  const blocks = Math.min(2000, parseInt(url.searchParams.get("blocks") || DEFAULT_BLOCKS, 10));
  const latest = BigInt(await rpc(env, "eth_blockNumber", []));
  const from = "0x" + (latest > BigInt(blocks) ? latest - BigInt(blocks) : 0n).toString(16);
  const logs = await rpc(env, "eth_getLogs", [{ address: addr, from: "0x" + BigInt(from).toString(16), topics: [[EV.Advanced, EV.Stimulated]] }]);
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
  return json({ count: evs.length, events: evs.slice(-120) });
}

// ---- stimulation request queue ----

const memQueue = new Map(); // id -> {idx, amp, at, ip, tx} (per-isolate fallback)

function queuePut(env, item) {
  if (env.STIM_QUEUE) return env.STIM_QUEUE.put(item.id, JSON.stringify(item));
  memQueue.set(item.id, item);
  return Promise.resolve();
}

async function queueList(env) {
  if (env.STIM_QUEUE) {
    const keys = await env.STIM_QUEUE.list({ limit: 100 });
    const items = [];
    for (const k of keys.keys) {
      const raw = await env.STIM_QUEUE.get(k.name);
      if (raw) items.push(JSON.parse(raw));
    }
    return items;
  }
  return [...memQueue.values()];
}

async function apiStimulate(env, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const idx = Number(body.idx), amp = Number(body.amp);
  if (!Number.isInteger(idx) || idx < 0 || idx >= N_NEURONS) return json({ error: "idx must be 0..301" }, 400);
  if (!Number.isFinite(amp) || Math.abs(amp) > 8.1 * 1048576) return json({ error: "amp out of range (Q20, cap 8.1)" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "anon";
  const now = Date.now();
  let recent = 0;
  for (const it of await queueList(env)) {
    if (it.ip === ip && now - it.at < 60_000) recent++;
  }
  if (recent >= MAX_QUEUE_PER_IP) return json({ error: "rate limited: wait for your stimulations to land on-chain" }, 429);
  const item = { id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, idx, amp: Math.round(amp), at: now, ip };
  await queuePut(env, item);
  return json({ queued: true, id: item.id, note: "a resident node will pay for the stimulate() tx; watch /api/events for the on-chain Stimulated log" });
}

async function apiPending(env, req) {
  if (!env.DAEMON_KEY || req.headers.get("x-daemon-key") !== env.DAEMON_KEY) return json({ error: "forbidden" }, 403);
  const items = (await queueList(env)).filter((i) => !i.tx);
  return json({ pending: items });
}

async function apiAck(env, req) {
  if (!env.DAEMON_KEY || req.headers.get("x-daemon-key") !== env.DAEMON_KEY) return json({ error: "forbidden" }, 403);
  const { id, tx } = await req.json();
  if (env.STIM_QUEUE) { await env.STIM_QUEUE.delete(id); return json({ acked: id }); }
  memQueue.delete(id);
  return json({ acked: id, tx });
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
        case "/api/stimulate": return req.method === "POST" ? await apiStimulate(env, req) : json({ error: "POST only" }, 405);
        case "/api/pending":  return await apiPending(env, req);
        case "/api/ack":      return req.method === "POST" ? await apiAck(env, req) : json({ error: "POST only" }, 405);
        case "/api/status": {
          const s = cache.data || (await buildSnapshot(env));
          return json({ ok: true, address: s.address, tick: s.tick, totalSpikes: s.totalSpikes, cacheAgeS: Math.round(Date.now() / 1000 - cache.at) });
        }
        default:
          return json({
            name: "WBB worker",
            worm: "the fully on-chain C. elegans brain on BSC mainnet",
            endpoints: ["/api/snapshot", "/api/events?blocks=N", "/api/stimulate (POST {idx,amp})", "/api/status"],
          });
      }
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
  },
};
