import { ethers } from "ethers";

/**
 * READ-ONLY dashboard for the on-chain worm.
 *
 * It reads ONLY the deployed WormReadout and SenseAdapter (plus the brain they are
 * bound to and the frozen pool the adapter samples) straight from a public BSC
 * JSON-RPC endpoint. It NEVER signs, NEVER sends a transaction, NEVER calls
 * advance/stimulate/seed, and NEVER runs a second copy of the brain in the browser.
 * Every number on screen is on-chain state served by eth_call / eth_getLogs.
 *
 * Comment policy: English only (project rule).
 */

// ---- frozen deployment coordinates (see contracts/deployed_addresses.json) ----
const READOUT = "0x192004dAe2A55E20CE21A7d05E722B32c9A9b61E";
const ADAPTER = "0xbe0C5117f740a9333614D806Bd50C3907186C6fD";
const SCALE = 1048576n; // Q20

// Public BSC RPC endpoints, tried in order on failure (read-only use only).
const RPC_SEEDS = (
  localStorage.getItem("wbb_rpc") ||
  import.meta.env.VITE_RPC_URL ||
  [
    "https://bsc-dataseed1.bnbchain.org",
    "https://bsc-dataseed2.bnbchain.org",
    "https://bsc-dataseed3.bnbchain.org",
    "https://bsc-rpc.publicnode.com",
  ].join(",")
).split(",").map((s) => s.trim()).filter(Boolean);

// named sensory/motor indices (frozen WormNeurons table)
const NEURON = {
  39: "ASEL", 40: "ASER", 53: "AVAL", 54: "AVAR", 55: "AVBL", 56: "AVBR",
  72: "AWAL", 73: "AWAR", 76: "AWCL", 77: "AWCR", 172: "PVCL", 173: "PVCR",
};
const nameOf = (idx) => NEURON[Number(idx)] || `#${idx}`;

// ---- minimal ABIs (view + events only) ----
const READOUT_ABI = [
  "function brain() view returns (address)",
  "function STALE_WINDOW() view returns (uint64)",
  "function read() view returns (tuple(int16 approach,int16 turn,int16 speed,uint64 tick,uint64 blockNumber,bytes32 stateHash))",
];
const ADAPTER_ABI = [
  "function brain() view returns (address)",
  "function pair() view returns (address)",
  "function gain() view returns (int256)",
  "function ampCap() view returns (int256)",
  "function lastReserveRatio() view returns (uint256)",
  "function isPrimed() view returns (bool)",
  "event Injected(address indexed from, int256 amp, uint256 idx)",
  "event Sampled(uint256 ratio, int256 delta, int256 signedAmp, int256 magAmp)",
];
const BRAIN_ABI = [
  "function connRoot() view returns (bytes32)",
  "function tick() view returns (uint256)",
  "function totalSpikes() view returns (uint256)",
  "function stateHash() view returns (bytes32)",
  "function stim(uint256) view returns (int256)",
  "event Advanced(uint256 indexed tick, uint256 fired, uint256 totalSpikes)",
  "event Stimulated(uint256 indexed idx, int256 amp)",
];
const PAIR_ABI = ["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"];

