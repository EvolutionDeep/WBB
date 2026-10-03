// Offline unit test for the browser read proxy (worker/src/index.js :: /api/rpc).
// No real gateway is contacted: global fetch is replaced by a stub that records every
// URL and payload, so the POLICY is what gets checked -- which methods may leave the
// worker, in which gateway order, how a partly refused batch is answered, and that a
// metered URL never appears in a response body.
// Run: node worker/test_rpc_gate.mjs
import worker, { gateRpc, rpcUrls, originAllowed, scrub } from "./src/index.js";

const METERED = "https://fake-gw.test/v2/SECRETREADKEY";
const PUBLIC1 = "https://bsc-dataseed1.bnbchain.org";
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
};

// ---- 1) the pure gate: what may leave the worker ----
{
  const g = gateRpc({ jsonrpc: "2.0", id: 7, method: "eth_call", params: [{ to: "0x00", data: "0x1234" }, "latest"] });
  check("gate forwards eth_call", g.forward.length === 1 && g.answers.length === 0);

  for (const m of ["eth_sendRawTransaction", "eth_accounts", "personal_sign", "debug_traceCall", "anvil_mine", "eth_newFilter"]) {
    const r = gateRpc({ jsonrpc: "2.0", id: 1, method: m, params: [] });
    check(`gate refuses ${m}`, r.forward.length === 0 && r.answers[0].error.code === -32601, r.answers[0].error.message);
  }
  check("gate refuses a body that is not a request", gateRpc({ jsonrpc: "2.0", id: 1 }).answers[0].error.code === -32600);
  check("gate refuses an empty batch", gateRpc([]).err && gateRpc([]).err.code === -32600);
  check("gate refuses an oversized batch", gateRpc(Array.from({ length: 101 }, () => ({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }))).err !== undefined);
  check("gate accepts a 100-member batch", gateRpc(Array.from({ length: 100 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_blockNumber", params: [] }))).weight === 100);

  const span = (blocks) => gateRpc({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: "0x00", fromBlock: "0x0", toBlock: "0x" + blocks.toString(16) }] });
  check("gate allows the site's widest scan (9000 blocks)", span(9000).weight === 1);
  check("gate allows a 2000-block wall chunk", span(2000).weight === 1);
  check("gate refuses a 30000-block scan", span(30000).answers[0].error.code === -32005, span(30000).answers[0].error.message);
  check("gate leaves an open 'latest' range to the gateway", gateRpc({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: "0x00", fromBlock: "0x0", toBlock: "latest" }] }).weight === 1);

  const mixed = gateRpc([
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [] },
    { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0xff"] },
    { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x7d0" }] },
  ]);
  check("mixed batch forwards only the allowed members", mixed.weight === 2 && mixed.forward.map((f) => f.id).join() === "0,2");
  check("mixed batch keeps the refused member's id", mixed.answers.length === 1 && mixed.answers[0].id === 1);

  check("metered gateway leads the endpoint list", rpcUrls({ BSC_RPC: METERED })[0] === METERED);
  check("public pool is the failover behind it", rpcUrls({ BSC_RPC: METERED }).slice(1).includes(PUBLIC1));
  check("no gateway configured still answers", rpcUrls({})[0] === PUBLIC1);

  check("own site origin allowed", originAllowed("https://bscworm.com") && originAllowed("https://www.bscworm.com"));
  check("dev origin allowed", originAllowed("http://localhost:5173") && originAllowed("http://127.0.0.1:8790"));
  check("preview origin allowed", originAllowed("https://wbb-site.someone.workers.dev"));
  check("someone else's site refused", !originAllowed("https://evil.example.com") && !originAllowed("null"));
  check("no origin is not treated as a lock, only a guard", originAllowed(null));
  check("scrub strips a metered URL out of error text", !scrub({ BSC_RPC: METERED }, `connect failed to ${METERED}`).includes("SECRETREADKEY"));
}

// ---- 2) the live endpoint with fetch stubbed out ----
const realFetch = globalThis.fetch;
let calls = [];
let responder = (payload) => Array.isArray(payload)
  ? payload.map((p) => ({ jsonrpc: "2.0", id: p.id, result: "0xok" }))
  : { jsonrpc: "2.0", id: payload.id, result: "0xdeadbeef" };

globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body);
  calls.push({ url: String(url), payload });
  const out = responder(payload, String(url));
  if (out instanceof Error) throw out;
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
};

