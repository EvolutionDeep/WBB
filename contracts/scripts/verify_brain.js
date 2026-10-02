/// Verify the deployed WormBrain source on BscScan via hardhat-verify.
/// The constructor is now empty (genome loads through the one-shot seed() tx because
/// BSC mainnet EIP-3860 caps initcode at 49152 bytes), so verification is a plain
/// no-constructor-args call.
///
/// Usage (from contracts/): npx hardhat run scripts/verify_brain.js --network bscMainnet
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const rec = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed_addresses.json"), "utf-8")
  );
  if (!rec.WormBrain || !rec.WormBrain.address) throw new Error("WormBrain not deployed yet");
  const addr = rec.WormBrain.address;

  console.log("Verifying", addr, "on BscScan ...");
  await hre.run("verify:verify", {
    address: addr,
    contract: "contracts/WormBrain.sol:WormBrain",
    constructorArguments: [],
  });
  console.log("WormBrain source verified.");
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
