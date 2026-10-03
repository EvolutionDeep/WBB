/**
 * The inscription wall — a READ-ONLY view of the deployed WormLedger.
 *
 * What this module may do: eth_call and eth_getLogs against two pinned contracts
 * (the ledger and the token it is paid in), and render what the chain already
 * knows. What it may NOT do: touch a wallet, sign, or send. The smoke test keeps
 * this file inside the GLOBAL read-only guard, so adding a signing path here
 * fails the build instead of shipping.
 *
 * Engraving lives in a separate opt-in module (src/engrave.js), loaded by dynamic
 * import only after an explicit click. That split is deliberate: poke.js mixes its
 * read feed and its write path in one fenced file, and for a poke that is enough.
 * A wall people browse without any intention of paying deserves a module that
 * provably cannot spend anything.
 *
 * Two facts shape the code:
 *   - WormLedger is immutable and keeps no index of who engraved what, so the only
 *     complete record is the Inscribed event log. Public gateways cap getLogs
 *     ranges, so the scan runs in bounded spans that are INCREMENTAL across loads
 *     (cached in localStorage) under a per-load budget, rather than re-syncing the
 *     whole chain history on every paint.
 *   - a span that ERRORS is not the same fact as a span with no matches. Refusal is
 *     reported as refusal, never rendered as "nobody has engraved anything".
 */
import { Interface } from "ethers";
import { t, label, take, onLangChange, localeTag } from "./i18n.js";

/// the ledger, and the block it was deployed in: the left edge of any honest scan
export const LEDGER = "0x16a4d26C90fE7613f22Da41150E4847e1fE47495";
export const LEDGER_BLOCK = 125412554;
/// the tax token inscriptions are paid and burned in
export const TOKEN = "0xA18f90eF3d4cc543141986c80442F87a2d2a7777";

const WALL_ABI = [
  "function brain() view returns (address)",
  "function token() view returns (address)",
  "function ticksPerSlot() view returns (uint256)",
  "function price() view returns (uint256)",
  "function MAX_TEXT_LEN() view returns (uint256)",
  "function taken() view returns (uint256)",
  "function currentSlot() view returns (uint256)",
  "function entries(uint256 slot) view returns (address author, uint64 blockAt, uint256 tickAt, uint256 nominal, uint256 burned, string text)",
  "event Inscribed(uint256 indexed slot, address indexed author, uint256 tickFrom, uint256 tickTo, uint256 nominal, uint256 burned, string text)",
];
const TOKEN_ABI = ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const BRAIN_ABI = ["function tick() view returns (uint256)"];

// The worker proxy leads: it forwards this module's 24-call batches and its 2000-block
// log chunks to the metered gateway, which answers every member in order, and falls back
// to the free nodes when that gateway is unavailable. The free endpoints stay listed after
// it so a worker hiccup still leaves the wall readable.
const RPCS = [
  "https://api.bscworm.com/api/rpc",
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed1.bnbchain.org",
  "https://bsc-dataseed2.bnbchain.org",
];

const CHUNK = 2000;      // blocks per getLogs span, inside public log limits
const SPANS = 6;         // spans walked per refresh: the cache carries the rest
const TILES = 24;        // slots rendered as wall tiles
const REFRESH_MS = 45000;
// keyed by the ledger itself, because the event history in it belongs to one
// deployment: a hand-bumped counter would let a re-priced wall inherit the old
// wall's cached scan floor and quietly skip its earliest inscriptions.
const CACHE_KEY = `wbb_wall_${LEDGER.toLowerCase()}`;

const wall = new Interface(WALL_ABI);
const erc20 = new Interface(TOKEN_ABI);
const brainAbi = new Interface(BRAIN_ABI);
const INSCRIBED_TOPIC = wall.getEvent("Inscribed").topicHash;

