/// Read-only chronicle probe: fetch the WormHeartbeat heartbeat history item by item from mainnet.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = "https://bsc-dataseed1.bnbchain.org";
const rec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed_addresses.json"), "utf-8"));
const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "WormHeartbeat.sol", "WormHeartbeat.json"), "utf-8")).abi;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
  const hb = new ethers.Contract(rec.WormHeartbeat.address, abi, provider);

  const len = await hb.historyLength();
  const latest = await hb.latestTick();
  const root = await hb.latestStateRoot();
  const alive = await hb.isAlive(120);
  console.log("WormHeartbeat:", rec.WormHeartbeat.address);
  console.log("beats total:", len.toString(), "| latestTick:", latest.toString());
  console.log("latestStateRoot:", root);
  console.log("still beating within last 120s (isAlive):", alive);

  console.log("\n--- chronicle (on-chain timeline of life) ---");
  const n = Number(len);
  for (let i = 0; i < n; i++) {
    const [tick, stateRoot, ts, node] = await hb.history(i);
    console.log(
      `#${i + 1}  tick=${String(tick).padStart(5)}  ${new Date(Number(ts) * 1000).toISOString().slice(11, 19)}Z  ` +
      `${stateRoot.slice(0, 14)}...  node=${node.slice(0, 8)}...`
    );
  }
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
