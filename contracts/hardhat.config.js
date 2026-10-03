require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/// The deployer key is only read from env vars, never hard-coded or committed.
/// Mainnet reads and deploys prefer the metered endpoint (reliable eth_call and
/// eth_getLogs, which the public dataseeds refuse), falling back to a public one.
const BSC_RPC_URL = process.env.ALCHEMY_BSC_RPC || process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";

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
    // Tests must still keep every tx under the 2**24 per-tx ceiling BSC enforces, which
    // is why one brain step per tx is the only advance shape used anywhere here.
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
    // Etherscan v2 uses a single key across supported chains (incl. BSC).
    apiKey: process.env.BSCSCAN_API_KEY || "",
  },
  sourcify: {
    enabled: false,
  },
};
