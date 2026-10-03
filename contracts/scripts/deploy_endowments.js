/// Deploy the two token endowments -- WormLedger (the inscription wall) and
/// WormGuess (the per-beat wager) -- against the already-live WormBrainV2.
///
/// Like every other script here this NEVER touches the animal: no seed, no
/// advance, no stimulate. It reads tick()/stateHash() before and after and fails
/// loudly if either moved, because a deployment that changed the worm would be a
/// bug in the deployment, not a feature.
///
/// The contracts are inert without a token, and the real token only exists on
/// mainnet, so a testnet rehearsal deploys the same tax-ERC20 the tests use
/// (contracts/mock/MockTaxToken.sol) and points both endowments at it.
///
/// Usage:
///   node scripts/deploy_endowments.js                          # plan only, no tx
///   node scripts/deploy_endowments.js --on testnet             # 97, mock token
///   node scripts/deploy_endowments.js --on testnet --token 0x.. # 97, own token
///   node scripts/deploy_endowments.js --on mainnet --i-authorize-mainnet
///   node scripts/deploy_endowments.js --only ledger ...        # one endowment only
///
/// Knobs (all in token units, 18 decimals):
///   TOKEN  TICKS_PER_SLOT  PRICE  MIN_STAKE
/// `price` and `ticksPerSlot` are `immutable` on the ledger and `minStake` is
/// immutable on the guess, so changing a parameter means deploying again. The
/// previous mainnet record is then kept under `WormLedgerSuperseded` rather than
/// overwritten: an abandoned wall is still on-chain and still sellable at its old
/// price, and a record that hid that would be lying about the supply of walls.
/// The private key is only read from contracts/.env and never printed.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const CHAINS = { testnet: 97n, mainnet: 56n };
const RPCS = {
  testnet: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  // the metered endpoint is preferred for mainnet reads: it answers eth_getLogs and
  // reliable eth_call where the public dataseeds answer -32005
  mainnet: process.env.ALCHEMY_BSC_RPC || process.env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com",
};
// the FLAP-launched WormBrain token (3%/3% tax): the endowments price in it
const MAINNET_TOKEN = "0xa18f90ef3d4cc543141986c80442f87a2d2a7777";

function loadArtifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf-8")
  );
}

function parseArgs() {
  const a = process.argv.slice(2);
  const on = a.includes("--on") ? a[a.indexOf("--on") + 1] : "plan";
  const only = a.includes("--only") ? a[a.indexOf("--only") + 1] : null;
  if (only !== null && !["ledger", "guess"].includes(only)) {
    throw new Error(`--only must be ledger or guess (got ${only})`);
  }
  return {
    on: on === "plan" ? null : on,
    only,
    authorizeMainnet: a.includes("--i-authorize-mainnet"),
    token: process.env.TOKEN || null,
    ticksPerSlot: BigInt(process.env.TICKS_PER_SLOT || "10"),
    price: ethers.parseEther(process.env.PRICE || "1"),
    minStake: ethers.parseEther(process.env.MIN_STAKE || "1"),
  };
}

async function deploy(name, wallet, args) {
  const art = loadArtifact(name);
  const c = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(...args);
  await c.waitForDeployment();
  const address = await c.getAddress();
  const receipt = await c.deploymentTransaction().wait();
  console.log(`${name}: ${address} (gas ${receipt.gasUsed}, block ${receipt.blockNumber})`);
  return { contract: c, address, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber };
}

