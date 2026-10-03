// Read-only guarantee smoke test for the dashboard (no browser, no network).
// Asserts the shipped UI is a pure observer by default: the frozen contract
// addresses and Q20 scale are present, the HALTED staleness rule is surfaced, and
// there is NO wallet/signing/transaction path in any module the page loads on its
// own. Two modules are exempt from that global ban because they are the site's two
// sanctioned write paths -- src/poke.js and src/engrave.js -- and each of those is
// then fenced on its own, tighter than the global rule.
// Run: node frontend/test/smoke.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// the copy catalogue is part of the shipped page, so the guards below can assert on
// the wording itself instead of on wherever it happens to be spliced in
import { MESSAGES, LANGS, DEFAULT_LANG, t } from "../src/i18n.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(root, "src", "main.js"), "utf8");
// every module shipped in the bundle is covered by the read-only guard, EXCEPT the
// two opt-in write paths. Note what is deliberately NOT exempt: the inscription
// wall (src/wall.js) stays inside the global guard, so the card a visitor browses
// without paying cannot gain a signing path without failing this test. Only the
// engraving form (src/engrave.js), loaded behind a second click from wall.js, may
// touch a wallet.
const WRITE_MODULES = ["poke.js", "engrave.js"];
const srcFiles = readdirSync(join(root, "src")).filter((f) => f.endsWith(".js"));
const guardFiles = srcFiles.filter((f) => !WRITE_MODULES.includes(f));
const allSrc = guardFiles.map((f) => readFileSync(join(root, "src", f), "utf8")).join("\n");

let fail = 0;
const has = (cond, label) => { if (!cond) fail++; console.log(`${cond ? "OK  " : "FAIL"}  ${label}`); };
const absent = (src, needle, label) => has(!src.toLowerCase().includes(needle.toLowerCase()), label);
const han = /\p{Script=Han}/u;
const cjk = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\ufe30-\ufe4f\uff00-\uffef]/;
const params = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

has(main.includes("0x192004dAe2A55E20CE21A7d05E722B32c9A9b61E"), "READOUT address frozen in source");
has(main.includes("0xbe0C5117f740a9333614D806Bd50C3907186C6fD"), "ADAPTER address frozen in source");
has(main.includes("1048576n"), "Q20 SCALE constant present");
// the verdict word moved into the dictionary with the rest of the copy, so the guard
// is that the module asks for that key and that the key still means HALTED
has(main.includes('"c01.verdict_halted"') && MESSAGES["c01.verdict_halted"].en === "HALTED", "staleness rule surfaced (HALTED)");
has(/read-?only/i.test(main), "page advertises read-only");

// --- liveness verdict guards (regression fence for the false-HALTED bug) ---
// BSC seals in well under a second, so any verdict computed from a block count
// against the contract's 20-block STALE_WINDOW is a few seconds wide and will
// pronounce a living worm dead between two honest heartbeats.
has(!main.includes("sinceAdv > SW"), "verdict is not a block-count comparison");
has(main.includes("staleSeconds") && main.includes("CADENCE_MULT"), "stale window derives from the observed beat");
has(main.includes("errored"), "a rejected getLogs span is reported, not read as a stall");
has(main.includes("c.tick === null) { c.tick = tick; c.at = 0"), "a first reading is a baseline, not a fabricated LIVE");
has(main.includes('"Advanced", head, 6000, 2000'), "advance scan stays within public getLogs limits");

// The default modules must never gain a way to move the animal or spend funds.
for (const bad of ["sendTransaction", "getSigner", "new Wallet", "signer.send", "window.ethereum", "privatekey", "mnemonic"]) {
  absent(allSrc, bad, `no signing/tx path outside the two write modules: ${bad}`);
}

// --- poke module: one of the two sanctioned write paths, hard-fenced.
const poke = readFileSync(join(root, "src", "poke.js"), "utf8");
has(poke.includes('"0xbe0C5117f740a9333614D806Bd50C3907186C6fD"'), "poke targets the pinned SenseAdapter");
has(poke.includes("function inject(int256 signedIntensity) external"), "poke encodes only inject(int256)");
absent(poke, "advance(", "poke never encodes the brain's advance");
absent(poke, "stimulate(", "poke never stimulates the brain directly");
absent(poke, "0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3", "poke never points at the brain contract");
absent(poke, "privatekey", "poke never handles a raw key");
absent(poke, "mnemonic", "poke never handles a mnemonic");
// the adapter must be the ONLY contract address the module can ever talk to
const pokeAddrs = [...poke.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase());
has(pokeAddrs.length > 0 && pokeAddrs.every((a) => a === "0xbe0c5117f740a9333614d806bd50c3907186c6fd"),
  "SenseAdapter is the only address in poke.js");
