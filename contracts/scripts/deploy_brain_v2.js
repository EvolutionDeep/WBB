/// Deploy WormBrainV2 (the learning brain) to BSC mainnet and migrate the LIVE
/// v1 animal into its genesis: V/px/py/hx/hy are read from the running v1
/// contract, so the same worm continues its life with a brand-new memory system.
/// tick/gate/stim/spikeCount restart (v1 had no memories to carry over).
/// Native ethers v6 provider+wallet (immune to the public-RPC to:"" bug).
/// The private key is only read from contracts/.env and never printed.
///
/// Usage: node scripts/deploy_brain_v2.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed1.bnbchain.org";
const EXPECTED_CHAIN_ID = 56n;
const N = 302;

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const normalized = pk.startsWith("0x") ? pk : "0x" + pk;

  const W = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "worm", "data", "brain_weights.json"), "utf-8")
  );
  const recPath = path.join(__dirname, "..", "deployed_addresses.json");
  const rec = JSON.parse(fs.readFileSync(recPath, "utf-8"));
  const v1Addr = rec.WormBrain?.address;
  if (!v1Addr) throw new Error("WormBrain (v1) not in deployed_addresses.json");

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

  // ---- read the live v1 state (the animal to migrate) ----
  const v1Abi = [
    "function V(uint256) view returns (int256)",
    "function px() view returns (int256)",
    "function py() view returns (int256)",
    "function hx() view returns (int256)",
    "function hy() view returns (int256)",
    "function tick() view returns (uint256)",
    "function stateHash() view returns (bytes32)",
  ];
  const v1 = new ethers.Contract(v1Addr, v1Abi, provider);
  console.log("reading live v1 state from", v1Addr, "...");
  // public dataseeds rate-limit concurrent eth_call: read V in small chunks with retries
  const liveV = new Array(N);
  const CHUNK = 12;
  for (let off = 0; off < N; off += CHUNK) {
    const idxs = [];
    for (let i = off; i < Math.min(off + CHUNK, N); i++) idxs.push(i);
    for (let attempt = 0; ; attempt++) {
      try {
        const vals = await Promise.all(idxs.map((i) => v1.V(i)));
        idxs.forEach((i, k) => { liveV[i] = vals[k]; });
        break;
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  let px, py, hx, hy, v1tick;
  for (let attempt = 0; ; attempt++) {
    try {
      [px, py, hx, hy, v1tick] = await Promise.all([v1.px(), v1.py(), v1.hx(), v1.hy(), v1.tick()]);
      break;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  if (liveV.some((v) => v === undefined)) throw new Error("V migration read incomplete");
  console.log(`v1 tick=${v1tick} px=${px} py=${py} hx=${hx} hy=${hy}`);

  const g = W.groups;
  const genesis = {
    blob: W.blob, v: liveV,
    attr: g.SENSORS_ATTR, oli: g.SENSORS_OLI, avert: g.SENSORS_AVERT,
    fwd: g.MOTOR_FWD, ava: g.INTER_AVA, avb: g.INTER_AVB, turn: g.TURN_IN,
    awcl: g.AWCL, awcr: g.AWCR, awal: g.AWAL, awar: g.AWAR,
    px, py, hx, hy,
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

  console.log("Seeding genome (live v1 state as genesis, one-shot tx) ...");
  const seedTx = await contract.seed(genesis);
  const seedRc = await seedTx.wait();
  console.log("seed tx:", seedRc.hash, "status:", seedRc.status, "gasUsed:", seedRc.gasUsed.toString());
  if (seedRc.status !== 1) throw new Error("seed tx reverted");

  // ---- read-back sanity ----
  const connRoot = await contract.connRoot();
  const expectedRoot = ethers.keccak256(W.blob);
  if (connRoot !== expectedRoot) throw new Error("connRoot mismatch, something is very wrong");
  for (const i of [0, 54, 150, 301]) {
    if ((await contract.V(i)) !== liveV[i]) throw new Error(`V[${i}] migration mismatch`);
  }
  if ((await contract.px()) !== px || (await contract.hy()) !== hy) throw new Error("position migration mismatch");
  console.log("migration read-back OK (connRoot + spot V/pos)");

  // one live advance step on mainnet to prove gas headroom before the daemon moves in
  console.log("probe: advance(1) on mainnet ...");
  const advTx = await contract.advance(1, W.blob, { gasLimit: 14_000_000 });
  const advRc = await advTx.wait();
  console.log("advance tx:", advRc.hash, "gasUsed:", advRc.gasUsed.toString(), "status:", advRc.status);
  if (advRc.status !== 1) throw new Error("probe advance reverted");

  rec.WormBrainV1Legacy = { address: v1Addr, note: "v1 brain, retired after live-state migration to V2", migratedAtTick: Number(v1tick) };
  rec.WormBrain = {
    address: addr,
    version: 2,
    txHash: rc.hash,
    blockNumber: rc.blockNumber,
    gasUsed: Number(rc.gasUsed),
    seedTxHash: seedRc.hash,
    seedGasUsed: Number(seedRc.gasUsed),
    probeAdvanceGasUsed: Number(advRc.gasUsed),
    connRoot,
  };
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
  console.log("deployed_addresses.json updated (WormBrain now points at V2; v1 kept as WormBrainV1Legacy)");

  console.log("\nNext steps:");
  console.log("  restart brain_daemon.py             # it reads WormBrain from deployed_addresses.json");
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