async function main() {
  const cfg = parseArgs();
  if (cfg.on && !CHAINS[cfg.on]) throw new Error(`--on must be testnet or mainnet (got ${cfg.on})`);
  if (cfg.on === "mainnet" && !cfg.authorizeMainnet) {
    throw new Error("refusing to spend on mainnet without --i-authorize-mainnet");
  }

  console.log("plan:", JSON.stringify({
    on: cfg.on || "plan only (no transaction will be sent)",
    only: cfg.only || "both endowments",
    ticksPerSlot: cfg.ticksPerSlot.toString(),
    price: ethers.formatEther(cfg.price),
    minStake: ethers.formatEther(cfg.minStake),
  }));

  if (!cfg.on) {
    console.log("\nnetwork 97 rehearsal: node scripts/deploy_endowments.js --on testnet");
    console.log("mainnet is a separate, deliberate act: --on mainnet --i-authorize-mainnet");
    return;
  }

  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const provider = new ethers.JsonRpcProvider(RPCS[cfg.on], undefined, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (net.chainId !== CHAINS[cfg.on]) {
    throw new Error(`refusing to deploy: connected chain is ${net.chainId}, expected ${CHAINS[cfg.on]}`);
  }
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : "0x" + pk, provider);
  console.log("wallet:", wallet.address, "| balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "BNB");

  const recPath = path.join(__dirname, "..", "deployed_addresses.json");
  const rec = JSON.parse(fs.readFileSync(recPath, "utf-8"));
  const brainAddr = rec.WormBrain?.address;
  if (!brainAddr) throw new Error("WormBrain address not found in deployed_addresses.json");
  const brain = new ethers.Contract(brainAddr, ["function tick() view returns (uint256)", "function stateHash() view returns (bytes32)"], provider);
  const [tick0, hash0] = await Promise.all([brain.tick(), brain.stateHash()]);
  console.log(`brain ${brainAddr} at tick ${tick0} (this script must not move it)`);

  // ---- token: the real one when given, otherwise a mock so 97 can rehearse ----
  let tokenAddr = cfg.token || (cfg.on === "mainnet" ? MAINNET_TOKEN : null);
  let mock = null;
  if (!tokenAddr) {
    mock = await deploy("MockTaxToken", wallet, [ethers.parseEther("1000000")]);
    tokenAddr = mock.address;
    console.log("  a 3%-tax rehearsal token: the endowments must be tried against a token that");
    console.log("  delivers less than it is sent, because that is what the real one does");
  } else {
    console.log("token:", tokenAddr);
  }

  // ---- the two endowments, either of which may be skipped by --only ----
  const wantLedger = !cfg.only || cfg.only === "ledger";
  const wantGuess = !cfg.only || cfg.only === "guess";
  const ledger = wantLedger ? await deploy("WormLedger", wallet, [brainAddr, tokenAddr, cfg.ticksPerSlot, cfg.price]) : null;
  const guess = wantGuess ? await deploy("WormGuess", wallet, [brainAddr, tokenAddr, cfg.minStake]) : null;

  // ---- read-back: what the contracts think the animal is, and what they cannot do ----
  const [tick1, hash1] = await Promise.all([brain.tick(), brain.stateHash()]);
  if (tick1 !== tick0 || hash1 !== hash0) {
    throw new Error(`deployment changed the brain: tick ${tick0}->${tick1}. That must never happen.`);
  }
  const slot = ledger ? await ledger.contract.currentSlot() : null;
  const maxFired = guess ? await guess.contract.MAX_FIRED() : null;
  const parts = [];
  if (ledger) parts.push(`ledger slot ${slot} (tick ${tick1} / ${cfg.ticksPerSlot})`);
  if (guess) parts.push(`guess ceiling ${maxFired} neurons`);
  console.log("read-back: " + parts.join(", "));
  for (const [name, c] of [["WormLedger", ledger], ["WormGuess", guess]]) {
    if (!c) continue;
    for (const forbidden of ["owner", "pause", "upgrade", "withdraw", "mint", "advance", "stimulate"]) {
      if (c.contract.interface.getFunction(forbidden, { strict: false })) {
        throw new Error(`${name} exposes ${forbidden}: an endowment must not be able to touch the animal or the funds`);
      }
    }
  }
  console.log("read-back: neither contract owns, pauses, upgrades, withdraws, advances or stimulates");

  // ---- record ----
  // only the parameters each contract actually received: a record that lists a price
  // for WormGuess would describe a setter that does not exist
  const base = { brain: brainAddr, token: tokenAddr };
  const ledgerRecord = { ...base, ticksPerSlot: cfg.ticksPerSlot.toString(), price: cfg.price.toString() };
  const guessRecord = { ...base, minStake: cfg.minStake.toString() };
  // each contract's own receipt block, not the block the run happened to finish in:
  // a reader uses this number as the floor for scanning `Inscribed` events, and a floor
  // a few blocks late silently drops the earliest inscriptions.
  if (cfg.on === "mainnet") {
    if (ledger) {
      if (rec.WormLedger) {
        // the abandoned wall keeps selling at its own immutable price, so the record
        // has to say so instead of pretending there was only ever one
        rec.WormLedgerSuperseded = [
          ...(rec.WormLedgerSuperseded || []),
          { ...rec.WormLedger, supersededAtBlock: ledger.blockNumber, why: "price and ticksPerSlot are immutable; a re-price is a new deployment" },
        ];
      }
      rec.WormLedger = { address: ledger.address, ...ledgerRecord, deployedAtBlock: String(ledger.blockNumber) };
    }
    if (guess) rec.WormGuess = { address: guess.address, ...guessRecord, deployedAtBlock: String(guess.blockNumber) };
    fs.writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
    console.log("\ndeployed_addresses.json updated (" + [ledger && "WormLedger", guess && "WormGuess"].filter(Boolean).join(" + ") + ").");
  } else {
    const tPath = path.join(__dirname, "..", "deployed_addresses.testnet.json");
    const trec = fs.existsSync(tPath) ? JSON.parse(fs.readFileSync(tPath, "utf-8")) : {};
    trec.chainId = Number(CHAINS.testnet);
    if (ledger) trec.WormLedger = { address: ledger.address, ...ledgerRecord, deployedAtBlock: String(ledger.blockNumber) };
    if (guess) trec.WormGuess = { address: guess.address, ...guessRecord, deployedAtBlock: String(guess.blockNumber) };
    if (mock) trec.MockTaxToken = { address: mock.address };
    fs.writeFileSync(tPath, JSON.stringify(trec, null, 2) + "\n");
    console.log("\ndeployed_addresses.testnet.json updated (mainnet record untouched).");
  }
  console.log(`the animal is where it was: tick ${tick1}, stateHash unchanged.`);
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