// the write path must stay opt-in: main.js only dynamic-imports the module
has(main.includes('import("./poke.js")'), "poke loads lazily via dynamic import in main.js");

// --- inscription wall: the read-only half. It is already inside the global guard
// above (that is the point of splitting it from the engraver); these assertions
// cover the parts a pure text scan of the whole bundle cannot prove.
const wallSrc = readFileSync(join(root, "src", "wall.js"), "utf8");
const LEDGER_ADDR = "0x16a4d26C90fE7613f22Da41150E4847e1fE47495";
const OLD_LEDGER_ADDR = "0xb305bDcf97C26B1312E3C3b3158BAAc7cD5f6966";
const TAX_ADDR = "0xA18f90eF3d4cc543141986c80442F87a2d2a7777";
has(wallSrc.includes(LEDGER_ADDR), "wall reads the pinned WormLedger");
has(wallSrc.includes("125412554"), "wall pins the ledger deployment block as the scan floor");
has(wallSrc.includes(TAX_ADDR), "wall pins the token the ledger is paid in");
// the superseded 1-token wall must not survive in the reading module: an address
// left behind in the code is one someone could later read as the live wall
absent(wallSrc, OLD_LEDGER_ADDR, "wall no longer reads the superseded 1-token ledger");
// the event cache is keyed on the ledger, so re-pointing the wall cannot inherit
// the previous wall's cached scan floor and skip its earliest inscriptions
has(/CACHE_KEY = `wbb_wall_\$\{LEDGER\.toLowerCase\(\)\}`/.test(wallSrc),
  "the wall's cache key is derived from the ledger address, not a hand-bumped counter");
has(wallSrc.includes('"c05.err_token"') && MESSAGES["c05.err_token"].en.includes("not the token this page pins"),
  "wall refuses to quote a price if the ledger's token differs");
// a permanent on-chain string is untrusted input: it must be escaped, never spliced
has(/const esc = /.test(wallSrc) && wallSrc.includes("esc(e.text)"), "engraved text is HTML-escaped before rendering");
// an endpoint that refuses a range must not be able to impersonate an empty wall
has(wallSrc.includes('"c05.refused"') && /refused[\s\S]*not empty/.test(MESSAGES["c05.refused"].en),
  "a refused getLogs span is reported as refusal");
has(wallSrc.includes("unreadable"), "an unreadable read renders as unreadable, not as open");
has(main.includes('import("./wall.js")'), "wall loads lazily via dynamic import in main.js");

// --- engraving module: the second sanctioned write path, fenced harder than poke.
// poke.js may mix its read feed and its one write in a single file; a form that
// spends the visitor's tokens is split from its own read-only wall instead, so the
// wall stays under the global ban and only this file is exempted.
const engrave = readFileSync(join(root, "src", "engrave.js"), "utf8");
has(engrave.includes(LEDGER_ADDR), "engrave targets the pinned WormLedger");
has(engrave.includes(TAX_ADDR), "engrave pins the token it approves");
absent(engrave, OLD_LEDGER_ADDR, "engrave no longer targets the superseded 1-token ledger");
// the spending module refuses to mount unless the reading module's pins agree with
// its own, so a one-sided address change cannot produce a form at all
has(
  engrave.includes('t("c05f.pin_ledger")') && engrave.includes('t("c05f.pin_token")') &&
    MESSAGES["c05f.pin_ledger"].en.includes("a ledger it does not pin") &&
    MESSAGES["c05f.pin_token"].en.includes("a token it does not pin"),
  "engrave cross-checks the wall's addresses against its own pins");
