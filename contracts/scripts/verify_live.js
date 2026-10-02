/// Read-only live verification: read back mainnet contract state and compare
/// against the local genome_args.json.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = "https://bsc-dataseed1.bnbchain.org";
const rec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed_addresses.json"), "utf-8"));
const args = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "genome_args.json"), "utf-8"));

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });

  const gCode = await provider.getCode(rec.WormGenome.address);
  const hCode = await provider.getCode(rec.WormHeartbeat.address);
  console.log("WormGenome    has code:", gCode !== "0x");
  console.log("WormHeartbeat has code:", hCode !== "0x");

  const gAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "WormGenome.sol", "WormGenome.json"), "utf-8")).abi;
  const genome = new ethers.Contract(rec.WormGenome.address, gAbi, provider);

  const root = await genome.connectomeRoot();
  const nN = await genome.nNeurons();
  const nE = await genome.nEdges();
  const src = await genome.sourceHash();
  const author = await genome.genesisAuthor();

  console.log("\n--- on-chain vs local ---");
  console.log("connectomeRoot:", root, root.toLowerCase() === args.connectomeRoot.toLowerCase() ? "[OK] match" : "[MISMATCH]");
  console.log("nNeurons:", nN.toString(), Number(nN) === args.nNeurons ? "[OK]" : "[FAIL]");
  console.log("nEdges:", nE.toString(), Number(nE) === args.nEdges ? "[OK]" : "[FAIL]");
  console.log("sourceHash:", src, src.toLowerCase() === args.sourceHash.toLowerCase() ? "[OK] match" : "[MISMATCH]");
  console.log("genesisAuthor:", author);

  const hAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "WormHeartbeat.sol", "WormHeartbeat.json"), "utf-8")).abi;
  const hb = new ethers.Contract(rec.WormHeartbeat.address, hAbi, provider);
  const hbGenome = await hb.genome();
  const latestTick = await hb.latestTick();
  const histLen = await hb.historyLength();
  console.log("\n--- WormHeartbeat ---");
  console.log("points to Genome:", hbGenome, hbGenome.toLowerCase() === rec.WormGenome.address.toLowerCase() ? "[OK]" : "[FAIL]");
  console.log("latestTick:", latestTick.toString(), "| historyLength:", histLen.toString());
  console.log("\nVerification " + (root.toLowerCase() === args.connectomeRoot.toLowerCase() && hbGenome.toLowerCase() === rec.WormGenome.address.toLowerCase() ? "PASSED -- soul layer is alive on mainnet" : "FAILED -- mismatch found"));
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
