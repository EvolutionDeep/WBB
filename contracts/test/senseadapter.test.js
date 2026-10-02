const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "..", "worm", "data");
const W = JSON.parse(fs.readFileSync(path.join(DATA, "brain_weights.json"), "utf8"));

const SCALE = 1048576n;
const ASEL = 39, ASER = 40, AWCL = 76, AWCR = 77;
const AMP_CAP = 2_000_000n;      // adapter per-write cap (well under the brain's STIM_CAP)
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

describe("SenseAdapter -- the single sanctioned stimulation entry point", function () {
  this.timeout(600_000);
  let brain, pair, factory, adapter;
  const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
  const USDT = "0x55d398326f99059fF775485246999027B3197955";

  beforeEach(async function () {
    brain = await deployBrain();
    const P = await ethers.getContractFactory("FakePancakePair");
    pair = await (await P.deploy()).waitForDeployment();
    const FA = await ethers.getContractFactory("FakePancakeFactory");
    factory = await (await FA.deploy(await pair.getAddress())).waitForDeployment();
    const AD = await ethers.getContractFactory("SenseAdapter");
    adapter = await (await AD.deploy(
      await factory.getAddress(), WBNB, USDT, await brain.getAddress(), SCALE, AMP_CAP
    )).waitForDeployment();
  });

  it("freezes the pair immutably from factory.getPair at deploy", async function () {
    expect(await adapter.pair()).to.equal(await pair.getAddress());
    expect(await adapter.brain()).to.equal(await brain.getAddress());
  });

  it("inject: positive current -> ASEL, negative current -> ASER (never advance)", async function () {
    await (await adapter.inject(1_000_000)).wait();
    expect(await brain.stim(ASEL)).to.equal(1_000_000n);
    expect(await brain.stim(ASER)).to.equal(0n);

    await (await adapter.inject(-500_000)).wait();
    expect(await brain.stim(ASER)).to.equal(-500_000n);
    expect(await brain.stim(ASEL)).to.equal(1_000_000n); // untouched by the negative inject
  });

  it("inject clamps amplitude to the adapter cap (accumulate-safe, no revert)", async function () {
    await (await adapter.inject(50_000_000)).wait(); // far above AMP_CAP
    expect(await brain.stim(ASEL)).to.equal(AMP_CAP);
  });

  it("sample: the first frame only primes a baseline and injects nothing", async function () {
    await (await pair.setReserves(1_000_000, 2_000_000)).wait();
    await (await adapter.sample()).wait();
    expect(await adapter.isPrimed()).to.equal(true);
    expect(await brain.stim(ASEL)).to.equal(0n);
    expect(await brain.stim(ASER)).to.equal(0n);
    expect(await brain.stim(AWCL)).to.equal(0n);
  });

  it("sample: a positive reserve-ratio change charges ASEL and the arousal pair", async function () {
    await (await pair.setReserves(1_000_000, 2_000_000)).wait();
    await (await adapter.sample()).wait();           // prime -> ratio 2.0*SCALE
    await (await pair.setReserves(1_000_000, 2_500_000)).wait();
    await (await adapter.sample()).wait();           // ratio up by 0.5*SCALE

    expect(await brain.stim(ASEL)).to.equal(524288n);   // +delta into ASEL
    expect(await brain.stim(ASER)).to.equal(0n);        // negative neuron untouched
    expect(await brain.stim(AWCL)).to.equal(524288n);   // |delta| into AWCL
    expect(await brain.stim(AWCR)).to.equal(524288n);   // |delta| into AWCR
  });

  it("sample: a negative reserve-ratio change charges ASER (no interpretation of down-move)", async function () {
    await (await pair.setReserves(1_000_000, 2_100_000)).wait();
    await (await adapter.sample()).wait();           // prime
    await (await pair.setReserves(1_000_000, 1_900_000)).wait();
    await (await adapter.sample()).wait();           // ratio down

    expect(await brain.stim(ASER)).to.equal(-209715n); // negative delta into ASER
    expect(await brain.stim(ASEL)).to.equal(0n);       // positive neuron untouched
    expect(await brain.stim(AWCL)).to.equal(209715n);  // |delta| still arouses
  });

  it("BLOCK-SCOPE ACCUMULATION: two opposite stimuli in the same block add, never overwrite", async function () {
    await network.provider.send("evm_setAutomine", [false]);
    await brain.stimulate(ASEL, 5_000_000);   // +5.0
    await brain.stimulate(ASEL, -3_000_000);  // -3.0, must NOT clobber the +5.0
    await network.provider.send("evm_mine");  // both land in ONE block
    await network.provider.send("evm_setAutomine", [true]);

    // a naive overwrite would leave -3_000_000; correct accumulation leaves the sum
    expect(await brain.stim(ASEL)).to.equal(2_000_000n);
  });

  it("external use stays cheap: inject only calls stimulate (tens of thousands gas, no advance)", async function () {
    const tx = await adapter.inject(800_000);
    const rc = await tx.wait();
    expect(rc.gasUsed).to.be.lt(200_000n);
    // and it never advanced the animal: tick is unchanged from a fresh genesis
    expect(await brain.tick()).to.equal(0n);
  });
});
