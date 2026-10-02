const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/// Read-only: connect to a BSC mainnet public RPC and estimate the real BNB cost
/// of the two deployments. Sends no transaction, needs no private key, spends nothing.
async function main() {
  const ENDPOINTS = [
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed1.bnbchain.org",
    "https://bsc-dataseed.binance.org",
    "https://rpc.ankr.com/bsc",
    process.env.BSC_RPC_URL,
  ].filter(Boolean);

  let provider = null, net = null;
  for (const url of ENDPOINTS) {
    try {
      const p = new hre.ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      net = await Promise.race([
        p.getNetwork(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 9000)),
      ]);
      provider = p;
      console.log("Connected to RPC:", url);
      break;
    } catch (e) {
      console.log("Skipping endpoint:", url, "->", e.shortMessage || e.message);
    }
  }
  if (!provider) throw new Error("no public RPC reachable, retry later or configure your own node");
  console.log("chainId:", net.chainId.toString());
  if (net.chainId !== 56n) throw new Error("not BSC mainnet");

  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? fee.maxFeePerGas;
  console.log("current gasPrice:", hre.ethers.formatUnits(gasPrice, "gwei"), "gwei");

  const args = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "genome_args.json"), "utf-8")
  );

  const Genome = await hre.ethers.getContractFactory("WormGenome");
  const HB = await hre.ethers.getContractFactory("WormHeartbeat");

  const g1 = await provider.estimateGas({ data: Genome.getDeployTransaction(
    args.connectomeRoot, args.nNeurons, args.nEdges, args.sourceHash
  ).data });
  const g2 = await provider.estimateGas({ data: HB.getDeployTransaction(
    "0x0000000000000000000000000000000000000000"
  ).data });

  const total = (g1 + g2) * gasPrice;
  console.log("\nWormGenome    deploy gas:", g1.toString());
  console.log("WormHeartbeat deploy gas:", g2.toString());
  console.log("Total approx:", hre.ethers.formatEther(total), "BNB");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
