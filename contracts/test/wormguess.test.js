const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// The wager is settled against the real animal, so it is tested against the real
// animal: the deployed WormBrainV2 genome, advanced step by step, with the firing
// counts read from its own events. Nothing here mocks the nervous system.
const DATA = path.join(__dirname, "..", "..", "worm", "data");
const W = JSON.parse(fs.readFileSync(path.join(DATA, "brain_weights.json"), "utf8"));

const ADV_GAS = { gasLimit: 12_000_000 }; // under the 2**24 per-tx ceiling BSC enforces
const E18 = 10n ** 18n;
const MIN = 1n * E18; // a stake must land this much, net of the transfer tax
const TAX_BPS = 300n;
const NOMINAL = (MIN * 10000n + 10000n - 1n) / (10000n - TAX_BPS);
const netOf = (v) => v - (v * TAX_BPS) / 10000n;
const MAX_FIRED = 302n;

const OPEN = 0, SETTLED = 1, REFUNDED = 2;

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

// one cold step, and the number of neurons that actually fired, read from the
// brain's own Advanced event rather than inferred from anything else
async function step(b) {
  const rc = await (await b.advance(1, W.blob, ADV_GAS)).wait();
  for (const lg of rc.logs) {
    let p;
    try { p = b.interface.parseLog(lg); } catch { continue; }
    if (p && p.name === "Advanced") return { tick: Number(p.args.tick), fired: Number(p.args.fired) };
  }
  throw new Error("no Advanced log in the advance receipt");
}

