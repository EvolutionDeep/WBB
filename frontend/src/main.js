import { ethers } from "ethers";
import { t, label, take, onLangChange, localeTag, initI18n } from "./i18n.js";

/**
 * READ-ONLY dashboard for the on-chain worm.
 *
 * It reads ONLY the deployed WormReadout and SenseAdapter (plus the brain they are
 * bound to and the frozen pool the adapter samples) over JSON-RPC, leading with the
 * project's own read-only worker proxy and falling back to the free BSC nodes; every
 * number still comes from the chain, the worker only carries the read. It NEVER signs,
 * NEVER sends a transaction, NEVER calls advance/stimulate/seed, and NEVER runs a second
 * copy of the brain in the browser. Every number on screen is on-chain state served by
 * eth_call / eth_getLogs.
 *
 * The read runs on two cadences, because only three reads can change inside ten seconds:
 * a fast beat takes the head, the tick and the body, and a slow beat takes everything fixed
 * at deploy or slow enough not to matter - see poll(scanLogs) below for what belongs where
 * and why.
 *
 * Three write paths exist on the site and none of them lives in this file: the
 * poke (src/poke.js), the engraving form (src/engrave.js, reached through the
 * read-only wall module src/wall.js), and the wake (src/wake.js). Each loads by
 * dynamic import behind its own click, pins one contract and one function, and
 * none can be reached from the default page.
 *
 * Comment policy: English only (project rule). Prose is: every sentence the page shows
 * lives in src/i18n.js as one {en, zh} pair, so this file owns the reading and the
 * verdict while the dictionary owns the wording and nothing else.
 */

// ---- frozen deployment coordinates (see contracts/deployed_addresses.json) ----
const READOUT = "0x192004dAe2A55E20CE21A7d05E722B32c9A9b61E";
const ADAPTER = "0xbe0C5117f740a9333614D806Bd50C3907186C6fD";
const SCALE = 1048576n; // Q20

