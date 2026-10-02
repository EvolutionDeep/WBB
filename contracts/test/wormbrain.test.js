const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Authoritative integer-spec data produced by brain_spec.py
const DATA = path.join(__dirname, "..", "..", "worm", "data");
const W = JSON.parse(fs.readFileSync(path.join(DATA, "brain_weights.json"), "utf8"));
const G = JSON.parse(fs.readFileSync(path.join(DATA, "brain_golden.json"), "utf8"));

// Local EDR per-tx gas cap is ~16.7M; a single cold step costs ~8.6M, so advance 1 step per tx.
// Chunking across many txs does not change the numbers (state lives in on-chain storage), only gas.
const CHUNK = 1;
const ADV_GAS = { gasLimit: 12_000_000 };

async function deployBrain() {
  const F = await ethers.getContractFactory("WormBrain");
  const g = W.groups;
  const b = await F.deploy();                 // near-empty constructor (EIP-3860 on BSC mainnet)
  await b.waitForDeployment();
  const t = await b.seed({
    blob: W.blob, v: W.init.V,
    attr: g.SENSORS_ATTR, oli: g.SENSORS_OLI, avert: g.SENSORS_AVERT,
    fwd: g.MOTOR_FWD, ava: g.INTER_AVA, avb: g.INTER_AVB, turn: g.TURN_IN,
    awcl: g.AWCL, awcr: g.AWCR, awal: g.AWAL, awar: g.AWAR,
    px: W.init.px, py: W.init.py, hx: W.init.hx, hy: W.init.hy,
  });
  await t.wait();
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

describe("WormBrain -- on-chain life == brain_spec golden trajectory", function () {
  this.timeout(600_000);
  let brain;

  before(async function () {
    brain = await deployBrain();
  });

  it("init: 302 neurons / edge count / connRoot / tick=0 / initial membrane voltages", async function () {
    expect(await brain.N()).to.equal(302);
    expect(await brain.edgeCount()).to.equal(W.nEdges);
    expect(await brain.connRoot()).to.equal(ethers.keccak256(W.blob));
    expect(await brain.tick()).to.equal(0);
    for (let i = 0; i < 302; i += 97) {
      expect(await brain.V(i)).to.equal(W.init.V[i]);
    }
  });

  it("advance determinism: two fresh instances reach the same stateHash after the same steps", async function () {
    const a = await deployBrain();
    const c = await deployBrain();
    await advanceSteps(a, 9);
    await advanceSteps(c, 9);
    expect(await a.stateHash()).to.equal(await c.stateHash());
  });

  it("reproduces the golden run: 60 steps -> stimulate AVAR -> up to 90 steps, final state byte-identical", async function () {
    const st = G.stimuli[0];
    await advanceSteps(brain, st.beforeStep);            // first 60 steps
    await (await brain.stimulate(st.idx, st.ampQ)).wait();
    await advanceSteps(brain, G.steps - st.beforeStep);  // then the remaining 30

    // Golden state hash (covers all 912 words of V/gate/stim/pos/heading/tick) must be byte-identical.
    // Note: brain_spec's hexdigest has no 0x prefix, the on-chain return value has one.
    expect(await brain.stateHash()).to.equal("0x" + G.finalStateHash);
    expect(await brain.tick()).to.equal(G.finalTick);
    expect(await brain.totalSpikes()).to.equal(G.finalTotalSpikes);
    expect(await brain.px()).to.equal(G.finalPos[0]);
    expect(await brain.hx()).to.equal(G.finalHeading[0]);
    expect(await brain.hy()).to.equal(G.finalHeading[1]);
    // Spot-check final voltages + spike counts of a few neurons (full coverage already guaranteed by stateHash)
    const probes = [st.idx, W.groups.AWAR, W.groups.AWCL, 0, 150, 301];
    for (const i of probes) {
      expect(await brain.V(i)).to.equal(G.finalV[i], `V[${i}] mismatch`);
      expect(await brain.spikeCount(i)).to.equal(G.finalSpike[i], `spike[${i}] mismatch`);
    }
  });

  it("stimulation really changes the neuron trajectory", async function () {
    const base = await deployBrain();
    const poked = await deployBrain();
    await (await poked.stimulate(0, 4_000_000)).wait(); // inject a large current into neuron 0
    await advanceSteps(base, 6);
    await advanceSteps(poked, 6);
    expect(await poked.V(0)).to.not.equal(await base.V(0));
    expect(await poked.stateHash()).to.not.equal(await base.stateHash());
  });
});
