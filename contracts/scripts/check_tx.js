/// Read-only recovery: query a deployment tx status via raw JSON-RPC, bypassing
/// ethers' parsing bug on to:"".
const hre = require("hardhat");

const TX = "0x013f60bfb2efdb12b8bb399f9d09ef34885facb07b9fdeb03133c1b975fb69b0";

async function main() {
  const ENDPOINTS = [
    "https://bsc-dataseed1.bnbchain.org",
    "https://bsc-dataseed.binance.org",
    "https://bsc.nodereal.io",
    "https://1rpc.io/bnb",
    "https://bsc-rpc.publicnode.com",
    process.env.BSC_RPC_URL,
  ].filter(Boolean);

  let receipt = null, txObj = null, used = null;
  for (const url of ENDPOINTS) {
    try {
      const provider = new hre.ethers.JsonRpcProvider(url, 56, { staticNetwork: true });
      receipt = await Promise.race([
        provider.send("eth_getTransactionReceipt", [TX]),
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 9000)),
      ]);
      txObj = await provider.send("eth_getTransactionByHash", [TX]);
      used = url;
      if (receipt || txObj) break;
    } catch (e) {
      console.log("skipping", url, "->", e.shortMessage || e.message);
    }
  }

  console.log("RPC:", used);
  console.log("tx exists:", !!txObj, txObj ? "(blockNumber=" + txObj.blockNumber + ")" : "");
  if (receipt) {
    console.log("status:", receipt.status);
    console.log("contractAddress:", receipt.contractAddress);
    console.log("gasUsed:", receipt.gasUsed);
    console.log("blockNumber:", receipt.blockNumber);
  } else {
    console.log("no receipt yet (pending or never landed)");
  }
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
