const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Reuse the authoritative genome emitted by brain_spec.py
const DATA = path.join(__dirname, "..", "..", "worm", "data");
const W = JSON.parse(fs.readFileSync(path.join(DATA, "brain_weights.json"), "utf8"));

const CHUNK = 1;
const ADV_GAS = { gasLimit: 12_000_000 };
const SCALE = 1048576n;

// Frozen indices -- MUST equal WormNeurons.sol / brain_weights.json "names"
const ASEL = 39, ASER = 40, AWAL = 72, AWAR = 73, AWCL = 76, AWCR = 77;
const AVAL = 53, AVAR = 54, AVBL = 55, AVBR = 56;

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
async function advanceSteps(b, total) {
  let done = 0;
  while (done < total) {
    const n = Math.min(CHUNK, total - done);
    await (await b.advance(n, W.blob, ADV_GAS)).wait();
    done += n;
  }
}
// independent reference of WormReadout._toBp: Q20 -> basis points, clamp +-10000,
// BigInt '/' truncates toward zero exactly like Solidity int256 '/'
function toBp(q20) {
  let bp = (q20 * 10000n) / SCALE;
  if (bp > 10000n) bp = 10000n;
  if (bp < -10000n) bp = -10000n;
  return bp;
}

describe("WormReadout -- read-only, deterministic lens on the live worm", function () {
  this.timeout(600_000);
  let brain, readout;

  before(async function () {
    brain = await deployBrain();
    await advanceSteps(brain, 12); // warm up so gates are non-zero
    const R = await ethers.getContractFactory("WormReadout");
    readout = await R.deploy(await brain.getAddress());
    await readout.waitForDeployment();
  });

  it("rejects a zero brain address", async function () {
    const R = await ethers.getContractFactory("WormReadout");
    await expect(R.deploy(ethers.ZeroAddress)).to.be.revertedWith("brain=0");
  });

  it("exposes the frozen named-indices and the 20-block staleness window", async function () {
    expect(await readout.STALE_WINDOW()).to.equal(20n);
    // the neuron names the readout is documented to use must match the genome order
    expect(W.names[ASEL]).to.equal("ASEL");
    expect(W.names[ASER]).to.equal("ASER");
    expect(W.names[AWCL]).to.equal("AWCL");
    expect(W.names[AWCR]).to.equal("AWCR");
    expect(W.names[AWAL]).to.equal("AWAL");
    expect(W.names[AWAR]).to.equal("AWAR");
    expect(W.names[AVBL]).to.equal("AVBL");
    expect(W.names[AVBR]).to.equal("AVBR");
    expect(W.names[AVAL]).to.equal("AVAL");
    expect(W.names[AVAR]).to.equal("AVAR");
  });

  it("computes approach/turn/speed as pure on-chain functions of gate (frozen-index proof)", async function () {
    const g = async (i) => await brain.gate(i);
    const expApproach = toBp((await g(ASEL)) - (await g(ASER)));
    const expTurn = toBp(((await g(AWCL)) + (await g(AWCR))) - ((await g(AWAL)) + (await g(AWAR))));
    const expSpeed = toBp(((await g(AVBL)) + (await g(AVBR))) - ((await g(AVAL)) + (await g(AVAR))));

    const r = await readout.read();
    // If any index were wrong, one of these three would mismatch the reference math.
    expect(BigInt(r.approach)).to.equal(expApproach);
    expect(BigInt(r.turn)).to.equal(expTurn);
    expect(BigInt(r.speed)).to.equal(expSpeed);
    for (const v of [r.approach, r.turn, r.speed]) {
      expect(v).to.be.gte(-10000).and.lte(10000);
    }
  });

  it("carries provenance: tick / blockNumber / stateHash mirror the brain at read time", async function () {
    const r = await readout.read();
    expect(r.tick).to.equal(await brain.tick());
    expect(r.stateHash).to.equal(await brain.stateHash());
    expect(r.blockNumber).to.equal(BigInt(await ethers.provider.getBlockNumber()));
  });

  it("read() is view and mutates nothing (stateHash identical before and after)", async function () {
    const before = await brain.stateHash();
    await readout.read.staticCall();
    await readout.read(); // a tx that only reads must not change the animal
    expect(await brain.stateHash()).to.equal(before);
  });

  it("is deterministic: two identically-advanced worms read identically", async function () {
    const a = await deployBrain();
    const b = await deployBrain();
    await advanceSteps(a, 8);
    await advanceSteps(b, 8);
    const R = await ethers.getContractFactory("WormReadout");
    const ra = await (await R.deploy(await a.getAddress())).waitForDeployment();
    const rb = await (await R.deploy(await b.getAddress())).waitForDeployment();
    const va = await ra.read();
    const vb = await rb.read();
    expect(va.approach).to.equal(vb.approach);
    expect(va.turn).to.equal(vb.turn);
    expect(va.speed).to.equal(vb.speed);
    expect(va.stateHash).to.equal(vb.stateHash);
  });

  it("clamps a saturating asymmetry to the +-10000 ceiling", async function () {
    // drive one chemoreceptor far above threshold, then confirm the reading is capped
    await (await brain.stimulate(ASEL, 8_000_000)).wait();
    await advanceSteps(brain, 3);
    const r = await readout.read();
    const expApproach = toBp((await brain.gate(ASEL)) - (await brain.gate(ASER)));
    expect(BigInt(r.approach)).to.equal(expApproach);
    expect(r.approach).to.be.lte(10000);
  });
});
