const hre = require("hardhat");

/// Pre-deploy checks: confirm the target network is BSC mainnet (56) and the
/// account holds enough BNB.
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();

  console.log("Deployer account:", deployer.address);
  console.log("chainId:", net.chainId.toString());
  if (net.chainId !== 56n) {
    throw new Error(`Aborted: target is not BSC mainnet (expected 56, got ${net.chainId})`);
  }

  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(bal), "BNB");
  if (bal < hre.ethers.parseEther("0.005")) {
    throw new Error("Balance too low to complete both contract deployments; top up BNB first");
  }

  // connectomeRoot / sourceHash are computed from the real npz by scripts/compute_genome.py
  const genomeArgs = require("../genome_args.json");

  const Genome = await hre.ethers.getContractFactory("WormGenome");
  const genome = await Genome.deploy(
    genomeArgs.connectomeRoot,
    genomeArgs.nNeurons,
    genomeArgs.nEdges,
    genomeArgs.sourceHash
  );
  await genome.waitForDeployment();
  const genomeAddr = await genome.getAddress();
  console.log("WormGenome deployed:", genomeAddr);

  const HB = await hre.ethers.getContractFactory("WormHeartbeat");
  const hb = await HB.deploy(genomeAddr);
  await hb.waitForDeployment();
  const hbAddr = await hb.getAddress();
  console.log("WormHeartbeat deployed:", hbAddr);

  console.log("\nWrite the following into .env for the off-chain node:");
  console.log(`GENOME_ADDRESS=${genomeAddr}`);
  console.log(`HEARTBEAT_ADDRESS=${hbAddr}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