const el = (id) => document.getElementById(id);
const setText = (id, v) => { const n = el(id); if (n) n.textContent = v; };
const shortAddr = (a, n = 6) => (a && a.length > n * 2 + 2 ? `${a.slice(0, n)}…${a.slice(-n)}` : a || "—");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hex = (n) => "0x" + BigInt(n).toString(16);

/** price is what must ARRIVE. The token keeps 3% on transfer, so the nominal worth
 *  sending is price / 0.97 rounded up. Anything above the price that arrives is
 *  burned by the ledger as well, so over-sending never leaks to a treasury -- it
 *  only burns a little more of the sender's own balance. */
export const minNominal = (price) => (price * 10000n + 9699n) / 9700n;

/** format an 18-decimal wei amount without floating point, 4 decimals shown */
export function fmt(wei, dec = 18) {
  const s = BigInt(wei).toString().padStart(Number(dec) + 1, "0");
  const whole = s.slice(0, s.length - Number(dec)) || "0";
  return `${whole}.${s.slice(-Number(dec)).slice(0, 4)}`;
}

async function rpc(method, params) {
  let last = null;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error("no endpoint answered");
}

/**
 * One request, many reads. Every member is checked on its own: a gateway that
 * answers a 24-call batch with 23 items, or slips an error object in where a
 * result belongs, has to leave a visible hole -- not a confidently wrong tile.
 * null means "this read is unreadable", which the caller renders as such.
 */
async function batch(to, datas) {
  const out = new Array(datas.length).fill(null);
  for (const url of RPCS) {
    try {
      const payload = datas.map((d, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to, data: d }, "latest"] }));
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!Array.isArray(j) || j.length !== datas.length) {
        throw new Error(`batch answered ${Array.isArray(j) ? j.length : typeof j} items for ${datas.length} calls`);
      }
      for (const item of j) {
        if (!item || typeof item !== "object" || item.error || typeof item.result !== "string") throw new Error("batch member unusable");
        out[item.id] = item.result;
      }
      return out;
    } catch { /* try the next endpoint with the same payload */ }
  }
  return out;
}

const cache = {
  read() {
    try {
      const v = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      return v && typeof v.to === "number" && Array.isArray(v.rows) ? v : { to: LEDGER_BLOCK - 1, rows: [] };
    } catch { return { to: LEDGER_BLOCK - 1, rows: [] }; }
  },
  write(v) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch { /* private mode: the scan simply restarts */ } },
};

function status(key, params, cls) {
  const s = el("wall-status");
  if (!s) return;
  lastStatus = { key, params: params || null, cls: cls || "" };
  label(take(s), key, params);
  s.className = "v " + (cls || "");
}

let lastStatus = null;

/// the wall re-reads on a language switch rather than translating a half-truth: every
/// number on this card comes from the chain, and the wording around it is the point
function repaintStatus() {
  if (lastStatus) status(lastStatus.key, lastStatus.params, lastStatus.cls);
}

/// the last complete read, kept so that an armed engraver can prefill its form from
/// numbers that were already on screen instead of making its own call
let lastFacts = null;