// ---- static evidence, mirrors README.md (history, not live polling) ----
const EVIDENCE = [
  {
    lbl: "1 · non-deployer inject (no advance in-tx)",
    desc: "A funded throwaway (not the deployer) called SenseAdapter.inject(200000); brain tick stayed 6 → 6 in that transaction.",
    txs: ["0xe41ea3b5af30f816e7221c3301c4b5e046bbfbf4298f938db0d7492a975ebb8c"],
    note: "funding tx 0x0f8b1da2a47ea8cb2910a1b34accd6f7348b2602f3f4affd5d8f939bea1c5aa1",
  },
  {
    lbl: "2 · same-block currents accumulate, never overwrite",
    desc: "(a) stimulate(ASEL,+300000) then stimulate(ASEL,-120000) in one block → stim 200000→380000. (b) inject(250000) then inject(150000) in one block → stim 380000→780000.",
    txs: [
      "0x351c1dfab71eca9ca8561674e79bd3e2e177bc4d45b9fabcf4da61e850b39e19",
      "0xfe601929a04a8269502034a0fab86870947914dfe1558c48c4caf35c13f1ad1f",
      "0x341adf0fa71b5aaffe2bdcc9f9dc82b20f37f25e15368ed5933c569c9e1a7795",
      "0xe444dbb48acf5edd955203a65e36c09a81cdeab4c6da05bdc3d69177885c7216",
    ],
    note: "blocks 125298241 / 125298253",
  },
  {
    lbl: "3 · readout.stateHash == brain.stateHash (read-only)",
    desc: "At block 125298262 both sides read the same stateHash — WormReadout forwards brain.stateHash() directly.",
    txs: [],
    note: "During the wait window tick stayed 6 and NO advance was observed. This is a read-only stateHash equality, NOT a verified live beat.",
  },
];

const bscscanTx = (h) => `https://bscscan.com/tx/${h}`;
const bscscanAddr = (a) => `https://bscscan.com/address/${a}`;
const short = (s, n = 6) => (s && s.length > n * 2 + 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || "—");

// ---- tiny DOM helpers ----
const el = (id) => document.getElementById(id);
const setText = (id, v) => { const n = el(id); if (n) n.textContent = v; };

// ---- provider with read-only endpoint rotation ----
let activeIdx = -1;
function makeProvider(i) {
  const p = new ethers.JsonRpcProvider(RPC_SEEDS[i], 56n, { staticNetwork: true });
  return p;
}
function provider() {
  if (activeIdx < 0) activeIdx = 0;
  return makeProvider(activeIdx);
}
// run fn(p); on network error rotate to the next seed and retry once per seed.
async function withRotation(fn) {
  const n = RPC_SEEDS.length;
  const start = activeIdx < 0 ? 0 : activeIdx;
  let lastErr;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    try {
      const p = makeProvider(i);
      const out = await fn(p);
      if (activeIdx !== i) { activeIdx = i; el("rpc-host").textContent = new URL(RPC_SEEDS[i]).host; }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("all RPC seeds failed");
}

const asContract = (p, addr, abi) => new ethers.Contract(addr, abi, p);

// scan backward in bounded chunks until the newest matching event is found.
async function findLatestEvent(contract, eventName, head, maxBlocks, chunk) {
  let from = head;
  const floor = Math.max(0, head - maxBlocks);
  while (from > floor) {
    const lo = Math.max(floor, from - chunk + 1);
    let logs;
    try { logs = await contract.queryFilter(contract.interface.getEvent(eventName), lo, from); }
    catch { logs = []; }
    if (logs.length) return logs[logs.length - 1];
    from = lo - 1;
  }
  return null;
}

async function getRecentEvents(contract, eventName, head, span) {
  const lo = Math.max(0, head - span);
  try { return await contract.queryFilter(contract.interface.getEvent(eventName), lo, head); }
  catch { return []; }
}

// format a Q20-ish signed bigint for display
const fmt = (v) => (v === null || v === undefined ? "—" : v.toString());

// ---- body trajectory (real readings only) ----
const HIST_KEY = "wbb_body_hist_v1";
function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } }
function saveHist(h) { try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-300))); } catch { /* quota */ } }

