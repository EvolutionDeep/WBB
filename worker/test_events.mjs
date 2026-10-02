// Offline unit test for the event-log decoder (worker/src/index.js :: decodeLogs).
// Reproduces the reported bug: an Advanced log whose "fired" word contains an
// a-f nibble (e.g. 26 = 0x1a) used to crash the RPC-fallback path with a 502
// because the 0x prefix was stripped before BigInt(). No network, no RPC.
// Run: node worker/test_events.mjs
import { decodeLogs } from "./src/index.js";

const ADV = "0xb7496a18e89474c0d4762a4afb060c98a0dc0928ba8e47dad1cba99b601209b9";
const STIM = "0x779d0d855bbe3d2772c871993b5828da906f38a7309ad2a7e596ac6730740bd6";
const word = (n) => n.toString(16).padStart(64, "0"); // 32-byte big-endian, NO 0x

let failures = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"}  ${name}: got ${got}, want ${want}`);
};

// 1) Advanced: tick=7, fired=26 (contains 'a'), totalSpikes=355 (contains 'f'/'5'..)
const advanced = {
  blockNumber: "0x64",
  transactionHash: "0xdeadbeef",
  topics: [ADV, word(7)],
  data: "0x" + word(26) + word(355),
};
const a = decodeLogs([advanced])[0];
check("advanced.kind", a.kind, "Advanced");
check("advanced.block", a.block, 100);
check("advanced.tick", a.tick, 7);
check("advanced.fired", a.fired, 26);           // the exact value that used to 502
check("advanced.totalSpikes", a.totalSpikes, 355);

// 2) Stimulated: idx=39 (ASEL), amp=781
const stimulated = {
  blockNumber: "0x2a",
  transactionHash: "0xcafe",
  topics: [STIM, word(39)],
  data: "0x" + word(781),
};
const s = decodeLogs([stimulated])[0];
check("stim.kind", s.kind, "Stimulated");
check("stim.idx", s.idx, 39);
check("stim.amp", s.amp, 781);

// 3) negative amplitude decodes as signed int256 (two's complement)
const neg = {
  blockNumber: "0x1",
  transactionHash: "0x00",
  topics: [STIM, word(40)],
  data: "0x" + ((1n << 256n) - 100n).toString(16).padStart(64, "0"), // -100
};
check("stim.negative", decodeLogs([neg])[0].amp, -100);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL EVENT DECODE CHECKS PASSED");
process.exitCode = failures ? 1 : 0;