/** Walk the Inscribed log forward from the cached left edge in bounded spans. */
async function scanEvents(head) {
  const st = cache.read();
  let from = st.to + 1;
  let refused = 0;
  for (let i = 0; i < SPANS && from <= head; i++, from += CHUNK) {
    const to = Math.min(head, from + CHUNK - 1);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ address: LEDGER, topics: [INSCRIBED_TOPIC], fromBlock: hex(from), toBlock: hex(to) }]);
    } catch { refused++; break; }
    for (const lg of logs) {
      let p;
      try { p = wall.parseLog({ topics: lg.topics, data: lg.data }); } catch { continue; }
      st.rows.push({
        slot: p.args.slot.toString(), author: p.args.author, text: p.args.text,
        tickFrom: p.args.tickFrom.toString(), tickTo: p.args.tickTo.toString(),
        nominal: p.args.nominal.toString(), burned: p.args.burned.toString(),
        block: Number(BigInt(lg.blockNumber)), tx: lg.transactionHash,
      });
    }
    st.to = to;
  }
  // an overlapping re-scan must never show an engraving twice
  const seen = new Set();
  st.rows = st.rows.filter((r) => {
    const k = `${r.slot}/${r.tx}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // rows are appended oldest-block-first, so trimming keeps the recent wall. This is
  // a cache of a fallback only: the tiles themselves come from entries() reads, and
  // an unbounded cache would eventually hit the localStorage quota and stop
  // persisting, which would silently send every visit back to genesis.
  const MAX_ROWS = 2000;
  if (st.rows.length > MAX_ROWS) st.rows = st.rows.slice(-MAX_ROWS);
  cache.write(st);
  return { rows: st.rows, refused, scannedTo: st.to };
}

/** Read the ledger's own wiring. If it is not bound to the contract pair this page
 *  pins, the numbers on screen would be meaningless, so the card refuses to speak. */
async function facts() {
  const names = ["currentSlot", "price", "ticksPerSlot", "taken", "MAX_TEXT_LEN", "brain", "token"];
  const res = await batch(LEDGER, names.map((m) => wall.encodeFunctionData(m)));
  if (res.some((r) => !r)) throw new Error(t("c05.err_getters"));
  const d = names.map((m, i) => wall.decodeFunctionResult(m, res[i])[0]);
  const [currentSlot, price, ticksPerSlot, taken, maxLen, brainAddr, tokenAddr] = d;
  if (String(tokenAddr).toLowerCase() !== TOKEN.toLowerCase()) {
    throw new Error(t("c05.err_token", { a: shortAddr(tokenAddr, 10) }));
  }
  const meta = await batch(TOKEN, ["symbol", "decimals"].map((m) => erc20.encodeFunctionData(m)));
  const symbol = meta[0] ? String(erc20.decodeFunctionResult("symbol", meta[0])[0]) : "TOKEN";
  const decimals = meta[1] ? Number(erc20.decodeFunctionResult("decimals", meta[1])[0]) : 18;
  const tickRaw = await batch(brainAddr, [brainAbi.encodeFunctionData("tick")]);
  const tick = tickRaw[0] ? String(brainAbi.decodeFunctionResult("tick", tickRaw[0])[0]) : "—";
  return { currentSlot: Number(currentSlot), price, ticksPerSlot: Number(ticksPerSlot), taken: Number(taken), maxLen: Number(maxLen), brainAddr, tick, symbol, decimals, minNominal: minNominal(price) };
}

async function renderTiles(f, rows) {
  const grid = el("wall-grid");
  if (!grid) return;
  const first = Math.max(0, f.currentSlot - (TILES - 1));
  const slots = [];
  for (let s = f.currentSlot; s >= first; s--) slots.push(s);
  const res = await batch(LEDGER, slots.map((s) => wall.encodeFunctionData("entries", [s])));
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  const decoded = new Map();
  slots.forEach((s, i) => {
    if (!res[i]) return;
    try {
      const e = wall.decodeFunctionResult("entries", res[i]);
      if (e.text) decoded.set(String(s), { author: e.author, text: e.text, tickAt: e.tickAt.toString(), burned: e.burned.toString() });
    } catch { /* fall through to the event log, then to "unreadable" */ }
  });
  grid.innerHTML = slots.map((s, i) => {
    const key = String(s);
    const e = decoded.get(key) || bySlot.get(key);
    const slotLabel = t("c05.slot", { n: s });
    if (e) {
      const burned = e.burned ? t("c05.burned", { n: fmt(e.burned, f.decimals), sym: f.symbol }) : "";
      return `<div class="tile taken" title="${esc(t("c05.tile_tip", { tick: e.tickAt, burned }))}">` +
        `<span class="slot">${slotLabel}</span><span class="txt">${esc(e.text)}</span>` +
        `<span class="who">${shortAddr(e.author)}</span></div>`;
    }
    if (res[i] === null) {
      return `<div class="tile unknown"><span class="slot">${slotLabel}</span><span class="txt">${t("c05.tile_unknown")}</span></div>`;
    }
    return `<div class="tile open"><span class="slot">${slotLabel}</span><span class="txt">${t("c05.tile_open", { max: f.maxLen })}</span></div>`;
  }).join("");
}

function renderLog(f, rows) {
  const list = el("wall-log");
  if (!list) return;
  const recent = [...rows].sort((a, b) => Number(b.slot) - Number(a.slot)).slice(0, 20);
  if (!recent.length) {
    list.innerHTML = `<div class="note">${t("c05.log_empty")}</div>`;
    return;
  }
  list.innerHTML = recent.map((r) =>
    `<div class="ev-item"><div class="lbl">${t("c05.slot", { n: r.slot })} · ${esc(r.text)}</div>` +
    `<div class="hash">${t("c05.log_line", {
      author: shortAddr(r.author), from: r.tickFrom, to: r.tickTo,
      burned: t("c05.burned", { n: fmt(r.burned || 0, f.decimals), sym: esc(f.symbol) }), block: r.block,
    })} ` +
    `<a href="https://bscscan.com/tx/${r.tx}" target="_blank" rel="noopener">${shortAddr(r.tx, 8)}</a></div></div>`).join("");
}

async function refresh(showBusy) {
  try {
    if (showBusy) status("c05.reading", null, "");
    const head = Number(BigInt(await rpc("eth_blockNumber", [])));
    const f = await facts();
    lastFacts = f;
    const scan = await scanEvents(head);
    setText("wall-price", t("c05.price", { n: fmt(f.price, f.decimals), sym: f.symbol }));
    setText("wall-min", t("c05.floor", { n: fmt(f.minNominal, f.decimals), sym: f.symbol }));
    setText("wall-ticks", t("c05.span", { ticks: f.ticksPerSlot }));
    setText("wall-cur-slot", t("c05.cur_slot", { slot: f.currentSlot, tick: f.tick }));
    setText("wall-taken", t("c05.taken", { n: f.taken }));
    const edge = scan.scannedTo >= head ? t("c05.edge_all", { head }) : t("c05.edge_part", { to: scan.scannedTo, head });
    setText("wall-scan", scan.refused ? edge + t("c05.refused", { n: scan.refused }) : edge);
    await renderTiles(f, scan.rows);
    renderLog(f, scan.rows);
    status("c05.read_at", { time: new Date().toLocaleTimeString(localeTag()) }, "ok");
    const b = el("wall-enable");
    if (b && !b.dataset.armed) b.disabled = false;
    return f;
  } catch (e) {
    status("c05.unreadable", { m: (e && e.shortMessage) || (e && e.message) || e }, "err");
    return null;
  }
}

export function init() {
  const enable = el("wall-enable");
  const rescan = el("wall-rescan");
  if (rescan) rescan.addEventListener("click", () => { try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ } refresh(true); });
  if (enable) {
    enable.addEventListener("click", async () => {
      enable.disabled = true;
      label(enable, "c00.btn_loading");
      try {
        const m = await import("./engrave.js");
        // the engraver is handed only the two pinned addresses, a snapshot of what
        // this module has already READ, and a way to re-read it. It gets no wallet,
        // no provider and no permission to touch the chain on its own.
        if (!lastFacts) await refresh(true);
        await m.mount({ ledger: LEDGER, token: TOKEN, facts: () => lastFacts, refresh: () => refresh(true) });
        const form = el("wall-form");
        if (form) form.classList.remove("hidden");
        enable.dataset.armed = "1";
        label(enable, "c05.btn_armed");
        status("c05f.armed", null, "ok");
      } catch (e) {
        label(enable, "c05.btn_enable");
        enable.disabled = false;
        status("c05f.load_fail", { m: (e && e.message) || e }, "err");
      }
    }, { once: false });
  }
  onLangChange(() => { repaintStatus(); refresh(false); });
  refresh(true);
  setInterval(() => refresh(false), REFRESH_MS);
}