// Where the reads go, tried in order (read-only use only). The project's own worker
// leads: it forwards to the metered gateway first and to the free BSC nodes after it,
// which is how the page gets reliable batched eth_call and wide eth_getLogs without a
// gateway key ever living inside a public bundle. The free endpoints stay behind it on
// purpose -- if the worker is unreachable the page still reads the chain itself.
const WORKER_RPC = "https://api.bscworm.com/api/rpc";
const RPC_SEEDS = (
  localStorage.getItem("wbb_rpc") ||
  import.meta.env.VITE_RPC_URL ||
  [
    WORKER_RPC,
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

// ---- static evidence, mirrors README.md (history, not live polling). Only the wording
// moved into the dictionary; the hashes below are the record itself and are never localised.
const EVIDENCE = [
  {
    key: "c07.1",
    txs: ["0xe41ea3b5af30f816e7221c3301c4b5e046bbfbf4298f938db0d7492a975ebb8c"],
    hasNote: true,
  },
  {
    key: "c07.2",
    txs: [
      "0x351c1dfab71eca9ca8561674e79bd3e2e177bc4d45b9fabcf4da61e850b39e19",
      "0xfe601929a04a8269502034a0fab86870947914dfe1558c48c4caf35c13f1ad1f",
      "0x341adf0fa71b5aaffe2bdcc9f9dc82b20f37f25e15368ed5933c569c9e1a7795",
      "0xe444dbb48acf5edd955203a65e36c09a81cdeab4c6da05bdc3d69177885c7216",
    ],
    hasNote: true,
  },
  {
    key: "c07.3",
    txs: [],
    hasNote: true,
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
// the footer says what the browser actually talked to: the worker is a proxy that reads
// the chain for the page, not a database of its own
const seedLabel = (url) => (url === WORKER_RPC ? t("c01.rpc_label", { host: "api.bscworm.com" }) : new URL(url).host);
// the host the browser actually reached, painted from the dictionary so a language
// switch can redo it without a new read
function paintRpcHost() {
  const n = el("rpc-host");
  if (n && activeIdx >= 0) n.textContent = seedLabel(RPC_SEEDS[activeIdx]);
}
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
      if (activeIdx !== i) { activeIdx = i; paintRpcHost(); }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("all RPC seeds failed");
}

const asContract = (p, addr, abi) => new ethers.Contract(addr, abi, p);

// scan backward in bounded chunks until the newest matching event is found.
// A span that ERRORS is not the same fact as a span with no matches: public
// endpoints reject wide getLogs ranges outright, and reading "rejected" as "no
// advance happened" would render a living worm as dead. Callers therefore get an
// errored count alongside the log and can stay neutral instead of accusing the chain.
async function findLatestEvent(contract, eventName, head, maxBlocks, chunk) {
  let from = head;
  const floor = Math.max(0, head - maxBlocks);
  let errored = 0;
  let spans = 0;
  while (from > floor) {
    const lo = Math.max(floor, from - chunk + 1);
    spans++;
    let logs;
    // the event NAME is what queryFilter takes; an EventFragment object is not an
    // accepted argument (ethers 6.17 answers "unknown event name"), and swallowing that
    // as a rejected span would blame the endpoint for our own bad call
    try { logs = await contract.queryFilter(eventName, lo, from); }
    catch { errored++; logs = []; }
    if (logs.length) return { log: logs[logs.length - 1], errored, spans };
    from = lo - 1;
  }
  return { log: null, errored, spans };
}

async function getRecentEvents(contract, eventName, head, span) {
  const lo = Math.max(0, head - span);
  try { return await contract.queryFilter(eventName, lo, head); }
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
  ctx.fillText(t("c02.axis_turn"), W - 46, cy - 5); ctx.fillText(t("c02.axis_approach"), cx + 4, 12);
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
    ctx.fillStyle = "#dff5ff"; ctx.fillText(t("c02.tick_label", { n: cur.tick }), Math.min(x + 8, W - 60), Math.max(y - 8, 10));
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
  if (!top.length) { box.innerHTML = `<div class="note">${t("c03.feed_empty")}</div>`; return; }
  box.innerHTML = top.map((e, i) => `
    <div class="ev ${e.cls}">
      <span class="ty">${e.type}</span>
      ${neuronTag(e.idx)}
      <span class="cell">${t("c03.amp")} <b>${e.amp.toString()}</b></span>
      <span class="cell">${t("c03.blk")} <b>${e.block}</b></span>
      ${e.from ? `<span class="cell">${t("c03.from")} <b>${short(e.from)}</b></span>` : ""}
      <span class="cell acc" data-i="${i}">${t("c03.accum")} <b>…</b></span>
    </div>`).join("");
  // best-effort "accumulated after that block" via historical state (needs archive; guarded)
  const idxSet = new Set([39, 40, 76, 77]);
  const cells = box.querySelectorAll(".acc");
  for (let i = 0; i < Math.min(top.length, 8); i++) {
    const e = top[i];
    if (!idxSet.has(Number(e.idx))) { cells[i].innerHTML = `${t("c03.accum")} <b>${t("c03.na")}</b>`; continue; }
    try {
      const v = await brain.stim(e.idx, { blockTag: e.block });
      cells[i].innerHTML = `${t("c03.accum")} <b>${v.toString()}</b>`;
    } catch { cells[i].innerHTML = `${t("c03.accum")} <b>—</b>`; }
  }
}

// ---- observed heartbeat cadence (what "stalled" is allowed to mean) ----
// The keeper runs on an adaptive cadence, so the liveness window has to come from
// what this page actually observes, never from a block count. The contract's
// STALE_WINDOW is 20 blocks and BSC now seals well below one block per second, so
// that constant is worth seconds -- far tighter than any honest beat of this worm.
// It stays on screen for reference; it does not decide the verdict.
const CADENCE_KEY = "wbb_cadence_v1";
const MIN_STALE_SEC = 90;   // floor: a fast beat must never make the page twitchy
const CADENCE_MULT = 3;     // three learned beats with nothing = stalled
const GAP_MAX_MS = 3600e3;  // a laptop waking from sleep is not a slowed heartbeat

function loadCadence() {
  try { return JSON.parse(localStorage.getItem(CADENCE_KEY)) || { tick: null, at: 0, gap: 0 }; } catch { return { tick: null, at: 0, gap: 0 }; }
}
function saveCadence(c) { try { localStorage.setItem(CADENCE_KEY, JSON.stringify(c)); } catch { /* quota */ } }

// Fold one reading into the model. Only a CHANGING tick counts as an advance, and
// only the interval between two real advances teaches the cadence. The first
// reading is a baseline with at = 0: "here is the tick I see now" is not evidence
// that a beat just happened, and treating it as such would fabricate a LIVE.
function observeTick(c, tick, now) {
  if (c.tick === null) { c.tick = tick; c.at = 0; return c; }
  if (tick === c.tick) return c;
  if (c.at) {
    const gap = now - c.at;
    if (gap > 0 && gap < GAP_MAX_MS) c.gap = c.gap ? Math.round(0.3 * gap + 0.7 * c.gap) : gap;
  }
  c.tick = tick;
  c.at = now;
  return c;
}

function staleSeconds(c) {
  return Math.max(MIN_STALE_SEC, Math.round((CADENCE_MULT * (c.gap || 0)) / 1000));
}

// seconds-to-string in the active language: "3min" is English morphology, so the unit
// itself is a message and not something this file may spell out
const fmtAge = (s) => (s === null ? "—" : s < 90 ? t("c01.age_s", { n: s }) : s < 5400 ? t("c01.age_min", { n: Math.round(s / 60) }) : t("c01.age_h", { n: (s / 3600).toFixed(1) }));

// ---- the read, split into two cadences ----
// One measured run of the deployed page: a single open tab issued roughly 37 proxy reads
// per 100 seconds, and the beat it learned off real tick changes was about 73s. Before
// this split the same tab walked every one of its twenty-odd reads ten times a minute - on
// the order of 120 requests a minute, some 180,000 a day, against a free Workers allowance
// of 100,000 a day that the site itself also draws on. Three reads can genuinely change
// inside ten seconds: the head, the tick, and the body quantities that arrive with it.
// Nothing else can: connRoot is immutable, a state hash moves only with a beat, one beat
// is about 73s so an advance log scan and a 1500-block feed are answered often enough at a
// minute, and a reserve ratio is not a fast number. So the beat splits: a fast one for what
// is alive, a slow one for what is merely true. One render path serves both, so a slow beat
// that fails never blanks what the fast one knows, and the numbers on screen say which beat
// produced them.
const FAST_MS = 10000;
const SLOW_MS = 60000;
let hist = loadHist();
let cadence = loadCadence();
let BRAIN_ADDR = null; // resolved by the slow beat from readout.brain()

// what only the slow beat learns, held between scans so the fast beat can keep
// rendering an honest verdict rather than blanking the liveness badges out
const slow = { staleWindow: null, advBlock: null, advErrored: 0, advSpans: 0, eventAge: null, scannedAt: 0 };

// the last reading this page took, and whether the most recent one landed. Rendering is
// split out of the read so a language switch can put every sentence back into the new
// tongue immediately, from data already in hand, without asking the chain again.
let lastView = null;
let readFailed = false;

function renderStatusLine() {
  const node = el("status-text");
  if (!node) return;
  if (readFailed) { node.textContent = t("c01.status_failed"); return; }
  const v = lastView;
  if (!v) return;
  node.textContent = t("c01.status_reading", {
    head: v.head.toLocaleString(localeTag()),
    verdict: t(v.halted ? "c01.verdict_halted" : "c01.verdict_live"),
  });
}

// Pure paint: no read, no await. Everything here comes from lastView.
function renderReadout() {
  const v = lastView;
  paintRpcHost();
  if (!v) return;
  const num = (n) => n.toLocaleString(localeTag());
  setText("tick", v.tick + (v.tickB === v.tick ? "" : t("c01.tick_raw", { n: v.tickB })));
  setText("state-hash", v.stateHash);
  setText("cur-block", num(v.head));
  setText("last-adv-block", v.advBlock === null
    ? (v.advErrored ? t("c01.adv_unreadable", { e: v.advErrored, s: v.advSpans }) : t("c01.adv_none"))
    : num(v.advBlock));
  setText("since-adv", v.sinceAdv === null ? "—" : num(v.sinceAdv));
  setText("adv-age", !v.observable ? t("c01.age_none") : t("c01.age_line", {
    age: fmtAge(v.ageSec),
    event: v.eventAge === null ? t("c01.age_na") : fmtAge(v.eventAge),
    scan: v.scanLag !== null && v.eventAge !== null ? t("c01.age_scan", { x: fmtAge(v.scanLag) }) : "",
    observed: v.localAge === null ? t("c01.age_na") : fmtAge(v.localAge),
  }));
  setText("stale-window", v.cadSec
    ? t("c01.window_beat", { sec: v.windowSec, mult: CADENCE_MULT, beat: v.cadSec })
    : t("c01.window_floor", { sec: v.windowSec }));

  const badge = el("status-badge");
  if (badge) {
    badge.innerHTML = !v.observable
      ? `<span class="badge watch">${t("c01.badge_checking")}</span>`
      : v.halted
        ? `<span class="badge halt">${t("c01.badge_halted", { age: fmtAge(v.ageSec) })}</span>`
        : `<span class="badge live">${t("c01.badge_live", { age: fmtAge(v.ageSec) })}</span>`;
  }

  // the block arithmetic is a reading, not a phrase: it is computed here and handed to
  // the dictionary as a parameter, so the sentence around it can be reordered freely
  const blockMath = v.sinceAdv === null || v.secPerBlock === null
    ? ""
    : t("c01.note_blockmath", {
      since: v.sinceAdv,
      sw: v.SW,
      sec: Math.round(v.SW * v.secPerBlock),
      spb: v.secPerBlock.toFixed(2),
    });
  setText("stale-note",
    (!v.observable
      ? t("c01.note_neutral")
      : v.halted
        ? t("c01.note_halted", { age: fmtAge(v.ageSec), window: v.windowSec })
        : t("c01.note_live", { window: v.windowSec, mult: CADENCE_MULT, beat: v.cadSec ?? "?" }) + blockMath)
    + t("c01.note_cadence", { fast: FAST_MS / 1000, slow: SLOW_MS / 1000 }));

  if (v.cur) {
    drawBody(hist, v.cur);
    gauge("f-approach", "g-approach", v.cur.approach);
    gauge("f-turn", "g-turn", v.cur.turn);
    gauge("f-speed", "g-speed", v.cur.speed);
  }
  renderStatusLine();
}

async function poll(scanLogs) {
  const dot = el("dot");
  try {
    await withRotation(async (p) => {
      const head = await p.getBlockNumber();
      const readout = asContract(p, READOUT, READOUT_ABI);
      const adapterAddr = ADAPTER;
      // the pairing and the stale constant are immutable, so only the slow beat (and the
      // very first read, which has no address yet) asks for them
      if (scanLogs || !BRAIN_ADDR) {
        const [brainAddr, staleWindow] = await Promise.all([readout.brain(), readout.STALE_WINDOW()]);
        BRAIN_ADDR = brainAddr;
        slow.staleWindow = Number(staleWindow);
      }
      const brain = asContract(p, BRAIN_ADDR, BRAIN_ABI);

      // the three quantities, plus the raw tick off the brain itself so the headline
      // number is checked against the thing it claims to report instead of being taken on
      // trust from the readout. (The old code also read brain.stateHash() here and never
      // showed it: the hash on screen is the readout's own, from the same call.)
      const r = await readout.read();
      const tickB = Number((await brain.tick()).toString());

      if (scanLogs) {
        // Last advance: a bounded backward scan. A span that ERRORS is not the same fact
        // as a span with no matches: an endpoint can refuse a wide getLogs range outright,
        // and reading "rejected" as "no advance happened" would render a living worm dead.
        const { log: adv, errored, spans } = await findLatestEvent(brain, "Advanced", head, 6000, 2000);
        slow.advBlock = adv ? adv.blockNumber : null;
        slow.advErrored = errored;
        slow.advSpans = spans;
        slow.scannedAt = Date.now();
        slow.eventAge = null;
        if (adv) {
          try {
            const ab = await p.getBlock(adv.blockNumber);
            if (ab) slow.eventAge = Math.max(0, Math.round(Date.now() / 1000 - ab.timestamp));
          } catch { /* no block timestamp; the local witness still stands */ }
        }
        // identities and provenance: the pairing is frozen at deploy time and connRoot
        // never changes at all, so once a minute is plenty to state them
        const aLink = el("brain-addr"); aLink.href = bscscanAddr(BRAIN_ADDR); aLink.textContent = BRAIN_ADDR;
        const rLink = el("readout-addr"); rLink.href = bscscanAddr(READOUT); rLink.textContent = short(READOUT, 8);
        const adLink = el("adapter-addr"); adLink.href = bscscanAddr(adapterAddr); adLink.textContent = short(adapterAddr, 8);
        setText("conn-root", await brain.connRoot());
      }

      // Elapsed time since the last real advance, from two independent witnesses: the
      // block timestamp of the newest Advanced event, and the last tick change this page
      // observed with plain reads. Both measure the same fact, so the fresher one wins and
      // either proving life is enough to say LIVE - which is why a log scan up to a minute
      // old can never be the only thing standing between this page and a false halt.
      cadence = observeTick(cadence, Number(r.tick), Date.now());
      saveCadence(cadence);
      const windowSec = staleSeconds(cadence);
      const localAge = cadence.at ? Math.max(0, Math.round((Date.now() - cadence.at) / 1000)) : null;
      const witness = [slow.eventAge, localAge].filter((v) => v !== null);
      const ageSec = witness.length ? Math.min(...witness) : null;
      const observable = ageSec !== null;
      const halted = observable && ageSec > windowSec;
      const sinceAdv = slow.advBlock === null ? null : head - slow.advBlock;
      const SW = Number(slow.staleWindow);
      const scanLag = slow.scannedAt ? Math.max(0, Math.round((Date.now() - slow.scannedAt) / 1000)) : null;
      // what one block is worth in seconds right now, inferred from the two
      // witnesses themselves rather than hard-coded, so the stale-window
      // comparison below is honest about why a block count cannot be the verdict
      const secPerBlock = sinceAdv > 0 && ageSec !== null ? ageSec / sinceAdv : null;

      const cadSec = cadence.gap ? Math.round(cadence.gap / 1000) : null;
      // body: a point is recorded only for a tick this page actually saw change
      const cur = { tick: Number(r.tick), approach: Number(r.approach), turn: Number(r.turn), speed: Number(r.speed) };
      if (!hist.length || hist[hist.length - 1].tick !== cur.tick) { hist.push(cur); hist = hist.slice(-300); saveHist(hist); }

      // every word below is painted from this snapshot, by a render path that owns no
      // English of its own and that a language switch can run again on demand
      lastView = {
        tick: r.tick.toString(), tickB: tickB.toString(), stateHash: r.stateHash, head,
        advBlock: slow.advBlock, advErrored: slow.advErrored, advSpans: slow.advSpans,
        sinceAdv, SW, windowSec, cadSec, ageSec, eventAge: slow.eventAge, localAge,
        scanLag, secPerBlock, observable, halted, cur,
      };
      readFailed = false;
      renderReadout();

      // the slow set: accumulations, the sampled pool ratio and the event feeds. None of
      // them can be wrong because they were answered once a minute.
      if (scanLogs) {
        const adapter = asContract(p, adapterAddr, ADAPTER_ABI);
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
          setText("ratio-now", ratioNow.toString() + (primed ? "" : t("c03.not_primed")));
          setText("ratio-last", ratioLast.toString());
          const delta = ratioNow - BigInt(ratioLast.toString());
          setText("ratio-delta", (delta >= 0n ? "+" : "") + delta.toString());
        } catch {
          setText("ratio-now", t("c03.pair_failed"));
        }

        await buildStimList(p, head, BRAIN_ADDR, adapterAddr, { asel, aser });
      }

      dot.className = "ok";
      renderStatusLine();
    });
  } catch (e) {
    // a failed slow beat must not steal the status line from the fast one: the fast beat
    // still runs on its own interval and repaints the verdict every ten seconds
    if (!scanLogs) { dot.className = "bad"; readFailed = true; renderStatusLine(); }
    console.error(scanLogs ? "[slow read]" : "[read-only poll]", e && e.message ? e.message : e);
  }
}

function renderEvidence() {
  el("evidence").innerHTML = EVIDENCE.map((ev) => `
    <div class="ev-item">
      <div class="lbl">${t(`${ev.key}.lbl`)}</div>
      <div class="desc">${t(`${ev.key}.desc`)}</div>
      ${ev.txs.length ? ev.txs.map((h) => `<div class="hash"><a class="v mono" href="${bscscanTx(h)}" target="_blank" rel="noopener">${h}</a></div>`).join("") : ""}
      ${ev.hasNote ? `<div class="desc" style="color:var(--amber)">${t(`${ev.key}.note`)}</div>` : ""}
    </div>`).join("");
}

// ---- 3D viewer: an autoplaying demo, no chain access of any kind ----
// There is no switch to throw: the page imports the chunk itself, at boot and without
// awaiting it, so three.js comes down alongside the first chain reads instead of in
// front of them. The viewer is a self-running animation of the connectome's shape: it
// issues no RPC call at all, so it cannot fail, stall or be fooled, and it cannot imply
// that the animal is advancing when it is not. Live state belongs to the identity cards,
// not to this canvas.
let viz = null;

// The one panel the demo can leave behind: what the canvas is doing instead of a canvas.
// It is handed over with take() because the message stops being a fixed string the
// moment the demo either arrives or does not.
function vizPanel(key, params) {
  const wrap = el("viz-wrap");
  if (!wrap) return;
  let d = wrap.querySelector(".viz-off");
  if (!d) {
    d = document.createElement("div");
    d.className = "viz-off";
    d.id = "viz-off";
    wrap.appendChild(d);
  }
  label(take(d), key, params);
}

async function startViz() {
  if (viz) return;
  try {
    const { createWormViz } = await import("./worm3d.js");
    viz = await createWormViz({ container: el("viz-wrap") });
    const off = el("viz-off");
    if (off) off.remove();
  } catch (e) {
    // a decoration that fails to arrive stays a decoration: it says so in one line and
    // takes nothing else on the page down with it
    vizPanel("c00.load_fail", { m: (e && e.message) || e });
    console.error("[3d] failed to start", e && e.message ? e.message : e);
  }
}

// The poke module is one of the site's sanctioned write paths and is
// deliberately NOT part of the default page: it only loads after an explicit
// opt-in click, stays behind a pinned single-call ABI, and is fenced by its own
// smoke guards. Nothing in this file ever signs or sends.
function wirePoke() {
  const b = el("poke-enable");
  if (!b) return;
  b.addEventListener("click", async () => {
    try {
      const m = await import("./poke.js");
      m.init();
      label(b, "c04.btn_on");
      b.disabled = true;
      const f = el("poke-food"), a = el("poke-avert");
      if (f) f.disabled = false;
      if (a) a.disabled = false;
    } catch (e) {
      const s = el("poke-status");
      if (s) label(take(s), "c04.load_fail", { m: (e && e.message) || e });
    }
  }, { once: true });
}

// The wake module is the site's other move-the-animal path -- a permissionless
// advance(1, genome) the visitor pays for. Same discipline as poke: it is not on
// the default page, it loads only behind its own click, and src/wake.js pins the
// brain address and that single call.
function wireWake() {
  const b = el("wake-enable");
  if (!b) return;
  b.addEventListener("click", async () => {
    try {
      const m = await import("./wake.js");
      m.init();
      label(b, "c04.wake_btn_on");
      b.disabled = true;
      const g = el("wake-go");
      if (g) g.disabled = false;
    } catch (e) {
      const s = el("wake-status");
      if (s) label(take(s), "c04.load_fail", { m: (e && e.message) || e });
    }
  }, { once: true });
}

// Time-lapse of the recorded on-chain past: a static JSON asset and a canvas
// player, loaded only on click. Zero RPC, zero writes — a recording, not a
// live view; the live state stays on the read-only polling above.
function wireReplay() {
  const b = el("replay-load");
  if (!b) return;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const m = await import("./replay.js");
      await m.start(el("replay-stage"));
      label(b, "c06.btn_loaded");
    } catch (e) {
      b.disabled = false;
      const s = el("replay-status");
      if (s) label(take(s), "c06.load_fail", { m: (e && e.message) || e });
    }
  }, { once: true });
}

