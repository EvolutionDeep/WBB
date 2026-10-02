/// Deploy the two read/stimulate integration layers -- WormReadout and SenseAdapter
/// -- ON TOP OF the already-live WormBrainV2. This script NEVER touches the animal:
/// it does not seed, does not advance, does not stimulate. It only (1) binds a
/// read-only lens to the live brain and (2) binds the sanctioned stimulation entry
/// point to the frozen PancakeV2 WBNB/USDT pool. The private key is only read from
/// contracts/.env and never printed.
///
/// Usage: node scripts/deploy_readout_adapter.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed1.bnbchain.org";
const EXPECTED_CHAIN_ID = 56n;

// Frozen mainnet endpoints (BSC mainnet only). Local/BSC testnet overrides below.
const MAINNET = {
  pancakeFactory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  USDT: "0x55d398326f99059fF775485246999027B3197955",
};
const SCALES = { scale: 1048576n, gain: 1048576n, ampCap: 2097152n }; // gain identity, cap q(2.0)

function loadArtifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf-8")
  );
}

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const normalized = pk.startsWith("0x") ? pk : "0x" + pk;

  const recPath = path.join(__dirname, "..", "deployed_addresses.json");
  const rec = JSON.parse(fs.readFileSync(recPath, "utf-8"));
  const brainAddr = rec.WormBrain?.address;
  if (!brainAddr) throw new Error("WormBrain (live V2) address not found in deployed_addresses.json");

  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (net.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`refusing to deploy: connected chain is ${net.chainId}, expected BSC mainnet 56`);
  }
  const wallet = new ethers.Wallet(normalized, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log("Deployer:", wallet.address, "| balance:", ethers.formatEther(bal), "BNB");
  console.log("Live brain (untouched):", brainAddr);

  const { pancakeFactory, WBNB, USDT } = MAINNET;

  // ---- sanity: confirm the brain exposes the interface we bind to (read-only calls) ----
  const brainAbi = [
    "function tick() view returns (uint256)",
    "function connRoot() view returns (bytes32)",
    "function gate(uint256) view returns (int256)",
    "function stateHash() view returns (bytes32)",
  ];
  const brain = new ethers.Contract(brainAddr, brainAbi, provider);
  const [tick, connRoot, gateASEL] = await Promise.all([brain.tick(), brain.connRoot(), brain.gate(39)]);
  console.log(`brain sanity: tick=${tick} connRoot=${connRoot} gate(ASEL)=${gateASEL}`);

  // ---- resolve the frozen pair once (the adapter will store it immutably) ----
  const facAbi = ["function getPair(address,address) view returns (address)"];
  const pairAddr = await new ethers.Contract(pancakeFactory, facAbi, provider).getPair(WBNB, USDT);
  if (pairAddr === ethers.ZeroAddress) throw new Error("PancakeV2 WBNB/USDT pair resolved to zero address");
  console.log("Frozen WBNB/USDT pair:", pairAddr);

  // ---- consolidated pre-deploy summary (the fields the review requires on record) ----
  console.log("\n=== deploying integration layers (constructor txs only: NO seed/advance/stimulate) ===");
  console.log("brain   :", brainAddr);
  console.log("connRoot:", connRoot);
  console.log("token0  :", WBNB, "(WBNB)");
  console.log("token1  :", USDT, "(USDT)");
  console.log("pair    :", pairAddr, "(stored immutable by SenseAdapter via one getPair call)");
  console.log();

  // ---- deploy WormReadout ----
  const readoutArt = loadArtifact("WormReadout");
  const readout = await new ethers.ContractFactory(readoutArt.abi, readoutArt.bytecode, wallet)
    .deploy(brainAddr);
  await readout.waitForDeployment();
  const readoutAddr = await readout.getAddress();
  const ro = await readout.read.staticCall();
  console.log("WormReadout:", readoutAddr,
    `| read(): approach=${ro.approach} turn=${ro.turn} speed=${ro.speed} tick=${ro.tick}`);

  // ---- deploy SenseAdapter ----
  const adArt = loadArtifact("SenseAdapter");
  const adapter = await new ethers.ContractFactory(adArt.abi, adArt.bytecode, wallet)
    .deploy(pancakeFactory, WBNB, USDT, brainAddr, SCALES.gain, SCALES.ampCap);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  if ((await adapter.pair()) !== pairAddr) throw new Error("adapter pair mismatch");
  console.log("SenseAdapter:", adapterAddr, "| pair frozen OK");

  // ---- record ----
  rec.WormReadout = { address: readoutAddr, brain: brainAddr };
  rec.SenseAdapter = {
    address: adapterAddr, brain: brainAddr, pair: pairAddr,
    pool: "PancakeV2 WBNB/USDT", gain: SCALES.gain.toString(), ampCap: SCALES.ampCap.toString(),
  };
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
  console.log("\ndeployed_addresses.json updated (WormReadout + SenseAdapter).");
  console.log("The brain was NOT seeded/advanced/stimulated by this script.");
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
