/// Deploy WormHeartbeat (standalone alternative to deploy.js, reusing the
/// already-on-chain WormGenome).
/// Uses the native ethers v6 provider+wallet to work around hardhat-ethers'
/// parsing bug on to:"" returned by some public RPCs.
/// The private key is only read from env vars and never printed.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = "https://bsc-dataseed1.bnbchain.org";
const GENOME = "0xb11a96464ea974cb34ddfbec862249d8f8bb007f";

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const normalized = pk.startsWith("0x") ? pk : "0x" + pk;

  const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
  const wallet = new ethers.Wallet(normalized, provider);
  console.log("Deployer account:", wallet.address);
  const net = await provider.getNetwork();
  if (net.chainId !== 56n) throw new Error("not mainnet");

  const art = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "artifacts", "contracts", "WormHeartbeat.sol", "WormHeartbeat.json"),
      "utf-8"
    )
  );

  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);

  // Confirm the Genome contract is really on-chain
  const code = await provider.getCode(GENOME);
  if (code === "0x") throw new Error("no code at Genome address, aborting");
  console.log("WormGenome confirmed at:", GENOME);

  console.log("Deploying WormHeartbeat ...");
  const contract = await factory.deploy(GENOME);
  // Native ethers waitForDeployment goes through eth_getTransactionReceipt, never parsing `to`
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  const rc = await contract.deploymentTransaction().wait();

  console.log("\nWormHeartbeat deployed:", addr);
  console.log("tx:", rc.hash, "status:", rc.status, "gasUsed:", rc.gasUsed.toString());

  // Update the record file
  const recPath = path.join(__dirname, "..", "deployed_addresses.json");
  const rec = JSON.parse(fs.readFileSync(recPath, "utf-8"));
  rec.WormHeartbeat = {
    address: addr,
    txHash: rc.hash,
    blockNumber: rc.blockNumber,
    gasUsed: Number(rc.gasUsed),
  };
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2));
  console.log("\ndeployed_addresses.json updated");
  console.log("For the off-chain node:");
  console.log(`GENOME_ADDRESS=${GENOME}`);
  console.log(`HEARTBEAT_ADDRESS=${addr}`);
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
