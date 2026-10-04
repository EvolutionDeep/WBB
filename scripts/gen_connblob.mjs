// Reproducible asset: ship the exact connectome blob the brain was seeded with, so the
// frontend can offer a permissionless advance(1, connBlob). The blob is the same bytes for
// every step and the contract proves keccak256(connBlob)==connRoot on every call -- so this
// generator hard-asserts that identity before writing anything. If it ever drifts, it fails
// loudly instead of producing a blob the chain would reject with "bad connome".
//
// Run from anywhere: node scripts/gen_connblob.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// ethers lives in the frontend workspace; resolve it against that package so this
// repo-root tool needs no dependency of its own
const require = createRequire(join(ROOT, "frontend", "package.json"));
const { keccak256 } = require("ethers");
const WEIGHTS = join(ROOT, "worm", "data", "brain_weights.json");
const OUT = join(ROOT, "frontend", "public", "data", "connblob.txt");

// the canonical corrected-direction genome anchor, proven on-chain at 0x49E89C...C6A3
const CONN_ROOT = "0x38dc5c120b55d24182cb3f81738c271c7255de5ffa1507f8aa4cb950494d8cac";

const W = JSON.parse(readFileSync(WEIGHTS, "utf-8"));
if (typeof W.blob !== "string" || !W.blob.startsWith("0x")) throw new Error("brain_weights.json blob missing or not 0x-hex");
const blobBytes = (W.blob.length - 2) / 2;
if (W.nEdges * 8 !== blobBytes) throw new Error(`blob length ${blobBytes} != nEdges*8 ${W.nEdges * 8}`);

const root = keccak256(W.blob);
if (root !== CONN_ROOT) throw new Error(`keccak256(blob) ${root} != expected connRoot ${CONN_ROOT} -- refusing to write`);

writeFileSync(OUT, W.blob.trim() + "\n");
console.log("wrote", OUT, "bytes:", blobBytes, "edges:", W.nEdges, "connRoot verified:", root);
