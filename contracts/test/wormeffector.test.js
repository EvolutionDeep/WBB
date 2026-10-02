const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "..", "worm", "data");
const W = JSON.parse(fs.readFileSync(path.join(DATA, "brain_weights.json"), "utf8"));
const ADV_GAS = { gasLimit: 12_000_000 };

async function deployBrain() {
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

describe("WormEffectorDemo -- brain and business stay separate contracts", function () {
  this.timeout(600_000);
  let brain, readout, effector;

  beforeEach(async function () {
    brain = await deployBrain();
    for (let i = 0; i < 6; i++) await (await brain.advance(1, W.blob, ADV_GAS)).wait();
    const R = await ethers.getContractFactory("WormReadout");
    readout = await (await R.deploy(await brain.getAddress())).waitForDeployment();
    const E = await ethers.getContractFactory("WormEffectorDemo");
    effector = await (await E.deploy(await readout.getAddress())).waitForDeployment();
  });

  it("rejects a zero readout address", async function () {
    const E = await ethers.getContractFactory("WormEffectorDemo");
    await expect(E.deploy(ethers.ZeroAddress)).to.be.revertedWith("readout=0");
  });

  it("act() records a FRESH reading from its own address without touching the animal", async function () {
    const before = await brain.stateHash();
    const expected = await readout.read.staticCall();
    await (await effector.act()).wait();

    const a = await effector.lastAction();
    expect(a.approach).to.equal(expected.approach);
    expect(a.turn).to.equal(expected.turn);
    expect(a.speed).to.equal(expected.speed);
    expect(a.fresh).to.equal(true); // read in the same/next block, well inside the 20-block window
    expect(await effector.hasActed()).to.equal(true);

    // the effector neither stimulated nor advanced: the animal's state is untouched
    expect(await brain.stateHash()).to.equal(before);
  });

  it("flags STALE once tick stops advancing (read-time blockNumber is not a liveness clock)", async function () {
    await (await effector.act()).wait();                       // records the advance block (tick moved in beforeEach)
    expect((await effector.lastAction()).fresh).to.equal(true);

    await ethers.provider.send("hardhat_mine", ["0x67"]);      // 103 blocks with NO advance

    // the read-time blockNumber still equals the current height => the old formula would wrongly say "fresh"
    const r = await readout.read.staticCall();
    const cur = await ethers.provider.getBlockNumber();
    expect(BigInt(cur) - BigInt(r.blockNumber)).to.equal(0n);

    // the corrected effector sees tick frozen and marks the reading stale
    await (await effector.act()).wait();
    const a = await effector.lastAction();
    expect(a.fresh).to.equal(false);
    expect(a.tick).to.equal(6);                                 // unchanged: the animal is dormant

    // waking the animal (advance) makes a subsequent read fresh again
    await (await brain.advance(1, W.blob, ADV_GAS)).wait();
    await (await effector.act()).wait();
    expect((await effector.lastAction()).fresh).to.equal(true);
    expect((await effector.lastAction()).tick).to.equal(7);
  });
});
