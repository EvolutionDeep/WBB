/// Submit the first heartbeat to BSC mainnet: sign beatDigest and call
/// WormHeartbeat.beat(). beat() targets an existing contract (a real `to`
/// address), so it is unaffected by the to:"" parsing bug.
/// The private key is only read from env vars and never printed.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = "https://bsc-dataseed1.bnbchain.org";
const rec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed_addresses.json"), "utf-8"));
const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "worm", "node", "beat_payload.json"), "utf-8"));

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const normalized = pk.startsWith("0x") ? pk : "0x" + pk;

  const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
  const wallet = new ethers.Wallet(normalized, provider);
  const net = await provider.getNetwork();
  if (net.chainId !== 56n) throw new Error("not mainnet");

  const hbAddr = rec.WormHeartbeat.address;
  if (!hbAddr) throw new Error("WormHeartbeat not deployed yet");
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "WormHeartbeat.sol", "WormHeartbeat.json"), "utf-8")).abi;
  const hb = new ethers.Contract(hbAddr, abi, wallet);

  const tick = payload.tick;
  const stateRoot = payload.stateRoot;

  // The node must be approved (the deployer was set as the first node in the constructor)
  const approved = await hb.approvedNodes(wallet.address);
  console.log("Node approval:", approved, wallet.address);
  if (!approved) throw new Error("this address is not an approved node");

  const before = { tick: await hb.latestTick(), len: await hb.historyLength() };
  console.log("latestTick before:", before.tick.toString(), "history:", before.len.toString());

  const digest = await hb.beatDigest(tick, stateRoot);
  const sig = new ethers.SigningKey(normalized).sign(digest);

  console.log("Submitting beat(tick=" + tick + ", stateRoot=" + stateRoot.slice(0, 10) + "...) ...");
  const tx = await hb.beat(tick, stateRoot, sig.v, sig.r, sig.s);
  const rc = await tx.wait();

  const after = { tick: await hb.latestTick(), len: await hb.historyLength(), root: await hb.latestStateRoot() };
  console.log("\n[OK] First heartbeat is on mainnet");
  console.log("tx:", rc.hash, "status:", rc.status, "gasUsed:", rc.gasUsed.toString());
  console.log("latestTick after:", after.tick.toString(), "history:", after.len.toString());
  console.log("On-chain latestStateRoot:", after.root, after.root === stateRoot ? "[OK] matches off-chain" : "[MISMATCH]");
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
