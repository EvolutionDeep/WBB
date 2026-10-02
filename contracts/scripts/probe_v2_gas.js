/// Measure the real mainnet gas cost of WormBrainV2.advance(1, blob) via
/// eth_call + estimateGas (no tx is sent). Prints the numbers only.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed1.bnbchain.org";
const V2 = "0x18174bb0049d43fA75f468a037dfC32899f01dBB";

async function main() {
  const W = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "worm", "data", "brain_weights.json"), "utf-8")
  );
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const abi = [
    "function advance(uint256 n, bytes calldata connBlob)",
    "function tick() view returns (uint256)",
    "function stateHash() view returns (bytes32)",
    "function connRoot() view returns (bytes32)",
  ];
  const c = new ethers.Contract(V2, abi, provider);
  console.log("tick:", (await c.tick()).toString());
  console.log("connRoot match:", (await c.connRoot()) === ethers.keccak256(W.blob));

  // eth_call: does the step logic itself succeed?
  try {
    await c.advance.staticCall(1, W.blob, { gasLimit: 30_000_000 });
    console.log("staticCall advance(1): OK");
  } catch (e) {
    console.log("staticCall advance(1) FAILED:", e.shortMessage || e.message);
  }

  // estimateGas with the deployer as sender (storage writer identity does not
  // change costs, but keep it identical to the daemon's tx)
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : "0x" + pk, provider);
  try {
    const est = await c.advance.estimateGas(1, W.blob, { from: wallet.address });
    console.log("estimateGas advance(1):", est.toString());
  } catch (e) {
    console.log("estimateGas FAILED:", e.shortMessage || e.message);
  }
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
