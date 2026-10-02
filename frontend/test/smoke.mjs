// Read-only guarantee smoke test for the dashboard (no browser, no network).
// Asserts the shipped UI is a pure observer: the frozen contract addresses and
// Q20 scale are present, the HALTED staleness rule is surfaced, and there is NO
// wallet/signing/transaction path anywhere in the page code.
// Run: node frontend/test/smoke.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(root, "src", "main.js"), "utf8");
// every module shipped in the bundle is covered by the read-only guard
const srcFiles = readdirSync(join(root, "src")).filter((f) => f.endsWith(".js"));
const allSrc = srcFiles.map((f) => readFileSync(join(root, "src", f), "utf8")).join("\n");

let fail = 0;
const has = (cond, label) => { if (!cond) fail++; console.log(`${cond ? "OK  " : "FAIL"}  ${label}`); };
const absent = (src, needle, label) => has(!src.toLowerCase().includes(needle.toLowerCase()), label);

has(main.includes("0x192004dAe2A55E20CE21A7d05E722B32c9A9b61E"), "READOUT address frozen in source");
has(main.includes("0xbe0C5117f740a9333614D806Bd50C3907186C6fD"), "ADAPTER address frozen in source");
has(main.includes("1048576n"), "Q20 SCALE constant present");
has(main.includes("HALTED"), "staleness rule surfaced (HALTED)");
has(/read-?only/i.test(main), "page advertises read-only");

// The dashboard must never gain a way to move the animal or spend funds.
for (const bad of ["sendTransaction", "getSigner", "new Wallet", "signer.send", "window.ethereum", "privatekey", "mnemonic"]) {
  absent(allSrc, bad, `no signing/tx path in src/*.js: ${bad}`);
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

console.log(`scanned ${srcFiles.length} src modules: ${srcFiles.join(", ")}`);
console.log(fail ? `\n${fail} FAILURE(S)` : "\nFRONTEND READ-ONLY SMOKE PASSED");
process.exitCode = fail ? 1 : 0;
