// READ-ONLY bytecode self-verification for the deployed brain.
//
// The Hardhat golden test proves "this Solidity matches this Python spec". It does
// NOT prove "the bytecode stored on-chain is the bytecode of THIS Solidity source".
// This script attacks exactly that gap, without spending gas and without an API key.
//
// Method (solc 0.8.24, optimizer runs=200, viaIR -- the pinned hardhat.config.js):
//   1. metadata proof: solc appends a CBOR "metadata" blob to the runtime code whose
//      body is a hash of the exact source + compiler settings. If the deployed and
//      locally-compiled metadata match byte-for-byte, the SOURCE and SETTINGS match.
//   2. code proof: compare the executable body. A deployed contract legitimately
//      differs from its artifact only where the CONSTRUCTOR INLINES immutables (e.g.
//      `address public immutable deployer = msg.sender`): the artifact stores a
//      zero placeholder there and the chain stores the real value. Every such window
//      is classified as an immutable; any other mismatch is a REAL divergence.
//
// Run after `npx hardhat compile`:   node scripts/verify_bytecode.cjs
// Sends NO transaction. This is a local proof; `npx hardhat verify` on BscScan is
// what makes the same equivalence visible to third parties.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed1.bnbchain.org";
const BRAIN = "0x18174bb0049d43fA75f468a037dfC32899f01dBB";
const ART = path.join(__dirname, "..", "artifacts", "contracts", "WormBrainV2.sol", "WormBrainV2.json");

const strip0x = (h) => (h.toLowerCase().startsWith("0x") ? h.slice(2) : h.toLowerCase());
// body = everything before <cbor><2-byte cbor length>
function splitMeta(hex) {
  const len = parseInt(hex.slice(-4), 16);
  if (!Number.isFinite(len) || len <= 0 || len * 2 + 4 > hex.length) return { body: hex, meta: "" };
  return { body: hex.slice(0, hex.length - (len * 2 + 4)), meta: hex.slice(hex.length - (len * 2 + 4)) };
}

async function main() {
  if (!fs.existsSync(ART)) {
    console.error("artifact missing -- run `npx hardhat compile` first");
    process.exitCode = 1;
    return;
  }
  const compiled = JSON.parse(fs.readFileSync(ART, "utf-8"));
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const deployedHex = strip0x(await provider.getCode(BRAIN));
  const compiledHex = strip0x(compiled.deployedBytecode);

  const d = splitMeta(deployedHex);
  const c = splitMeta(compiledHex);

  console.log("address       :", BRAIN);
  console.log("runtime size  : deployed", d.body.length / 2, "B | compiled", c.body.length / 2, "B");
  const metaEqual = d.meta === c.meta && d.meta.length > 0;
  console.log("metadata match:", metaEqual, "(source+settings fingerprint -- identical => same solc build of the same source)");

  if (c.body !== d.body) {
    // walk byte-by-byte, every mismatch must be a zero-placeholder (immutable slot)
    const imms = [];
    let real = 0;
    let m = Math.max(c.body.length, d.body.length);
    let run = null;
    for (let bi = 0; bi < m / 2; bi++) {
      const cb = c.body.substr(bi * 2, 2) || "";
      const db = d.body.substr(bi * 2, 2) || "";
      if (cb === db) { if (run) { imms.push(run); run = null; } continue; }
      // placeholder side is zeros -> inlined immutable value; that is expected
      if (cb === "00" && db.length === 2) { if (!run) run = [bi, bi]; else run[1] = bi; continue; }
      real++;
    }
    if (run) imms.push(run);
    console.log("immutable slots:", imms.length, imms.map(([s, e]) => `byte ${s}-${e}`).join(", ") || "(none)");
    console.log("real code diffs :", real);
    if (real > 0) {
      console.log("\nRESULT: the deployed executable code is NOT this source (real diffs outside immutables).");
      process.exitCode = 2;
      return;
    }
  }

  const immOK = c.body !== d.body;
  console.log(
    "\nRESULT:",
    metaEqual
      ? (immOK
        ? "metadata identical + code differs only at inlined immutable slots => the on-chain bytes ARE compiled from this exact source (solc 0.8.24, viaIR, runs=200)."
        : "byte-for-byte identical runtime => the on-chain bytes ARE this exact source.")
      : "metadata differs -- cannot claim source identity from this check alone."
  );
  console.log("Publish it: npx hardhat verify --network bscMainnet " + BRAIN);
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
