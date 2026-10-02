const hre = require("hardhat");
require("dotenv").config();

/// Read-only preflight: derive the deployer address from the .env key and check
/// the mainnet balance. Never prints the private key.
async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const normalized = pk.startsWith("0x") ? pk : "0x" + pk;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("bad private key format (expected 64 hex chars, optional 0x prefix)");
  }

  const wallet = new hre.ethers.Wallet(normalized);
  console.log("Deployer address:", wallet.address);

  const provider = new hre.ethers.JsonRpcProvider(
    process.env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com"
  );
  const net = await provider.getNetwork();
  console.log("chainId:", net.chainId.toString(), net.chainId === 56n ? "(BSC mainnet OK)" : "(NOT mainnet)");

  const bal = await provider.getBalance(wallet.address);
  console.log("Mainnet balance:", hre.ethers.formatEther(bal), "BNB");

  const fee = await provider.getFeeData();
  console.log("gasPrice:", hre.ethers.formatUnits(fee.gasPrice, "gwei"), "gwei");

  if (net.chainId !== 56n) throw new Error("Aborted: target is not BSC mainnet");
  if (bal === 0n) throw new Error("Aborted: deployer balance is 0");
  console.log("\nPreflight passed, ready to deploy.");
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
