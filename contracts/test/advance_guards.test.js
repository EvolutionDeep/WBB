const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "..", "worm", "data");
const W = JSON.parse(fs.readFileSync(path.join(DATA, "brain_weights.json"), "utf8"));
const ADV_GAS = { gasLimit: 12_000_000 };

async function deployAndSeed() {
  const F = await ethers.getContractFactory("WormBrainV2");
  const g = W.groups;
  const b = await F.deploy();
  await b.waitForDeployment();
  await (await b.seed({
    blob: W.blob, v: W.init.V,
    attr: g.SENSORS_ATTR, oli: g.SENSORS_OLI, avert: g.SENSORS_AVERT,
    fwd: g.MOTOR_FWD, ava: g.INTER_AVA, avb: g.INTER_AVB, turn: g.TURN_IN,
    awcl: g.AWCL, awcr: g.AWCR, awal: g.AWAL, awar: g.AWAR,
    px: W.init.px, py: W.init.py, hx: W.init.hx, hy: W.init.hy,
  })).wait();
  return b;
}

// same byte-length as the canonical blob, but the last edge is corrupted, so
// keccak256(connBlob) != connRoot while the "blob len" gate still passes
function corruptBlob() {
  const raw = W.blob.slice(2); // drop 0x
  const last = parseInt(raw.slice(-2), 16);
  const flipped = (last ^ 0xff).toString(16).padStart(2, "0");
  return "0x" + raw.slice(0, -2) + flipped;
}

describe("advance() guards -- a wrong connectome can never move the worm", function () {
  this.timeout(600_000);
  let brain;

  before(async function () {
    brain = await deployAndSeed();
  });

  it("reverts on a corrupted connBlob (keccak != connRoot) and changes no state", async function () {
    const tickBefore = await brain.tick();
    const hashBefore = await brain.stateHash();
    await expect(brain.advance(1, corruptBlob(), ADV_GAS)).to.be.revertedWith("bad connome");
    expect(await brain.tick()).to.equal(tickBefore);
    expect(await brain.stateHash()).to.equal(hashBefore);
  });

  it("reverts on a wrong-length connBlob before hashing", async function () {
    await expect(brain.advance(1, "0xdeadbeef", ADV_GAS)).to.be.revertedWith("blob len");
  });

  it("reverts on empty connBlob", async function () {
    await expect(brain.advance(1, "0x", ADV_GAS)).to.be.revertedWith("blob len");
  });

  it("enforces the bounded step count (n in (0, 500])", async function () {
    await expect(brain.advance(0, W.blob, ADV_GAS)).to.be.revertedWith("n range");
    await expect(brain.advance(501, W.blob, ADV_GAS)).to.be.revertedWith("n range");
  });

  it("reverts stimulate out of the 0..301 neuron range and on an unseeded brain", async function () {
    await expect(brain.stimulate(302, 1000)).to.be.revertedWith("idx");
    const F = await ethers.getContractFactory("WormBrainV2");
    const fresh = await F.deploy();
    await fresh.waitForDeployment(); // deployed but NOT seeded
    await expect(fresh.advance(1, W.blob, ADV_GAS)).to.be.revertedWith("not seeded");
    await expect(fresh.stimulate(0, 1)).to.be.revertedWith("not seeded");
  });

  it("the canonical blob is accepted (positive control for the same code path)", async function () {
    const tickBefore = await brain.tick();
    await (await brain.advance(1, W.blob, ADV_GAS)).wait();
    expect(await brain.tick()).to.equal(tickBefore + 1n);
  });
});
