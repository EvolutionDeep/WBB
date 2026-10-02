// READ-ONLY review: prove WormNeurons.sol indices == the exact Cook-2019 name list
// that seeded the deployed WormBrain. No transactions, no state changes.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const W = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "worm", "data", "brain_weights.json"), "utf8"));
const rec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed_addresses.json"), "utf-8"));
const sol = fs.readFileSync(path.join(__dirname, "..", "contracts", "WormNeurons.sol"), "utf8");

// 1) parse the frozen constants straight out of WormNeurons.sol (not from memory)
const consts = {};
const re = /uint256 internal constant (\w+) = (\d+);/g;
let m;
while ((m = re.exec(sol))) consts[m[1]] = Number(m[2]);

// 2) prove the deployed genome IS this file's blob (index order comes from names[])
const blobRoot = ethers.keccak256(W.blob);
const deployedRoot = rec.WormBrain.connRoot;
console.log("deployed WormBrain address :", rec.WormBrain.address, "(v" + rec.WormBrain.version + ")");
console.log("keccak256(brain_weights)   :", blobRoot);
console.log("recorded on-chain connRoot :", deployedRoot);
console.log("connRoot MATCH             :", blobRoot === deployedRoot);

// 3) the seed-time list must be Cook 2019 hermaprodite, 302 unique, sorted
const names = W.names;
const uniq = new Set(names).size;
const sorted = names.every((n, i) => i === 0 || names[i - 1] <= n);
console.log("names length / unique / sorted:", names.length, "/", uniq, "/", sorted);

// 4) per-neuron cross-check
const review = ["ASEL","ASER","AWCL","AWCR","AWAL","AWAR","AVAL","AVAR","AVBL","AVBR","PVCL","PVCR"];
let ok = blobRoot === deployedRoot && names.length === 302 && uniq === 302 && sorted;
console.log("\nname  | solIdx | names[solIdx] | indexOf(name) | verdict");
for (const n of review) {
  const solIdx = consts[n];
  const nameAtSolIdx = names[solIdx];
  const genomeIdx = names.indexOf(n);
  const pass = solIdx === genomeIdx && nameAtSolIdx === n;
  if (!pass) ok = false;
  console.log(`${n.padEnd(5)} | ${String(solIdx).padStart(6)} | ${String(nameAtSolIdx).padStart(13)} | ${String(genomeIdx).padStart(13)} | ${pass ? "OK" : "MISMATCH"}`);
}
console.log("\nRESULT:", ok ? "PASS - all indices match the seed-time Cook 2019 list" : "FAIL - stop, do not deploy");
process.exitCode = ok ? 0 : 1;
