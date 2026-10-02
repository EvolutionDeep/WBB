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

has(main.includes("0xe47f67b2e38AFA8a02e27A1D6F3694f33034aB18"), "READOUT address frozen in source");
has(main.includes("0xb7b4C58E58f8496EA7f861c977c4c19698317b87"), "ADAPTER address frozen in source");
has(main.includes("1048576n"), "Q20 SCALE constant present");
has(main.includes("HALTED"), "staleness rule surfaced (HALTED)");
has(/read-?only/i.test(main), "page advertises read-only");

// The dashboard must never gain a way to move the animal or spend funds.
for (const bad of ["sendTransaction", "getSigner", "new Wallet", "signer.send", "window.ethereum", "privatekey", "mnemonic"]) {
  absent(main, bad, `no signing/tx path: ${bad}`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nFRONTEND READ-ONLY SMOKE PASSED");
process.exitCode = fail ? 1 : 0;