describe("WormGuess", () => {
  let brain, token, guess, alice, bob, carol;

  beforeEach(async () => {
    const s = await ethers.getSigners();
    alice = s[1]; bob = s[2]; carol = s[3];
    brain = await deployBrain();
    const T = await ethers.getContractFactory("MockTaxToken");
    token = await T.deploy(1_000_000n * E18);
    await token.waitForDeployment();
    const G = await ethers.getContractFactory("WormGuess");
    guess = await G.deploy(await brain.getAddress(), await token.getAddress(), MIN);
    await guess.waitForDeployment();
    for (const who of [alice, bob, carol]) {
      await token.mint(who.address, 1000n * E18);
      await token.connect(who).approve(await guess.getAddress(), 500n * E18);
    }
    await step(brain); // a seeded brain has tick 0; the animal has to be alive first
  });

  it("binds a round to exactly one upcoming tick", async () => {
    const t = BigInt(await brain.tick());
    const tx = await guess.createRound(5n);
    const id = await guess.roundCount();
    expect(await guess.roundIdForTick(t + 1n)).to.equal(id);
    const r = await guess.rounds(id);
    expect(r.targetTick).to.equal(t + 1n);
    expect(r.startSpikes).to.equal(await brain.totalSpikes());
    expect(r.status).to.equal(OPEN);

    // a second round for the same beat is refused: no parallel wagers on one tick
    await expect(guess.createRound(7n)).to.be.revertedWith("round for that tick exists");
  });

  it("refuses a threshold the genome cannot produce", async () => {
    await expect(guess.createRound(MAX_FIRED + 1n)).to.be.revertedWith("threshold out of range");
    await guess.createRound(MAX_FIRED); // the ceiling itself is a legal question
  });

  it("closes staking the moment the outcome is observable", async () => {
    await guess.createRound(5n);
    await guess.connect(alice).join(1, true, NOMINAL); // before the beat: allowed

    await step(brain);
    await expect(guess.connect(bob).join(1, false, NOMINAL))
      .to.be.revertedWith("outcome already observable");
  });

  it("will not let one address bet both ways on the same tick", async () => {
    await guess.createRound(5n);
    await guess.connect(alice).join(1, true, NOMINAL);
    await expect(guess.connect(alice).join(1, false, NOMINAL))
      .to.be.revertedWith("already on the other side");
  });

  it("settles on the animal's own counter and cannot be argued with", async () => {
    const before = BigInt(await brain.totalSpikes());
    await guess.createRound(5n);
    await guess.connect(alice).join(1, true, NOMINAL);
    await guess.connect(bob).join(1, false, NOMINAL);

    const { fired } = await step(brain);
    expect(BigInt(await brain.totalSpikes()) - before).to.equal(BigInt(fired));

    // settling early is impossible, so the tick has to have happened
    await guess.settle(1);
    const r = await guess.rounds(1);
    expect(r.fired).to.equal(BigInt(fired));
    expect(r.yesWins).to.equal(BigInt(fired) > 5n);
    expect(r.status).to.equal(SETTLED);
  });

  it("pays the winner the whole pot, net of the tax on the way out", async () => {
    // threshold at the ceiling: fired can never exceed it, so NO wins for certain
    await guess.createRound(MAX_FIRED);
    await guess.connect(alice).join(1, true, NOMINAL);
    await guess.connect(bob).join(1, false, NOMINAL);
    await step(brain);
    await guess.settle(1);

    const r = await guess.rounds(1);
    expect(r.yesWins).to.equal(false);
    expect(r.pot).to.equal(netOf(NOMINAL) * 2n);

    const bal0 = await token.balanceOf(bob.address);
    const tx = await guess.connect(bob).claim(1);
    await expect(tx).to.emit(guess, "Claimed");
    const bal1 = await token.balanceOf(bob.address);

    expect(bal1 - bal0).to.equal(netOf(r.pot));   // owed == the entire pot
    expect(r.pot - (bal1 - bal0)).to.equal((r.pot * TAX_BPS) / 10000n); // the tax, declared
  });

  it("owes the losing side nothing and still lets them claim without reverting", async () => {
    await guess.createRound(MAX_FIRED);
    await guess.connect(alice).join(1, true, NOMINAL);
    await guess.connect(bob).join(1, false, NOMINAL);
    await step(brain);
    await guess.settle(1);

    const bal0 = await token.balanceOf(alice.address);
    await expect(guess.connect(alice).claim(1)).to.emit(guess, "Claimed");
    expect(await token.balanceOf(alice.address)).to.equal(bal0);

    const p = await guess.positions(1, alice.address);
    expect(p.claimed).to.equal(true);
    await expect(guess.connect(alice).claim(1)).to.be.revertedWith("claimed");
  });

  it("refunds everyone when nobody stood on the winning side", async () => {
    await guess.createRound(MAX_FIRED); // NO wins
    await guess.connect(alice).join(1, true, NOMINAL); // the only stake is on YES
    await step(brain);
    await guess.settle(1);

    expect((await guess.rounds(1)).status).to.equal(REFUNDED);
    const bal0 = await token.balanceOf(alice.address);
    await guess.connect(alice).claim(1);
    expect(await token.balanceOf(alice.address) - bal0).to.equal(netOf(netOf(NOMINAL)));
  });

  it("refunds instead of gifting when nobody settles the beat in time", async () => {
    await guess.createRound(MAX_FIRED);
    await guess.connect(alice).join(1, true, NOMINAL);
    await guess.connect(bob).join(1, false, NOMINAL);

    // the beat happens and nobody settles it, then the animal moves on. Two ordinary
    // single-step txs are enough for that, and they are the ONLY way it can happen on
    // the real chain: BSC rejects a tx whose gas limit exceeds 2**24, and advance(2)
    // needs ~19M, so a keeper can never batch two steps into one tx and skip a tick.
    await step(brain); // tick lands exactly on the round's target, unsettled
    await step(brain); // one tick behind it now: the measurement window has closed
    await expect(guess.settle(1)).to.be.revertedWith("not that tick");

    await guess.expire(1);
    expect((await guess.rounds(1)).status).to.equal(REFUNDED);

    const bal0 = await token.balanceOf(bob.address);
    await guess.connect(bob).claim(1);
    expect(await token.balanceOf(bob.address) - bal0).to.equal(netOf(netOf(NOMINAL)));
  });

  it("cannot be settled or expired while the beat has not arrived", async () => {
    await guess.createRound(5n);
    await guess.connect(alice).join(1, true, NOMINAL);
    await expect(guess.settle(1)).to.be.revertedWith("not that tick");
    await expect(guess.expire(1)).to.be.revertedWith("tick has not been passed");
    await expect(guess.connect(carol).claim(1)).to.be.revertedWith("round still open");
  });

  it("enforces the minimum stake on what arrives, not on what was asked", async () => {
    await guess.createRound(5n);
    await expect(guess.connect(alice).join(1, true, MIN / 2n))
      .to.be.revertedWith("stake below minimum");
    // nominal exactly at the minimum nets 3% short of it
    await expect(guess.connect(alice).join(1, true, MIN))
      .to.be.revertedWith("net stake below minimum");
    await guess.connect(alice).join(1, true, NOMINAL);
    const p = await guess.positions(1, alice.address);
    expect(p.yes).to.equal(netOf(NOMINAL));
  });

  it("never advances or stimulates the worm: every entry point is pure read", async () => {
    await step(brain);
    const t0 = await brain.tick();
    const s0 = await brain.totalSpikes();

    await guess.createRound(5n);
    await guess.connect(alice).join(1, true, NOMINAL);
    await guess.connect(bob).join(1, false, NOMINAL);
    await guess.rounds(1);
    await guess.resultOf(1);
    await expect(guess.settle(1)).to.be.revertedWith("not that tick"); // the beat has not landed

    expect(await brain.tick()).to.equal(t0);
    expect(await brain.totalSpikes()).to.equal(s0);

    // and the surface itself carries no path into the animal and nothing an operator
    // could ever turn: settle() is a public rule, not a privileged switch
    const fns = guess.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    expect(fns).to.not.include("advance");
    expect(fns).to.not.include("stimulate");
    for (const forbidden of ["owner", "pause", "upgrade", "withdraw", "mint", "setMinStake", "setThreshold", "setPot"]) {
      expect(fns, `WormGuess must not expose ${forbidden}`).to.not.include(forbidden);
    }
  });

  it("walks both settlement branches on real biological output", async () => {
    // YES can only win if some step actually fires a neuron. The animal is under no
    // obligation to cooperate with the test, so this drives real ticks until both
    // outcomes have been observed, and fails loudly if the worm never fires.
    let sawYes = false, sawNo = false, steps = 0;
    for (let i = 0; i < 24 && !(sawYes && sawNo); i++) {
      await guess.createRound(0n); // YES wins when fired > 0
      const id = await guess.roundCount();
      await guess.connect(alice).join(id, true, NOMINAL);
      await guess.connect(bob).join(id, false, NOMINAL);
      const { fired } = await step(brain);
      steps += 1;
      await guess.settle(id);
      const r = await guess.rounds(id);
      expect(r.fired).to.equal(BigInt(fired));
      expect(r.yesWins).to.equal(BigInt(fired) > 0n);
      if (r.yesWins) sawYes = true; else sawNo = true;
      await guess.connect(r.yesWins ? alice : bob).claim(id);
    }
    expect(sawNo, "every step fired at least one neuron over 24 real ticks").to.equal(true);
    expect(sawYes, `no step fired a neuron across ${steps} real ticks`).to.equal(true);
  });
});
