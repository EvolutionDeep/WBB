/// Deploy a CORRECTED-direction WormBrainV2 to BSC mainnet from a FRESH,
/// DETERMINISTIC genesis (option A): the initial membrane voltages and body
/// pose come straight from worm/data/brain_weights.json `init` (the authoritative
/// brain_spec.py output), NOT read from any live chain contract. This is the
/// scientifically clean restart -- the new animal reproduces the corrected golden
/// trajectory exactly, and does NOT carry over the old (direction-reversed) worm's
/// accumulated tick.
///
/// Contrast with deploy_brain_v2.js, which migrates LIVE state from
/// rec.WormBrain (now the reversed V2) and would overwrite WormBrainV1Legacy.
/// This script never reads live state and only ADDS a legacy record.
///
/// Flow: deploy (empty ctor) -> seed(genesis) -> read-back connRoot/V/pose ->
///       advance(1) gas probe -> update deployed_addresses.json.
/// The private key is only read from contracts/.env and never printed.
///
/// Usage: node scripts/deploy_brain_v2_corrected.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed1.bnbchain.org";
const EXPECTED_CHAIN_ID = 56n; // BSC mainnet only, no testnet fallback
const EXPECTED_CONN_ROOT =
  "0x38dc5c120b55d24182cb3f81738c271c7255de5ffa1507f8aa4cb950494d8cac";
