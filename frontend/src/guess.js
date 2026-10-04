/**
 * WormGuess: the on-chain prediction game where the answer is the worm itself.
 *
 * The fourth sanctioned write path. Visitors can open a round ("will more than N
 * neurons fire on the next tick?"), stake tokens YES or NO, and the result settles
 * from the brain's own totalSpikes counter. No oracle, no house, no operator.
 *
 * Pins exactly two contracts: WormGuess and the project Token. Never touches the
 * brain directly (the game reads it). Private keys never leave the wallet.
 */
import { ethers } from "ethers";
import { t, label, take } from "./i18n.js";

export const GUESS = "0x8d3c1e2fED66aAB5293d0FC8983988Df15e6353b";
export const TOKEN = "0xA18f90eF3d4cc543141986c80442F87a2d2a7777";
const BRAIN = "0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3";
const CHAIN_ID = 56;
const MIN_STAKE = 1000000000000000000n; // 1 token (18 decimals)
const WORKER = "https://api.bscworm.com";

const GUESS_ABI = [
  "function roundCount() view returns (uint256)",
  "function rounds(uint256 id) view returns (uint256 targetTick, uint256 threshold, uint256 startSpikes, uint256 fired, uint256 yesStake, uint256 noStake, uint256 pot, uint64 openedBlock, uint8 status, bool yesWins)",
  "function createRound(uint256 threshold) external returns (uint256)",
  "function join(uint256 id, bool yes, uint256 nominal) external",
  "function settle(uint256 id) external",
  "function claim(uint256 id) external",
  "function expire(uint256 id) external",
  "function stakeOf(uint256 id, address who) view returns (uint256 yes, uint256 no, bool claimed)",
  "function resultOf(uint256 id) view returns (bool decided, uint256 fired, bool yesWins, uint8 status)",
  "function minStake() view returns (uint256)",
  "event RoundCreated(uint256 indexed id, uint256 indexed targetTick, uint256 threshold, uint256 startSpikes)",
  "event Settled(uint256 indexed id, uint256 indexed targetTick, uint256 fired, bool yesWins, uint8 status)",
];

const TOKEN_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address who) view returns (uint256)",
];

const BRAIN_ABI = ["function tick() view returns (uint256)"];

const RPC_URLS = [WORKER + "/api/rpc", "https://bsc-dataseed1.bnbchain.org", "https://bsc-rpc.publicnode.com"];

let provider = null;
let initialized = false;

export function init() {
  if (initialized) return;
  initialized = true;
  readState();
}

async function getProvider() {
  if (provider) return provider;
  provider = new ethers.JsonRpcProvider(RPC_URLS[0]);
  return provider;
}

async function getWriteProvider() {
  if (typeof window === "undefined" || !window.ethereum) throw new Error(t("c04.no_wallet"));
  const p = new ethers.BrowserProvider(window.ethereum);
  const net = await p.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(t("c04.wrong_chain"));
  return p;
}

async function readState() {
  try {
    const p = await getProvider();
    const guess = new ethers.Contract(GUESS, GUESS_ABI, p);
    const brain = new ethers.Contract(BRAIN, BRAIN_ABI, p);
    const [count, tick] = await Promise.all([guess.roundCount(), brain.tick()]);
    const st = document.getElementById("guess-status");
    if (st) label(take(st), "c10.state", { rounds: Number(count), tick: Number(tick) });
    // read last few rounds
    const feed = document.getElementById("guess-feed");
    if (feed) {
      feed.innerHTML = "";
      const from = Math.max(1, Number(count) - 4);
      for (let id = Number(count); id >= from; id--) {
        const r = await guess.rounds(id);
        const div = document.createElement("div");
        div.className = "guess-row";
        const statusTxt = r.status === 0 ? "OPEN" : r.status === 1 ? "SETTLED" : "REFUNDED";
        div.textContent = `#${id} tick>${Number(r.targetTick)} thr=${Number(r.threshold)} YES:${ethers.formatEther(r.yesStake)} NO:${ethers.formatEther(r.noStake)} [${statusTxt}]`;
        feed.appendChild(div);
      }
    }
  } catch { /* silent read failure on cold page */ }
}

export async function createRound(threshold) {
  const status = document.getElementById("guess-status");
  try {
    if (!window.ethereum) throw new Error(t("c04.no_wallet"));
    label(status, "c10.waiting");
    const p = await getWriteProvider();
    const granted = await p.send("eth_requestAccounts", []);
    if (!granted || !granted.length) throw new Error(t("c04.no_account"));
    const signer = await p.getSigner(granted[0]);
    const guess = new ethers.Contract(GUESS, GUESS_ABI, signer);
    const tx = await guess.createRound(threshold);
    label(status, "c04.tx_sent", { h: tx.hash.slice(0, 16) + "\u2026" });
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) throw new Error(t("c04.reverted"));
    label(status, "c10.created", { tick: Number(rcpt.blockNumber) });
    readState();
  } catch (e) {
    label(status, "c04.not_sent", { m: (e && e.message) || e });
  }
}

export async function joinRound(id, yes, nominal) {
  const status = document.getElementById("guess-status");
  try {
    if (!window.ethereum) throw new Error(t("c04.no_wallet"));
    label(status, "c10.approving");
    const p = await getWriteProvider();
    const granted = await p.send("eth_requestAccounts", []);
    if (!granted || !granted.length) throw new Error(t("c04.no_account"));
    const addr = await p.getSigner(granted[0]).then((s) => s.getAddress());
    const tokenC = new ethers.Contract(TOKEN, TOKEN_ABI, await p.getSigner(granted[0]));
    const allowance = await tokenC.allowance(addr, GUESS);
    if (allowance < BigInt(nominal)) {
      const tx2 = await tokenC.approve(GUESS, BigInt(nominal) * 2n);
      await tx2.wait();
    }
    label(status, "c10.joining");
    const guess = new ethers.Contract(GUESS, GUESS_ABI, await p.getSigner(granted[0]));
    const tx = await guess.join(id, yes, BigInt(nominal));
    label(status, "c04.tx_sent", { h: tx.hash.slice(0, 16) + "\u2026" });
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) throw new Error(t("c04.reverted"));
    label(status, "c10.joined", { side: yes ? "YES" : "NO" });
    readState();
  } catch (e) {
    label(status, "c04.not_sent", { m: (e && e.message) || e });
  }
}
