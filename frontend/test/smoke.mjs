// Read-only guarantee smoke test for the dashboard (no browser, no network).
// Asserts the shipped UI is a pure observer: the frozen contract addresses and
// Q20 scale are present, the HALTED staleness rule is surfaced, and there is NO
// wallet/signing/transaction path anywhere in the page code.
// Run: node frontend/test/smoke.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(root, "src", "main.js"), "utf8");

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
  absent(main, bad, `no signing/tx path: ${bad}`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nFRONTEND READ-ONLY SMOKE PASSED");
process.exitCode = fail ? 1 : 0;
