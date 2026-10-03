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

has(main.includes("0x192004dAe2A55E20CE21A7d05E722B32c9A9b61E"), "READOUT address frozen in source");
has(main.includes("0xbe0C5117f740a9333614D806Bd50C3907186C6fD"), "ADAPTER address frozen in source");
has(main.includes("1048576n"), "Q20 SCALE constant present");
has(main.includes("HALTED"), "staleness rule surfaced (HALTED)");
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
const LEDGER_ADDR = "0xb305bDcf97C26B1312E3C3b3158BAAc7cD5f6966";
const TAX_ADDR = "0xA18f90eF3d4cc543141986c80442F87a2d2a7777";
has(wallSrc.includes(LEDGER_ADDR), "wall reads the pinned WormLedger");
has(wallSrc.includes("125402131"), "wall pins the ledger deployment block as the scan floor");
has(wallSrc.includes(TAX_ADDR), "wall pins the token the ledger is paid in");
has(wallSrc.includes('not the token this page pins'), "wall refuses to quote a price if the ledger's token differs");
// a permanent on-chain string is untrusted input: it must be escaped, never spliced
has(/const esc = /.test(wallSrc) && wallSrc.includes("esc(e.text)"), "engraved text is HTML-escaped before rendering");
// an endpoint that refuses a range must not be able to impersonate an empty wall
has(wallSrc.includes("refused") && wallSrc.includes("not empty"), "a refused getLogs span is reported as refusal");
has(wallSrc.includes("unreadable"), "an unreadable read renders as unreadable, not as open");
has(main.includes('import("./wall.js")'), "wall loads lazily via dynamic import in main.js");

// --- engraving module: the second sanctioned write path, fenced harder than poke.
// poke.js may mix its read feed and its one write in a single file; a form that
// spends the visitor's tokens is split from its own read-only wall instead, so the
// wall stays under the global ban and only this file is exempted.
const engrave = readFileSync(join(root, "src", "engrave.js"), "utf8");
has(engrave.includes(LEDGER_ADDR), "engrave targets the pinned WormLedger");
has(engrave.includes(TAX_ADDR), "engrave pins the token it approves");
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

// --- time-lapse: the player is a static-asset recording (src/replay.js is
// already inside the global read-only src guard); assert the recording itself
// is complete, quantized as documented, and wired into the page.
const replayHtml = readFileSync(join(root, "index.html"), "utf8");
has(replayHtml.includes("card-replay"), "time-lapse card present on the dashboard");
has(replayHtml.includes('id="card-wall"') && replayHtml.includes('<span class="num">05</span>'), "inscription wall card is numbered 05 on the dashboard");
has(replayHtml.includes(LEDGER_ADDR), "the page prints the ledger address the wall card reads");
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

// --- 3D viewer specifics: it may only READ view getters, and its data must be the
// corrected connectome (5144 directed edges over 302 neurons).
const viz = readFileSync(join(root, "src", "worm3d.js"), "utf8");
has(viz.includes('"function V(uint256) view returns (int256)"'), "3D reads V() view getter");
has(viz.includes('"function spikeCount(uint256) view returns (uint256)"'), "3D reads spikeCount() view getter");
absent(viz, "advance(", "3D never encodes a state-changing advance()");
absent(viz, "stimulate(", "3D never encodes stimulate()");
absent(viz, "inject(", "3D never encodes inject()");

const graph = JSON.parse(readFileSync(join(root, "public", "data", "graph.json"), "utf8"));
const layout = JSON.parse(readFileSync(join(root, "public", "data", "layout.json"), "utf8"));
has(graph.nNeurons === 302, "graph.json carries 302 neurons");
has(graph.names.indexOf("ADEL") >= 0 && hasDir(graph, "ADEL", "RIH"), "graph.json direction is pre -> post (ADEL -> RIH present)");
has(layout.neurons.length === 302, "layout.json carries 302 neuron placements");

function hasDir(g, a, b) {
  const ia = g.names.indexOf(a), ib = g.names.indexOf(b);
  return g.edges.some(([s, d]) => s === ia && d === ib);
}

console.log(`scanned ${srcFiles.length} src modules (read-only guard on ${guardFiles.length}, dedicated fences on ${WRITE_MODULES.join(" and ")}): ${srcFiles.join(", ")}`);
console.log(fail ? `\n${fail} FAILURE(S)` : "\nFRONTEND READ-ONLY SMOKE PASSED");
process.exitCode = fail ? 1 : 0;