function drawBody(hist, cur) {
  const cv = el("body-canvas"); const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
  ctx.clearRect(0, 0, W, H);
  // axes
  ctx.strokeStyle = "rgba(53,224,255,0.15)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
  ctx.fillStyle = "rgba(148,205,226,0.35)"; ctx.font = "10px monospace";
  ctx.fillText("turn →", W - 46, cy - 5); ctx.fillText("approach ↑", cx + 4, 12);
  const map = (p) => [cx + (p.turn / 10000) * (W / 2 - 12), cy - (p.approach / 10000) * (H / 2 - 12)];
  // faint connector ONLY between consecutive real ticks (never fabricated points)
  ctx.strokeStyle = "rgba(53,224,255,0.18)"; ctx.beginPath();
  hist.forEach((p, i) => { const [x, y] = map(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  // points
  hist.forEach((p) => {
    const [x, y] = map(p); const r = 2 + (Math.abs(p.speed) / 10000) * 6;
    ctx.fillStyle = "rgba(53,224,255,0.5)"; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  });
  if (cur) {
    const [x, y] = map(cur); const r = 4 + (Math.abs(cur.speed) / 10000) * 8;
    ctx.fillStyle = "#ff4fd8"; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.fillStyle = "#dff5ff"; ctx.fillText(`tick ${cur.tick}`, Math.min(x + 8, W - 60), Math.max(y - 8, 10));
  }
}

function gauge(idFill, idVal, v) {
  setText(idVal, v.toString());
  const pct = Math.min(100, (Math.abs(v) / 10000) * 50);
  const f = el(idFill);
  f.style.width = pct + "%";
  f.style.left = v >= 0 ? "50%" : (50 - pct) + "%";
}

// ---- stimulus feed ----
function neuronTag(idx) {
  const n = Number(idx);
  const cls = n === 39 ? "asel" : n === 40 ? "aser" : "other";
  return `<span class="tag ${cls}">${nameOf(idx)}</span>`;
}

async function buildStimList(p, head, brainAddr, adapterAddr, stimNow) {
  const adapter = asContract(p, adapterAddr, ADAPTER_ABI);
  const brain = asContract(p, brainAddr, BRAIN_ABI);
  const [inj, stm] = await Promise.all([
    getRecentEvents(adapter, "Injected", head, 1500),
    getRecentEvents(brain, "Stimulated", head, 1500),
  ]);
  const merged = [];
  for (const lg of inj) {
    merged.push({ block: lg.blockNumber, type: "INJECT", cls: "inj", idx: lg.args.idx, amp: lg.args.amp, from: lg.args.from });
  }
  for (const lg of stm) {
    merged.push({ block: lg.blockNumber, type: "STIMULATE", cls: "stm", idx: lg.args.idx, amp: lg.args.amp, from: null });
  }
  merged.sort((a, b) => b.block - a.block);
  const top = merged.slice(0, 24);
  const box = el("stim-list");
  if (!top.length) { box.innerHTML = `<div class="note">no inject / stimulate events in the last ~1500 blocks</div>`; return; }
  box.innerHTML = top.map((e, i) => `
    <div class="ev ${e.cls}">
      <span class="ty">${e.type}</span>
      ${neuronTag(e.idx)}
      <span class="cell">amp <b>${e.amp.toString()}</b></span>
      <span class="cell">blk <b>${e.block}</b></span>
      ${e.from ? `<span class="cell">from <b>${short(e.from)}</b></span>` : ""}
      <span class="cell acc" data-i="${i}">accum <b>…</b></span>
    </div>`).join("");
  // best-effort "accumulated after that block" via historical state (needs archive; guarded)
  const idxSet = new Set([39, 40, 76, 77]);
  const cells = box.querySelectorAll(".acc");
  for (let i = 0; i < Math.min(top.length, 8); i++) {
    const e = top[i];
    if (!idxSet.has(Number(e.idx))) { cells[i].innerHTML = `accum <b>n/a</b>`; continue; }
    try {
      const v = await brain.stim(e.idx, { blockTag: e.block });
      cells[i].innerHTML = `accum <b>${v.toString()}</b>`;
    } catch { cells[i].innerHTML = `accum <b>—</b>`; }
  }
}

// ---- main poll ----
const POLL_MS = 10000;
let hist = loadHist();
let BRAIN_ADDR = null; // resolved from readout.brain() on the first successful poll

async function poll() {
  const dot = el("dot"); const statusText = el("status-text");
  try {
    await withRotation(async (p) => {
      const head = await p.getBlockNumber();
      const readout = asContract(p, READOUT, READOUT_ABI);
      const [brainAddr, staleWindow] = await Promise.all([readout.brain(), readout.STALE_WINDOW()]);
      BRAIN_ADDR = brainAddr;
      const adapterAddr = ADAPTER;
      const brain = asContract(p, brainAddr, BRAIN_ABI);
      const adapter = asContract(p, adapterAddr, ADAPTER_ABI);

      // read the three quantities + provenance
      const r = await readout.read();
      const [connRoot, tickB, stateHash] = await Promise.all([brain.connRoot(), brain.tick(), brain.stateHash()]);

      // last advance block (scan Advanced events backward)
      const adv = await findLatestEvent(brain, "Advanced", head, 40000, 2000);
      const lastAdvBlock = adv ? adv.blockNumber : null;
      const sinceAdv = lastAdvBlock !== null ? head - lastAdvBlock : null;
      const SW = Number(staleWindow);
      const halted = sinceAdv === null || sinceAdv > SW;

      // identities
      const aLink = el("brain-addr"); aLink.href = bscscanAddr(brainAddr); aLink.textContent = brainAddr;
      const rLink = el("readout-addr"); rLink.href = bscscanAddr(READOUT); rLink.textContent = short(READOUT, 8);
      const adLink = el("adapter-addr"); adLink.href = bscscanAddr(adapterAddr); adLink.textContent = short(adapterAddr, 8);
      setText("conn-root", connRoot);
      setText("tick", r.tick.toString() + (tickB.toString() === r.tick.toString() ? "" : ` (raw ${tickB})`));
      setText("state-hash", r.stateHash);
      setText("cur-block", head.toLocaleString());
      setText("last-adv-block", lastAdvBlock === null ? `none in ~40k blk` : lastAdvBlock.toLocaleString());
      setText("since-adv", sinceAdv === null ? "—" : sinceAdv.toLocaleString());

      const badge = el("status-badge");
      badge.innerHTML = halted
        ? `<span class="badge halt">HALTED — no advance in ${SW} blocks</span>`
        : `<span class="badge live">LIVE — advanced ${sinceAdv} block(s) ago</span>`;
      el("stale-note").textContent = halted
        ? `The worm has not advanced for ${sinceAdv === null ? ">40000" : sinceAdv} blocks (> stale window ${SW}). The page says HALTED; there is no animation pretending it is still moving.`
        : `A reading is stale when current block − last advance block > ${SW}.`;

      // body
      const cur = { tick: Number(r.tick), approach: Number(r.approach), turn: Number(r.turn), speed: Number(r.speed) };
      if (!hist.length || hist[hist.length - 1].tick !== cur.tick) { hist.push(cur); hist = hist.slice(-300); saveHist(hist); }
      drawBody(hist, cur);
      gauge("f-approach", "g-approach", cur.approach);
      gauge("f-turn", "g-turn", cur.turn);
      gauge("f-speed", "g-speed", cur.speed);

      // stimuli live accumulations
      const [asel, aser] = await Promise.all([brain.stim(39), brain.stim(40)]);
      setText("stim-asel", asel.toString());
      setText("stim-aser", aser.toString());

      // pool ratio (read the frozen pair the adapter samples)
      try {
        const pairAddr = await adapter.pair();
        const [ratioLast, primed] = await Promise.all([adapter.lastReserveRatio(), adapter.isPrimed()]);
        const pair = asContract(p, pairAddr, PAIR_ABI);
        const [r0, r1] = await pair.getReserves();
        const ratioNow = (BigInt(r1.toString()) * SCALE) / BigInt(r0.toString());
        setText("ratio-now", ratioNow.toString() + (primed ? "" : "  (adapter not primed yet)"));
        setText("ratio-last", ratioLast.toString());
        const delta = ratioNow - BigInt(ratioLast.toString());
        setText("ratio-delta", (delta >= 0n ? "+" : "") + delta.toString());
      } catch {
        setText("ratio-now", "— (pair read failed)");
      }

      await buildStimList(p, head, brainAddr, adapterAddr, { asel, aser });

      dot.className = "ok";
      statusText.textContent = `reading · head ${head.toLocaleString()} · ${halted ? "HALTED" : "LIVE"}`;
    });
  } catch (e) {
    dot.className = "bad";
    statusText.textContent = "RPC read failed — retrying";
    console.error("[read-only poll]", e && e.message ? e.message : e);
  }
}

function renderEvidence() {
  el("evidence").innerHTML = EVIDENCE.map((ev) => `
    <div class="ev-item">
      <div class="lbl">${ev.lbl}</div>
      <div class="desc">${ev.desc}</div>
      ${ev.txs.length ? ev.txs.map((h) => `<div class="hash"><a class="v mono" href="${bscscanTx(h)}" target="_blank" rel="noopener">${h}</a></div>`).join("") : ""}
      <div class="desc" style="color:var(--amber)">${ev.note || ""}</div>
    </div>`).join("");
}

// ---- 3D viewer: lazy-loaded, still strictly read-only ----
// three.js is code-split and only fetched when the user presses START 3D, and the
// viewer itself only ever issues eth_call reads against the deployed brain.
let viz = null;
let vizBusy = false;

const vizTarget = () => ({
  // the viewer batches hundreds of eth_call, so it gets the whole seed list and
  // picks whichever endpoint actually serves batches (see worm3d.js)
  rpcUrls: RPC_SEEDS,
  brain: BRAIN_ADDR,
});

async function startViz() {
  if (viz || vizBusy) return;
  vizBusy = true;
  const btn = el("viz-start");
  if (btn) btn.textContent = "LOADING…";
  try {
    const { createWormViz } = await import("./worm3d.js");
    viz = await createWormViz({ container: el("viz-wrap"), getTarget: vizTarget });
    const off = el("viz-off");
    if (off) off.remove();
    if (btn) { btn.textContent = "3D RUNNING"; btn.classList.add("on"); }
  } catch (e) {
    if (btn) btn.textContent = "START 3D";
    console.error("[3d] failed to start", e && e.message ? e.message : e);
  } finally {
    vizBusy = false;
  }
}

function stopViz() {
  if (!viz) return;
  viz.stop();
  viz = null;
  const btn = el("viz-start");
  if (btn) { btn.textContent = "START 3D"; btn.classList.remove("on"); }
  const wrap = el("viz-wrap");
  if (wrap && !wrap.querySelector(".viz-off")) {
    const d = document.createElement("div");
    d.className = "viz-off";
    d.id = "viz-off";
    d.textContent = "3D viewer stopped — chain polling halted. Press START 3D to resume.";
    wrap.appendChild(d);
  }
}

function wireViz() {
  const s = el("viz-start");
  const t = el("viz-stop");
  if (s) s.addEventListener("click", startViz);
  if (t) t.addEventListener("click", stopViz);
}

// The poke module is the site's single sanctioned write path and is deliberately
// NOT part of the default page: it only loads after an explicit opt-in click,
// stays behind a pinned single-call ABI, and is fenced by its own smoke guards.
function wirePoke() {
  const b = el("poke-enable");
  if (!b) return;
  b.addEventListener("click", async () => {
    try {
      const m = await import("./poke.js");
      m.init();
      b.textContent = "POKE UI ON";
      b.disabled = true;
      const f = el("poke-food"), a = el("poke-avert");
      if (f) f.disabled = false;
      if (a) a.disabled = false;
    } catch (e) {
      const s = el("poke-status");
      if (s) s.textContent = "poke module failed to load: " + ((e && e.message) || e);
    }
  }, { once: true });
}

async function boot() {
  el("rpc-host").textContent = new URL(RPC_SEEDS[0]).host;
  renderEvidence();
  wireViz();
  wirePoke();
  await poll();
  setInterval(poll, POLL_MS);
}
boot();
