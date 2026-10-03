const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Reuse the authoritative genome emitted by brain_spec.py, exactly like the other
// suites: the ledger must be tested against the REAL animal whose ticks it sells,
// never against a stand-in that could drift from the deployed connRoot.
const DATA = path.join(__dirname, "..", "..", "worm", "data");
const W = JSON.parse(fs.readFileSync(path.join(DATA, "brain_weights.json"), "utf8"));

const ADV_GAS = { gasLimit: 12_000_000 };
const E18 = 10n ** 18n;
const TICKS_PER_SLOT = 10n;
const PRICE = 1n * E18; // one token that must ARRIVE, net of the 3% transfer tax
const TAX_BPS = 300n;
// smallest nominal whose net receipt still reaches PRICE: ceil(price*10000/9700)
const NOMINAL = (PRICE * 10000n + 10000n - 1n) / (10000n - TAX_BPS);
const netOf = (v) => v - (v * TAX_BPS) / 10000n;

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
    await (await b.advance(1, W.blob, ADV_GAS)).wait();
    done += 1;
  }
}

describe("WormLedger", () => {
  let brain, token, ledger, alice, bob;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    alice = signers[1];
    bob = signers[2];
    brain = await deployBrain();
    const T = await ethers.getContractFactory("MockTaxToken");
    token = await T.deploy(1_000_000n * E18);
    await token.waitForDeployment();
    const L = await ethers.getContractFactory("WormLedger");
    ledger = await L.deploy(await brain.getAddress(), await token.getAddress(), TICKS_PER_SLOT, PRICE);
    await ledger.waitForDeployment();
    await token.mint(alice.address, 1000n * E18);
    await token.mint(bob.address, 1000n * E18);
  });

  const fund = async (who, amount) => token.connect(who).approve(await ledger.getAddress(), amount);

  it("engraves a span of life that has already happened", async () => {
    await advanceSteps(brain, 12); // ticks 1..12, so slot 1 (10,11,12) is alive
    expect(await brain.tick()).to.equal(12n);
    expect(await ledger.currentSlot()).to.equal(1n);

    await fund(alice, NOMINAL);
    await expect(ledger.connect(alice).inscribe(1, "the year of the cold snap", NOMINAL))
      .to.emit(ledger, "Inscribed");

    const e = await ledger.entries(1);
    expect(e.author).to.equal(alice.address);
    expect(e.nominal).to.equal(NOMINAL);
    expect(e.burned).to.equal(netOf(NOMINAL));
    expect(e.text).to.equal("the year of the cold snap");
    expect(e.tickAt).to.equal(12n);
    expect(await ledger.taken()).to.equal(1n);
    expect(await ledger.available(1)).to.equal(false);
  });

  it("destroys what arrived and keeps nothing", async () => {
    await advanceSteps(brain, 11);
    await fund(alice, NOMINAL);
    const sink0 = await token.balanceOf(ethers.ZeroAddress);
    await ledger.connect(alice).inscribe(1, "burn proof", NOMINAL);

    expect(await token.balanceOf(await ledger.getAddress())).to.equal(0n);
    const sink1 = await token.balanceOf(ethers.ZeroAddress);
    expect(sink1 - sink0).to.be.greaterThanOrEqual(netOf(NOMINAL));
    expect(await token.balanceOf(alice.address)).to.equal(1000n * E18 - NOMINAL);
  });

  it("a taken slot is taken forever, and nothing can edit or remove one", async () => {
    await advanceSteps(brain, 11);
    await fund(alice, NOMINAL);
    await ledger.connect(alice).inscribe(1, "first voice wins", NOMINAL);

    await fund(bob, NOMINAL);
    await expect(ledger.connect(bob).inscribe(1, "too late", NOMINAL))
      .to.be.revertedWith("slot taken");

    // no owner, no setter, no pause, no upgrade: the surface is only what it reads
    const fns = ledger.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    expect(fns.some((n) => /^(set|update|remove|delete|withdraw|owner|pause|upgrade|migrate)/i.test(n)))
      .to.equal(false);
    expect(fns).to.not.include("advance");
    expect(fns).to.not.include("stimulate");
  });

  it("the future is not for sale", async () => {
    await advanceSteps(brain, 5); // still inside slot 0
    await fund(alice, NOMINAL);
    await expect(ledger.connect(alice).inscribe(1, "reserved for later", NOMINAL))
      .to.be.revertedWith("slot is in the future");
    expect(await ledger.available(1)).to.equal(false);
    expect(await ledger.available(0)).to.equal(true);
  });

  it("prices what ARRIVES, not what was asked for", async () => {
    await advanceSteps(brain, 11);
    // nominal exactly equal to the price falls short: the tax eats 3% of it
    await fund(alice, PRICE);
    await expect(ledger.connect(alice).inscribe(1, "short by the tax", PRICE))
      .to.be.revertedWith("net receipt below price");

    await fund(alice, NOMINAL);
    await ledger.connect(alice).inscribe(1, "clears net", NOMINAL);
    const e = await ledger.entries(1);
    expect(e.burned).to.equal(netOf(NOMINAL));
    expect(e.burned).to.be.greaterThanOrEqual(PRICE);
  });

  it("with a tax of zero the nominal and the price are the same number", async () => {
    await advanceSteps(brain, 11);
    await token.setTaxBps(0);
    await fund(alice, PRICE);
    await ledger.connect(alice).inscribe(1, "untaxed path", PRICE);
    expect((await ledger.entries(1)).burned).to.equal(PRICE);
  });

  it("accepts printable ASCII and nothing else", async () => {
    await advanceSteps(brain, 11);
    await fund(alice, NOMINAL * 4n);
    const tooShort = ["", "text length"];
    const tooLong = ["x".repeat(65), "text length"];
    const newline = ["line\nbreak", "text must be printable ASCII"];
    const tab = ["tab\there", "text must be printable ASCII"];
    const nonAscii = ["caf\u00e9", "text must be printable ASCII"];
    const emoji = ["\u{1F41B}", "text must be printable ASCII"];

    // every probe uses slot 1, the only slot this tick count has opened: a higher
    // slot would trip the future-slot guard first and prove nothing about the text
    for (const [text, reason] of [tooShort, tooLong, newline, tab, nonAscii, emoji]) {
      await expect(ledger.connect(alice).inscribe(1, text, NOMINAL))
        .to.be.revertedWith(reason);
    }
    // the boundary cases are allowed: exactly 64 printable bytes, spaces included
    expect(await ledger.available(1)).to.equal(true);
    await ledger.connect(alice).inscribe(1, "a".repeat(64), NOMINAL);
    expect((await ledger.entries(1)).text.length).to.equal(64);
  });

  it("rejects a nominal below the price before touching the token", async () => {
    await advanceSteps(brain, 11);
    await fund(alice, PRICE);
    const before = await token.balanceOf(alice.address);
    await expect(ledger.connect(alice).inscribe(1, "cheap", PRICE / 2n))
      .to.be.revertedWith("nominal below price");
    expect(await token.balanceOf(alice.address)).to.equal(before);
  });

  it("tracks the animal's own counter as its only source of new slots", async () => {
    expect(await ledger.currentSlot()).to.equal(0n); // tick 0 -> slot 0
    await advanceSteps(brain, 9);
    expect(await ledger.currentSlot()).to.equal(0n); // tick 9 still slot 0
    await advanceSteps(brain, 1);
    expect(await ledger.currentSlot()).to.equal(1n); // tick 10 opens slot 1
    expect(await ledger.slotOf(await brain.tick())).to.equal(1n);
  });

  it("constructs only with real coordinates and a positive price", async () => {
    const L = await ethers.getContractFactory("WormLedger");
    const brainAddr = await brain.getAddress();
    const tokenAddr = await token.getAddress();
    await expect(L.deploy(ethers.ZeroAddress, tokenAddr, 10n, PRICE)).to.be.revertedWith("zero addr");
    await expect(L.deploy(brainAddr, ethers.ZeroAddress, 10n, PRICE)).to.be.revertedWith("zero addr");
    await expect(L.deploy(brainAddr, tokenAddr, 0n, PRICE)).to.be.revertedWith("bad params");
    await expect(L.deploy(brainAddr, tokenAddr, 10n, 0n)).to.be.revertedWith("bad params");
  });
});