// The inscription wall: a read-only view of the immutable WormLedger, with the
// engraving form behind a second opt-in click inside wall.js. The default page
// only ever reads here — src/engrave.js is imported by that click, never by boot().
function wireWall() {
  const b = el("wall-load");
  if (!b) return;
  b.addEventListener("click", async () => {
    b.disabled = true;
    label(b, "c00.btn_loading");
    try {
      const m = await import("./wall.js");
      m.init();
      label(b, "c05.btn_online");
    } catch (e) {
      b.disabled = false;
      label(b, "c05.btn_read");
      const s = el("wall-status");
      if (s) { label(take(s), "c05.load_fail", { m: (e && e.message) || e }); s.className = "v err"; }
    }
  }, { once: true });
}

// Journal + leaderboard: a read-only card that fetches narrative entries and waker
// rankings from the project's own Worker. Lazy-imported so it never weighs on boot.
function wireJournal() {
  const b = el("journal-load");
  if (!b) return;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const m = await import("./journal.js");
      m.init();
      const rb = el("journal-refresh");
      if (rb) rb.disabled = false;
    } catch (e) {
      b.disabled = false;
      const s = el("journal-status");
      if (s) label(take(s), "c08.fail", { m: (e && e.message) || e });
    }
  }, { once: true });
}

