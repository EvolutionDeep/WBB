require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/// The deployer key is only read from env vars, never hard-coded or committed.
/// Public BSC mainnet RPC (override with your own node via BSC_RPC_URL in .env)
const BSC_RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    // In-memory local chain: seed() writes the 302 initial voltages and advance() txs carry
    // the ~41KB connectome blob, so single txs need very high gas -- lift the cap.
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    bscMainnet: {
      url: BSC_RPC_URL,
      chainId: 56,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      gasPrice: 3_000_000_000, // 3 gwei, in line with current BSC rates
    },
  },
  etherscan: {
    apiKey: {
      bsc: process.env.BSCSCAN_API_KEY || "",
    },
  },
};