const post = async (body, env = { BSC_RPC: METERED }, headers = {}) => {
  const res = await worker.fetch(
    new Request("https://api.bscworm.com/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} }
  );
  return { status: res.status, headers: res.headers, body: await res.json() };
};

const single = (n) => ({ jsonrpc: "2.0", id: n || 1, method: "eth_blockNumber", params: [] });
// a distinct metered URL per scenario: a failing gateway is cooled down for 30 s, and
// that state is shared inside the module under test
const lead = (tag) => `https://fake-gw.test/v2/SECRETREADKEY-${tag}`;

try {
  calls = [];
  let r = await post(single(11));
  check("a single read goes to the metered gateway", r.status === 200 && calls.length === 1 && calls[0].url === METERED);
  check("the caller's own id comes back", r.body.id === 11 && r.body.result === "0xdeadbeef");

  calls = [];
  r = await post([single(0), single(1), { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0xff"] }]);
  check("a batch forwards only its allowed members", calls.length === 1 && calls[0].payload.length === 2);
  check("a partly refused batch is answered as 3 items", Array.isArray(r.body) && r.body.length === 3 && r.body.some((x) => x.error && x.error.code === -32601));

  calls = [];
  r = await post({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0xff"] });
  check("a write method never reaches any gateway", calls.length === 0 && r.body.error.code === -32601);

  calls = [];
  r = await post(single(), {}, { origin: "https://evil.example.com" });
  check("a third-party origin is refused before any spend", calls.length === 0 && r.status === 403);

  calls = [];
  r = await post("definitely not json");
  check("a body that is not JSON is refused", r.status === 400 && calls.length === 0);

  // the metered gateway is down: the read degrades to a free node instead of failing
  const L1 = lead("FAIL");
  calls = [];
  responder = (payload, url) => (url === L1 ? new Error(`fetch failed at ${L1}`) : { jsonrpc: "2.0", id: payload.id, result: "0xfrompublic" });
  r = await post(single(5), { BSC_RPC: L1 });
  check("failover: a dead metered gateway falls through to a public node", r.body.result === "0xfrompublic" && calls.length === 2 && calls[1].url !== L1);
  check("the failover answer carries no gateway key", !JSON.stringify(r.body).includes("SECRETREADKEY"));

  // a rate-limited answer is worth another gateway; a reverted call is not
  const L2 = lead("LIMIT");
  calls = [];
  responder = (payload, url) => (url === L2
    ? { jsonrpc: "2.0", id: payload.id, error: { code: -32005, message: "You have hit your request rate limit" } }
    : { jsonrpc: "2.0", id: payload.id, result: "0xfrompublic" });
  r = await post(single(9), { BSC_RPC: L2 });
  check("a rate-limited answer asks the next gateway", calls.length === 2 && r.body.result === "0xfrompublic");

  const L3 = lead("REVERT");
  calls = [];
  responder = () => ({ jsonrpc: "2.0", id: 3, error: { code: 3, message: "execution reverted" } });
  r = await post({ jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: "0x00", data: "0x1234" }, "latest"] }, { BSC_RPC: L3 });
  check("a reverted call is a real answer, passed through once", calls.length === 1 && r.body.error.message === "execution reverted");

  // a gateway that breaks a batch (answers an array request with one object) is not
  // passed on as if it had served the reads
  const L4 = lead("BROKE");
  calls = [];
  responder = (payload, url) => (url === L4
    ? { jsonrpc: "2.0", id: 0, error: { code: -32600, message: "batch not supported" } }
    : payload.map((p) => ({ jsonrpc: "2.0", id: p.id, result: "0xok" })));
  r = await post([single(0), single(1), single(2)], { BSC_RPC: L4 });
  check("a gateway that breaks a batch is not passed on", Array.isArray(r.body) && r.body.length === 3 && calls.length === 2);

  // per-address budget: 100 reads per request, 6000 per minute
  const L5 = lead("BUDGET");
  calls = [];
  responder = (payload) => (Array.isArray(payload) ? payload.map((p) => ({ jsonrpc: "2.0", id: p.id, result: "0xok" })) : single());
  const bigBatch = Array.from({ length: 100 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_blockNumber", params: [] }));
  const ip = "203.0.113.77";
  let limitedAt = 0;
  for (let k = 1; k <= 65; k++) {
    const one = await post(bigBatch, { BSC_RPC: L5 }, { "cf-connecting-ip": ip });
    if (one.status === 429) { limitedAt = k; break; }
  }
  check("the per-address budget bites at 6000 reads", limitedAt === 61, `429 on request ${limitedAt}`);
  r = await post(bigBatch, { BSC_RPC: L5 }, { "cf-connecting-ip": ip });
  check("a 429 says retry after a minute", r.headers.get("retry-after") === "60");
  check("a 429 answers as JSON-RPC, not as a bare message", Array.isArray(r.body) && r.body.length === 100 && r.body[0].error.code === -32005);
  r = await post(bigBatch, { BSC_RPC: lead("FRESH") }, { "cf-connecting-ip": "198.51.100.9" });
  check("another address keeps its own budget", r.status === 200);

  const g405 = await worker.fetch(new Request("https://api.bscworm.com/api/rpc"), { BSC_RPC: METERED }, { waitUntil() {} });
  check("GET /api/rpc says POST only", g405.status === 405);

  // last: this one parks every gateway in the cooldown, so nothing after it may need one
  const L6 = lead("ALLDOWN");
  calls = [];
  responder = (payload, url) => new Error(`connection refused by ${url}`);
  r = await post(single(6), { BSC_RPC: L6 });
  check("all gateways down answers 502", r.status === 502 && calls.length >= 2, `${calls.length} gateways tried`);
  check("the 502 body is scrubbed of the metered key", !JSON.stringify(r.body).includes("SECRETREADKEY-ALLDOWN"), JSON.stringify(r.body).slice(0, 90));
} finally {
  globalThis.fetch = realFetch;
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL RPC PROXY CHECKS PASSED");
process.exitCode = failures ? 1 : 0;
