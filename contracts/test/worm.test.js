const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

/// Logic verification on the local in-memory chain (zero cost, not a testnet):
/// covers genome anchoring, signature authorization, tick monotonicity,
/// and rejection of replays / unauthorized nodes.
describe("WormHeartbeat soul-layer logic", function () {
  let owner, other, genome, hb, nodeKey;

  const ROOT = "0x" + "11".repeat(32);
  const SRC = "0x" + "22".repeat(32);

  beforeEach(async function () {
    [owner, other] = await ethers.getSigners();
    const Genome = await ethers.getContractFactory("WormGenome");
    genome = await Genome.deploy(ROOT, 302, 5146, SRC);
    await genome.waitForDeployment();
    const HB = await ethers.getContractFactory("WormHeartbeat");
    hb = await HB.deploy(await genome.getAddress());
    await hb.waitForDeployment();
    // Dedicated node private key (fixed local test value, controls no real funds)
    nodeKey = new ethers.Wallet(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
    );
    await hb.setNode(nodeKey.address, true);
  });

  // Exactly matches the contract's beatDigest: sign the raw digest with SigningKey (no EIP-191 prefix)
  async function signedBeat(tick, stateRoot) {
    const digest = await hb.beatDigest(tick, stateRoot);
    const sk = new ethers.SigningKey(nodeKey.privateKey);
    const sig = sk.sign(digest); // { r, s, yParity, v }
    return { v: sig.v, r: sig.r, s: sig.s };
  }

  it("stores genome dimensions correctly", async function () {
    expect(await genome.nNeurons()).to.equal(302);
    expect(await genome.nEdges()).to.equal(5146);
    expect(await genome.connectomeRoot()).to.equal(ROOT);
    expect(await genome.genesisAuthor()).to.equal(owner.address);
  });

  it("an approved node can submit heartbeats, tick advances monotonically", async function () {
    const sr = "0x" + "aa".repeat(32);
    const { v, r, s } = await signedBeat(10, sr);
    await hb.beat(10, sr, v, r, s);
    expect(await hb.latestTick()).to.equal(10);
    expect(await hb.latestStateRoot()).to.equal(sr);
    expect(await hb.historyLength()).to.equal(1);
  });

  it("rejects non-monotonic tick", async function () {
    const sr = "0x" + "bb".repeat(32);
    const a = await signedBeat(20, sr);
    await hb.beat(20, sr, a.v, a.r, a.s);
    const b = await signedBeat(15, sr); // rollback attempt
    await expect(hb.beat(15, sr, b.v, b.r, b.s)).to.be.revertedWith(
      "tick not monotonic"
    );
  });

  it("rejects signatures from unauthorized nodes", async function () {
    const rogue = new ethers.Wallet(
      "0x0000000000000000000000000000000000000000000000000000000000000042"
    );
    const digest = await hb.beatDigest(5, "0x" + "cc".repeat(32));
    const sig = new ethers.SigningKey(rogue.privateKey).sign(digest);
    await expect(
      hb.beat(5, "0x" + "cc".repeat(32), sig.v, sig.r, sig.s)
    ).to.be.revertedWith("unauthorized node");
  });

  it("rejects an empty state root", async function () {
    const { v, r, s } = await signedBeat(3, ethers.ZeroHash);
    await expect(hb.beat(3, ethers.ZeroHash, v, r, s)).to.be.revertedWith(
      "empty state"
    );
  });

  it("rejects deployment with a zero genome address", async function () {
    const HB = await ethers.getContractFactory("WormHeartbeat");
    await expect(HB.deploy(ethers.ZeroAddress)).to.be.revertedWith("zero genome");
  });
});