const engraveAddrs = [...engrave.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase());
const ENGRAVE_OK = new Set([LEDGER_ADDR.toLowerCase(), TAX_ADDR.toLowerCase()]);
has(engraveAddrs.length > 0 && engraveAddrs.every((a) => ENGRAVE_OK.has(a)) && new Set(engraveAddrs).size === 2,
  "the ledger and its token are the only two addresses in engrave.js");
absent(engrave, "0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3", "engrave never points at the brain contract");
absent(engrave, "advance(", "engrave never encodes the brain's advance");
absent(engrave, "stimulate(", "engrave never stimulates the brain directly");
absent(engrave, "inject(", "engrave never injects into the adapter");
absent(engrave, "transferFrom(", "engrave never moves tokens as a third party");
absent(engrave, "new Wallet", "engrave never handles a raw key");
absent(engrave, "privatekey", "engrave never handles a private key");
absent(engrave, "mnemonic", "engrave never handles a mnemonic");
// exactly two state-changing encodings are reachable from this module
has(engrave.includes("function approve(address spender, uint256 value) returns (bool)"), "engrave encodes approve");
has(engrave.includes("function inscribe(uint256 slot, string text, uint256 nominal) external"), "engrave encodes inscribe");
const writes = [...engrave.matchAll(/\.(approve|inscribe|transfer|setApprovalForAll|mint|claim|join|createRound|settle|expire)\s*\(/g)].map((m) => m[1]);
has([...new Set(writes)].sort().join(",") === "approve,inscribe", `approve+inscribe are the only calls made (${[...new Set(writes)].sort().join(",") || "none"})`);
// every contract object is built on one of the two pinned identifiers
const newContracts = engrave.split(/\r?\n/).filter((l) => l.includes("new Contract("));
has(newContracts.length > 0 && newContracts.every((l) => /new Contract\((LEDGER|TOKEN),/.test(l.trim())),
  "every Contract() in engrave.js is built on LEDGER or TOKEN");
// the engraver must not be reachable statically from anywhere: only wall.js, and
// only through import(), may name it
for (const f of guardFiles) {
  const src = f === "main.js" ? main : readFileSync(join(root, "src", f), "utf8");
  const refs = [...src.matchAll(/["']\.\/engrave\.js["']/g)];
  has(refs.every((m) => src.slice(Math.max(0, m.index - 12), m.index).includes("import(")),
    `${f} reaches engrave.js only by dynamic import (${refs.length} ref(s))`);
}
has(wallSrc.includes('import("./engrave.js")'), "engrave is reached only by wall.js's opt-in click");
// the tax uplift: price is what must ARRIVE, so the form must send more than price
has(/ARRIVE_BPS\s*=\s*9700n/.test(engrave) && /MARGIN_BPS\s*=\s*10200n/.test(engrave),
  "engrave builds the nominal from the arrival rate, not the raw price");

// --- embeddable badge: public/badge.html is read-only eth_call with a pinned
// tick() selector; it must stay free of any signing or state-changing path.
const badge = readFileSync(join(root, "public", "badge.html"), "utf8");
has(badge.includes("0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3"), "badge points at the canonical brain");
has(badge.includes("0x3eaf5d9f"), "badge pins the tick() selector");
for (const bad of ["sendTransaction", "getSigner", "window.ethereum", "privatekey", "mnemonic", "advance(", "stimulate(", "inject("]) {
  absent(badge, bad, `badge.html stays read-only: ${bad}`);
}
// the badge is embedded on other people's sites and imports nothing, so it carries
// its own two languages: assert that it holds both for every one of its strings and
// that English stays the default when nobody asks for Chinese
{
  const bEn = [...badge.matchAll(/en: "([^"]*)"/g)].map((m) => m[1]);
  const bZh = [...badge.matchAll(/zh: "([^"]*)"/g)].map((m) => m[1]);
  has(bEn.length > 0 && bEn.length === bZh.length && bZh.every((s) => han.test(s)) &&
      bEn.every((s, i) => params(s) === params(bZh[i])),
    `badge.html ships its own two languages with matching parameters (${bEn.length} strings)`);
  has(badge.includes('want === "zh" ? "zh" : "en"'), "badge.html is English unless ?lang=zh or the stored choice says Chinese");
}

// --- time-lapse: the player is a static-asset recording (src/replay.js is
// already inside the global read-only src guard); assert the recording itself
// is complete, quantized as documented, and wired into the page.
const replayHtml = readFileSync(join(root, "index.html"), "utf8");
has(replayHtml.includes("card-replay"), "time-lapse card present on the dashboard");
has(replayHtml.includes('id="card-wall"') && replayHtml.includes('<span class="num">05</span>'), "inscription wall card is numbered 05 on the dashboard");
// the prose in the page must name the wall the modules actually read, and tell the
// visitor the old one still exists at its own immutable price
has(replayHtml.includes(LEDGER_ADDR), "the page names the live ledger the wall modules read");
has(replayHtml.includes(OLD_LEDGER_ADDR) && replayHtml.includes("superseded"), "the page discloses the superseded 1-token wall");
absent(replayHtml, "0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3", "the wall card names no brain address: the ledger is the only entry point");
// --- the project's own two front doors: the account it speaks from and the repository
// it is built in. A drifted URL sends visitors somewhere that is not this project.
for (const url of ["https://x.com/WormBrainBsc", "https://github.com/EvolutionDeep/WBB"]) {
  has(replayHtml.includes(`href="${url}"`), `the page links out to ${url}`);
}
// in the header, above the dashboard, so they are seen before anyone scrolls
const headerHtml = replayHtml.slice(0, replayHtml.indexOf('<div class="grid">'));
has(/class="links"[\s\S]*?x\.com\/WormBrainBsc[\s\S]*?github\.com\/EvolutionDeep\/WBB[\s\S]*?<\/nav>/.test(headerHtml),
  "both outbound links sit in the header, above the card grid");
// and no anchor may open a new tab while leaving the new page the ability to reach back
{
  const naked = [...replayHtml.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].filter((m) => !/rel="[^"]*noopener/.test(m[0]));
  has(naked.length === 0, `every new-tab anchor declares rel=noopener (${naked.length} without it)`);
}
{
  // every element id the two wall modules touches must exist in the shipped HTML,
  // or the card would silently half-render against a null node
  const ids = [...wallSrc.matchAll(/(?:\bel|setText)\("([a-z-]+)"/g), ...engrave.matchAll(/(?:\bel|setText)\("([a-z-]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(ids.filter((i) => !replayHtml.includes(`id="${i}"`)))];
  has(missing.length === 0, `every wall element id exists in index.html (missing: ${missing.join(", ") || "none"})`);
}
const replay = JSON.parse(readFileSync(join(root, "public", "data", "replay.json"), "utf8"));
has(replay.frames.length === replay.meta.frames, "replay frame count matches its own meta");
has(replay.frames.every((f, i) => f.t === i + 1), "replay ticks are contiguous from 1");
has(replay.frames.every((f) => f.v.length === 604 && f.pose.length === 16), "replay frames carry 302 int8 voltages + 4 int16 pose words");
const rp = readFileSync(join(root, "src", "replay.js"), "utf8");
has(rp.includes('"/data/replay.json"'), "player reads the static recording, not an RPC");
for (const bad of ["fetch(", "eth_call", "JsonRpcProvider", "Contract("]) {
  // exactly one fetch is allowed: the static JSON asset itself
  const count = rp.split(bad).length - 1;
  has(bad !== "fetch(" ? count === 0 : count === 1, `player stays off the network beyond the asset (${bad}: ${count})`);
}

// --- 3D viewer: it is a self-running demo now, so the guard is stronger than "read-only"
// — it must hold no chain access whatsoever, must load only its two local anatomy files,
// and its own HUD must keep saying out loud that the motion is invented.
const viz = readFileSync(join(root, "src", "worm3d.js"), "utf8");
absent(viz, "ethers", "3D demo imports no ethereum client");
absent(viz, "JsonRpcProvider", "3D demo opens no provider");
absent(viz, "eth_call", "3D demo issues no eth_call");
absent(viz, "https://", "3D demo names no remote endpoint");
absent(viz, "advance(", "3D demo never encodes a state-changing advance()");
absent(viz, "stimulate(", "3D demo never encodes stimulate()");
absent(viz, "inject(", "3D demo never encodes inject()");
has(
  viz.includes('fetch("data/graph.json")') && viz.includes('fetch("data/layout.json")'),
  "3D demo loads only its two local anatomy files",
);
// the HUD text is looked up per frame, so the assertion has to reach the dictionary:
// a comment that still says DEMO is not the page telling the visitor so
has(
  viz.includes('t("c00.hud_demo")') && viz.includes('t("c00.hud_synthetic")') &&
    MESSAGES["c00.hud_demo"].en.includes("DEMO") && MESSAGES["c00.hud_synthetic"].en.includes("synthetic"),
  "3D HUD states the motion is a synthetic demo",
);
has(
  viz.includes("function rimMaterial") && viz.includes("membranes"),
  "3D demo shades the cells with a fresnel membrane rim",
);
has(
  viz.includes("function placeOrgans") && viz.includes("pharynx"),
  "3D demo draws the pharynx bulb on its own pumping clock",
);
absent(viz, "HALTED", "3D demo no longer claims to report chain liveness");
absent(main, "getTarget", "the demo is handed no chain target");
// ---- the demo plays by itself ----
// A visitor who has to find a button before the animation exists is a visitor who never
// sees the animation, and the gate cost three things: the click, the idle panel telling
// them to click, and a STOP that could strand the canvas on a screen nobody asked for.
// Autoplay removes all three, so the guard is that nothing is left to click.
has(
  main.includes('await import("./worm3d.js")') && /boot\(\)[\s\S]*startViz\(\);/.test(main),
  "the 3D chunk is imported by the page itself on boot",
);
has(
  !main.includes('"viz-start"') && !main.includes('"viz-stop"') && !main.includes("stopViz"),
  "no start/stop handler survives in the page logic",
);
has(
  !replayHtml.includes("viz-start") && !replayHtml.includes("viz-stop") &&
    replayHtml.includes('data-i18n="c00.loading"'),
  "the viewer markup carries no buttons, only the panel shown while the chunk arrives",
);

const graph = JSON.parse(readFileSync(join(root, "public", "data", "graph.json"), "utf8"));
const layout = JSON.parse(readFileSync(join(root, "public", "data", "layout.json"), "utf8"));
has(graph.nNeurons === 302, "graph.json carries 302 neurons");
has(graph.names.indexOf("ADEL") >= 0 && hasDir(graph, "ADEL", "RIH"), "graph.json direction is pre -> post (ADEL -> RIH present)");
has(layout.neurons.length === 302, "layout.json carries 302 neuron placements");
has(
  layout.neurons.every((nb) => typeof nb.cls === "string"),
  "every placement names a class, which is what the demo colours neurons by",
);

function hasDir(g, a, b) {
  const ia = g.names.indexOf(a), ib = g.names.indexOf(b);
  return g.edges.some(([s, d]) => s === ia && d === ib);
}

// ---- where the browser reads from ----
// The project's own read-only worker leads (it prefers the metered gateway and falls
// back to free nodes there), and a free BSC node stays behind it in the browser too, so
// a worker hiccup degrades the page instead of blinding it.
const WORKER_READ = "https://api.bscworm.com/api/rpc";
const READERS = [["main.js", main], ["wall.js", wallSrc], ["poke.js", poke]];
for (const [name, src] of READERS) {
  const at = src.indexOf(WORKER_READ);
  has(at >= 0, `${name} leads its read endpoints with the worker proxy`);
  const free = Math.min(...["bsc-dataseed", "publicnode"].map((s) => { const i = src.indexOf(s, at); return i < 0 ? Infinity : i; }));
  has(free > at, `${name} keeps a free BSC node behind the proxy as failover`);
}
// the gateway key belongs to the worker alone: nothing shipped to a visitor may carry one
for (const [name, src] of [...READERS, ["worm3d.js", viz]]) {
  has(!/alchemy|infura|ankr|quicknode|pocket\.tech/i.test(src), `${name} holds no gateway credential of its own`);
}
has(
  main.includes("seedLabel(RPC_SEEDS[") && main.includes('"c01.rpc_label"') &&
    MESSAGES["c01.rpc_label"].en.includes("worker -> BSC"),
  "the footer says the proxy carries the read, it does not present itself as the source",
);
// queryFilter accepts an event NAME (or a topic hash), not an EventFragment object:
// passing the fragment threw INVALID_ARGUMENT, and every span swallowed it as a
// rejected log range -- the endpoint got blamed for our own bad call, and the stimulus
// feed silently rendered a chain full of injections as an empty list.
has(!/queryFilter\(\s*contract\.interface\.getEvent/.test(main), "log scans pass an event name to queryFilter, not a fragment object");
has(/queryFilter\(eventName/.test(main), "the live/halted scan and the stimulus feed both read by name");

// ---- two cadences, one request budget ----
// A measured run of the deployed page learned a heartbeat of about 73 seconds off real
// tick changes, yet this page used to walk its whole twenty-odd reads ten times a minute:
// one open tab was on the order of 120 requests a minute, some 180,000 a day, against a
// free Workers allowance of 100,000 a day that the site itself also draws on. Only the
// head, the tick and the body quantities can change inside ten seconds; everything else
// moved behind scanLogs. A visitor sees no difference and the meter only moves in the
// Cloudflare dashboard, so nothing but this test notices if a wide log scan creeps back
// onto the fast beat.
has(/const FAST_MS = 10000;/.test(main) && /const SLOW_MS = 60000;/.test(main), "the read declares two cadences, not one interval for everything");
has(!main.includes("POLL_MS"), "the single-cadence poll is gone rather than kept alongside");
has(/setInterval\(\(\) => poll\(false\), FAST_MS\)/.test(main) && /setInterval\(\(\) => poll\(true\), SLOW_MS\)/.test(main),
  "the fast beat runs without a log scan and the slow beat with one");
// Containment is tested by indentation rather than by counting braces: a statement that
// sits inside one of the gated blocks is indented past the common path, and a statement
// both beats walk stays at the poll's own level. This also survives the gate being written
// as `if (scanLogs || !BRAIN_ADDR)`, which is how the first read resolves the pairing.
const gateStart = main.indexOf("if (scanLogs");
const lineIndent = (idx) => {
  const start = main.lastIndexOf("\n", idx) + 1;
  return ((main.slice(start).match(/^ */) || [""])[0] || "").length;
};
const callSites = (needle) => [...main.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c), "g"))].map((m) => m.index);
has(gateStart > 0, "the slow beat is gated inside the poll");
// the cheap half: exactly one call site, and it is on the path both beats walk
for (const [what, call] of [["the readout read", "await readout.read()"], ["the raw tick cross-check", "await brain.tick()"]]) {
  const hits = callSites(call);
  has(hits.length === 1 && lineIndent(hits[0]) === 6, `${what} runs on every beat, gated or not`);
}
// the expensive half: exactly one call site each, and it lives inside a gated block
const SLOW_ONLY = [
  ["the advance log scan", 'findLatestEvent(brain, "Advanced"'],
  ["the connectome root", 'setText("conn-root"'],
  ["the readout pairing", "readout.STALE_WINDOW()"],
  ["the stimulus accumulations", "brain.stim(39)"],
  ["the sampled reserve ratio", "await pair.getReserves()"],
  ["the event feed", "await buildStimList("],
];
for (const [what, call] of SLOW_ONLY) {
  const hits = callSites(call);
  has(hits.length === 1 && hits[0] > gateStart && lineIndent(hits[0]) >= 8,
    `${what} is read only on the slow beat (${hits.length} call site(s))`);
}
// both witnesses survive the split, and the fresher one still decides
has(main.includes("[slow.eventAge, localAge]"), "the tick witness and the log witness are both kept, the fresher decides");
has((main.match(/setText\("state-hash"/g) || []).length === 1, "one beat owns the state hash, so the two cadences cannot disagree on screen");
has(main.includes('"c01.note_cadence"') && MESSAGES["c01.note_cadence"].en.includes("advance log re-scanned every"),
  "the page tells the visitor both intervals instead of silently reading less");
// --- languages: the page boots in English and switches to Chinese. The dictionary is
// the only place a visitor's Chinese may live, so these guards are about completeness
// (one key, both languages, the same parameters), about the Chinese actually being
// Chinese rather than English copied twice, and about every call site naming a key that
// exists -- an unresolved key would print its own name on the page.
has(DEFAULT_LANG === "en" && LANGS.join("/") === "en/zh", "the page boots in English and offers exactly two languages");
{
  const keys = Object.keys(MESSAGES);
  const noEn = keys.filter((k) => !MESSAGES[k].en);
  const noZh = keys.filter((k) => !MESSAGES[k].zh);
  has(!noEn.length && !noZh.length, `every key carries both languages (missing en: ${noEn.join(",") || "none"}, missing zh: ${noZh.join(",") || "none"})`);
  // two entries allowed to hold no Han: the button names the language it is OFFERING,
  // so in English mode its own text is the Chinese for "switch to Chinese", and the
  // engraver's live preview is a character counter whose only difference between the
  // two languages is the shape of the quotation marks around the drafted text
  const noHan = keys.filter((k) => !han.test(MESSAGES[k].zh) && k !== "head.lang_btn" && k !== "c05f.preview");
  has(!noHan.length, `every Chinese entry is really Chinese (${noHan.join(",") || "none"})`);
  has(han.test(MESSAGES["head.lang_btn"].en) && !han.test(MESSAGES["head.lang_btn"].zh),
    "the language button names the language it offers, not the one already on screen");
  const sameTwice = keys.filter((k) => MESSAGES[k].zh === MESSAGES[k].en && k !== "c05f.preview");
  has(!sameTwice.length, `no key is quietly left untranslated (${sameTwice.join(",") || "none"})`);
  const offParams = keys.filter((k) => params(MESSAGES[k].en) !== params(MESSAGES[k].zh));
  has(!offParams.length, `both languages take the same parameters (${offParams.join(",") || "none"})`);
  // a key typed at a call site the dictionary does not carry would show itself on the
  // page, so every literal in the shipped modules and the shipped HTML has to resolve.
  // The evidence rows compose theirs ("c07.1" + ".lbl"), so a stem of real keys counts.
  const keyLit = /["'`]((?:head|foot|c\d{2}[a-z]*)\.[A-Za-z0-9_]+)["'`]/g;
  const attrLit = /data-i18n(?:-html|-placeholder|-title)?="([^"]+)"/g;
  const unresolved = [];
  for (const [name, src] of [...srcFiles.map((f) => [`src/${f}`, readFileSync(join(root, "src", f), "utf8")]), ["index.html", replayHtml]]) {
    for (const m of src.matchAll(keyLit)) {
      if (!MESSAGES[m[1]] && !keys.some((k) => k.startsWith(m[1] + "."))) unresolved.push(`${m[1]} in ${name}`);
    }
    for (const m of src.matchAll(attrLit)) {
      if (!MESSAGES[m[1]]) unresolved.push(`${m[1]} in ${name} (attribute)`);
    }
  }
  has(!unresolved.length, `every key the modules and the page name exists (${[...new Set(unresolved)].slice(0, 6).join(", ") || "none"} unresolved)`);
  has(keys.length > 200, `the catalogue covers the whole page (${keys.length} keys)`);
}
has(t("c01.no.such.key") === "c01.no.such.key", "an unknown key prints itself: a missing translation is visible, not thrown");
{
  // Chinese is UI copy, not source commentary: comments, the README and every document
  // stay English, so CJK is confined to the two dictionaries and the one button in the
  // HTML that offers the other language.
  const leaky = [];
  for (const f of srcFiles.filter((n) => n !== "i18n.js")) {
    const hits = readFileSync(join(root, "src", f), "utf8").split(/\r?\n/).filter((l) => cjk.test(l));
    if (hits.length) leaky.push(`src/${f} (${hits.length} line(s))`);
  }
  if (replayHtml.split(/\r?\n/).some((l) => cjk.test(l) && !l.includes("lang-toggle"))) leaky.push("index.html outside the language button");
  if (cjk.test(readFileSync(join(root, "..", "README.md"), "utf8"))) leaky.push("README.md");
  has(!leaky.length, `Chinese lives only in the dictionaries (${leaky.join(", ") || "every module, the HTML prose and the README are CJK-free"})`);
}
has(replayHtml.includes('id="lang-toggle"'), "the language switch is on the page itself, not only in a URL parameter");

console.log(`scanned ${srcFiles.length} src modules (read-only guard on ${guardFiles.length}, dedicated fences on ${WRITE_MODULES.join(" and ")}): ${srcFiles.join(", ")}`);
console.log(fail ? `\n${fail} FAILURE(S)` : "\nFRONTEND READ-ONLY SMOKE PASSED");
process.exitCode = fail ? 1 : 0;