// Perception Lab: sound + generative art. Both are purely read-only (Web Audio
// and Canvas), no wallet, no network beyond the cached snapshot fetch already
// present. Loaded behind a click to satisfy the AudioContext user-gesture rule.
function wirePerceive() {
  const sb = el("sound-enable");
  const stb = el("sound-stop");
  if (sb) {
    sb.addEventListener("click", async () => {
      try {
        const s = await import("./sound.js");
        const a = await import("./art.js");
        a.init();
        window.__wormArt = a;
        s.start();
        sb.disabled = true;
        if (stb) stb.disabled = false;
      } catch (e) {
        const st = el("sound-status");
        if (st) label(take(st), "c09.audio_fail", { m: (e && e.message) || e });
      }
    }, { once: false });
  }
  if (stb) {
    stb.addEventListener("click", async () => {
      try { const s = await import("./sound.js"); s.stop(); } catch { /* silent */ }
      stb.disabled = true;
      if (sb) sb.disabled = false;
    }, { once: false });
  }
}

// WormGuess: the fourth sanctioned write path. A permissionless prediction game
// where the answer is the worm's own next heartbeat. Loads behind its own click,
// pins WormGuess + Token, and is fenced by a dedicated smoke guard.
function wireGuess() {
  const b = el("guess-enable");
  if (!b) return;
  b.addEventListener("click", async () => {
    try {
      const m = await import("./guess.js");
      m.init();
      b.disabled = true;
      const cb = el("guess-create");
      const yb = el("guess-yes");
      const nb = el("guess-no");
      const sb = el("guess-settle");
      const kb = el("guess-claim");
      if (cb) { cb.disabled = false; cb.addEventListener("click", () => m.createRound(10)); }
      if (yb) { yb.disabled = false; yb.addEventListener("click", () => m.joinCurrent(true)); }
      if (nb) { nb.disabled = false; nb.addEventListener("click", () => m.joinCurrent(false)); }
      if (sb) { sb.disabled = false; sb.addEventListener("click", () => m.resolveRounds()); }
      if (kb) { kb.disabled = false; kb.addEventListener("click", () => m.claimWins()); }
    } catch (e) {
      const s = el("guess-status");
      if (s) label(take(s), "c04.load_fail", { m: (e && e.message) || e });
    }
  }, { once: true });
}

async function boot() {
  // the dictionary is applied before anything is drawn, so the very first paint of a
  // Chinese visitor is Chinese and never a flash of English
  initI18n();
  // the page owns the status line from here on: the boot word is already painted
  take(el("status-text"));
  setText("rpc-host", seedLabel(RPC_SEEDS[0]));
  renderEvidence();
  // not awaited: the animation is fetched while the first reads are already on their way
  startViz();
  wirePoke();
  wireWake();
  wireReplay();
  wireWall();
  wireJournal();
  wirePerceive();
  wireGuess();
  // a language switch re-renders from the reading already in hand, re-renders the static
  // evidence, and only then lets one slow beat re-word the event feed from the chain
  onLangChange(() => { renderReadout(); renderEvidence(); poll(true); });
  // the slow beat runs first: it resolves the brain address the fast beat reads the raw
  // tick from, and neither interval starts before that first pair has landed
  await poll(true);
  await poll(false);
  setInterval(() => poll(false), FAST_MS);
  setInterval(() => poll(true), SLOW_MS);
}
boot();