const N = 302;

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const normalized = pk.startsWith("0x") ? pk : "0x" + pk;

  const W = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "worm", "data", "brain_weights.json"), "utf-8")
  );
  if (!W.blob.startsWith("0x")) throw new Error("brain_weights.json blob must be 0x-prefixed hex");
  const blobBytes = (W.blob.length - 2) / 2;
  if (W.nNeurons !== N || W.nEdges * 8 !== blobBytes) {
    throw new Error("brain_weights.json looks inconsistent");
  }
  if (!W.init || !Array.isArray(W.init.V) || W.init.V.length !== N) {
    throw new Error("brain_weights.json is missing a 302-length init.V");
  }
  const localRoot = ethers.keccak256(W.blob);
  if (localRoot !== EXPECTED_CONN_ROOT) {
    throw new Error(`local blob connRoot ${localRoot} != expected corrected root ${EXPECTED_CONN_ROOT}`);
  }

  const art = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "artifacts", "contracts", "WormBrainV2.sol", "WormBrainV2.json"),
      "utf-8"
    )
  );

  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (net.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`refusing to deploy: connected chain is ${net.chainId}, expected BSC mainnet 56`);
  }
  const wallet = new ethers.Wallet(normalized, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log("Deployer:", wallet.address, "| balance:", ethers.formatEther(bal), "BNB");
  console.log("Genesis source: FRESH deterministic init.V (NOT any live chain state)");

  // ---- fresh deterministic genesis, read purely from the spec data ----
  const g = W.groups;
  const initV = W.init.V.map((x) => BigInt(x));
  const genesis = {
    blob: W.blob, v: initV,
    attr: g.SENSORS_ATTR, oli: g.SENSORS_OLI, avert: g.SENSORS_AVERT,
    fwd: g.MOTOR_FWD, ava: g.INTER_AVA, avb: g.INTER_AVB, turn: g.TURN_IN,
    awcl: g.AWCL, awcr: g.AWCR, awal: g.AWAL, awar: g.AWAR,
    px: W.init.px, py: W.init.py, hx: W.init.hx, hy: W.init.hy,
  };

  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const est = await factory.getDeployTransaction();
  let gasLimit;
  try {
    gasLimit = await provider.estimateGas({ data: est.data, from: wallet.address });
    gasLimit = (gasLimit * 13n) / 10n;
  } catch (e) {
    gasLimit = 6_000_000n;
    console.log("estimateGas unavailable (", e.shortMessage || e.message, "), using", gasLimit.toString());
  }
  const gasPrice = (await provider.getFeeData()).gasPrice;
  const maxCost = gasLimit * gasPrice;
  console.log("deploy gasLimit:", gasLimit.toString(), "| worst-case cost:", ethers.formatEther(maxCost), "BNB");
  if (maxCost >= bal) throw new Error("insufficient balance for worst-case deployment cost");

  console.log("Deploying WormBrainV2 (empty constructor) ...");
  const contract = await factory.deploy({ gasLimit });
  const rc = await contract.deploymentTransaction().wait();
  const addr = await contract.getAddress();
  console.log("\nWormBrainV2 deployed:", addr);
  console.log("tx:", rc.hash, "status:", rc.status, "gasUsed:", rc.gasUsed.toString());

  console.log("Seeding fresh deterministic genesis (one-shot tx) ...");
  const seedTx = await contract.seed(genesis);
  const seedRc = await seedTx.wait();
  console.log("seed tx:", seedRc.hash, "status:", seedRc.status, "gasUsed:", seedRc.gasUsed.toString());
  if (seedRc.status !== 1) throw new Error("seed tx reverted");

  // ---- read-back sanity: connRoot + spot init V + pose, BEFORE any advance ----
  const connRoot = await contract.connRoot();
  if (connRoot !== EXPECTED_CONN_ROOT) throw new Error(`connRoot mismatch: ${connRoot}`);
  const [cpx, chy, ctick] = await Promise.all([contract.px(), contract.hy(), contract.tick()]);
  if (cpx !== BigInt(W.init.px) || chy !== BigInt(W.init.hy)) throw new Error("pose genesis mismatch");
  for (const i of [0, 54, 150, 301]) {
    const vOnChain = await contract.V(i);
    if (vOnChain !== initV[i]) throw new Error(`V[${i}] genesis mismatch: chain=${vOnChain} local=${initV[i]}`);
  }
  console.log(`read-back OK: connRoot=${connRoot} tick=${ctick} px=${cpx} hy=${chy} (spot V match)`);

  // ---- one live advance step on mainnet to prove gas headroom before the daemon moves in ----
  console.log("probe: advance(1) on mainnet ...");
  const advTx = await contract.advance(1, W.blob, { gasLimit: 14_000_000 });
  const advRc = await advTx.wait();
  console.log("advance tx:", advRc.hash, "gasUsed:", advRc.gasUsed.toString(), "status:", advRc.status);
  if (advRc.status !== 1) throw new Error("probe advance reverted");

  // ---- record: demote the reversed V2 to a legacy entry, never delete history ----
  const recPath = path.join(__dirname, "..", "deployed_addresses.json");
  const rec = JSON.parse(fs.readFileSync(recPath, "utf-8"));
  const prevBrain = rec.WormBrain;
  if (prevBrain && prevBrain.address && prevBrain.address.toLowerCase() !== addr.toLowerCase()) {
    rec.WormBrainV2ReversedLegacy = {
      address: prevBrain.address,
      connRoot: prevBrain.connRoot,
      note: "V2 seeded from the pre-fix (direction-reversed) genome; superseded by the corrected genesis below. Left running/immutable, not touched.",
    };
  }
  rec.WormBrain = {
    address: addr,
    version: 2,
    corrected: true,
    genesis: "fresh deterministic (brain_spec init.V), not migrated from live state",
    txHash: rc.hash,
    blockNumber: rc.blockNumber,
    gasUsed: Number(rc.gasUsed),
    seedTxHash: seedRc.hash,
    seedGasUsed: Number(seedRc.gasUsed),
    probeAdvanceGasUsed: Number(advRc.gasUsed),
    connRoot,
  };
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
  console.log("\ndeployed_addresses.json updated: WormBrain -> new corrected V2 (", addr, ")");
  console.log("NOTE: WormReadout + SenseAdapter still bind the OLD brain; redeploy them next.");
  console.log("Next steps:");
  console.log("  node scripts/deploy_readout_adapter.js   # rebind readout+adapter to the new brain");
  console.log("  npx hardhat verify --network bscMainnet " + addr);
  console.log("  python ..\\worm\\node\\brain_daemon.py --continuous --interval 300");
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
