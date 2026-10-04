/**
 * The public "wake the worm" path — the site's third sanctioned write module, and the
 * only one that can move the animal. Everything it touches is pinned and single-purpose:
 *
 *   - target is the deployed brain itself (WormBrainV2), never the adapter or the ledger;
 *   - it encodes exactly one state-changing call, advance(uint256,bytes), with n fixed to 1
 *     (a cold step is ~9.4M gas and BSC rejects any tx whose gas limit exceeds 2**24, so a
 *     single tx can only ever carry one brain step);
 *   - advance() verifies keccak256(connBlob)==connRoot on-chain, so we refuse to even build
 *     the transaction unless the genome blob we fetched hashes to the connRoot this page
 *     pins -- a wrong or tampered blob would only burn gas on a revert;
 *   - the key never passes through this page: signing happens inside the visitor's wallet,
 *     we only relay it. The visitor pays the gas; that is the whole point -- anyone can keep
 *     the animal alive, nobody owns the heartbeat.
 *
 * The brain is otherwise passive: reads never move it, and a feed queues until a step runs.
 * This module is what lets a visitor be the one who runs that step.
 */
import { BrowserProvider, Contract, getAddress, keccak256 } from "ethers";
import { t, label, take, onLangChange } from "./i18n.js";

export const BRAIN = "0x49E89C58bA3b1f4BEe9a9CFdbC00628cB33fC6A3";
// the corrected-direction genome anchor, proven on-chain; the fetched blob must hash to this
export const CONN_ROOT = "0x38dc5c120b55d24182cb3f81738c271c7255de5ffa1507f8aa4cb950494d8cac";
// BSC refuses any transaction whose gas limit exceeds 2**24; one brain step fits, two do not.
const TX_GAS_CAP = 16_777_216n;
const BLOB_URL = "data/connblob.txt";

const WAKE_ABI = [
  "function advance(uint256 n, bytes connBlob) external",
  "function tick() view returns (uint256)",
];

let provider = null;
let blobHex = null; // fetched once, verified against CONN_ROOT, then reused
let lastStatus = null;

const el = (id) => document.getElementById(id);

function setStatus(key, params, cls) {
  const s = el("wake-status");
  if (!s) return;
  lastStatus = { key, params: params || null, cls: cls || "" };
  label(take(s), key, params);
  s.className = "v " + (cls || "");
}

function repaintStatus() {
  if (lastStatus) setStatus(lastStatus.key, lastStatus.params, lastStatus.cls);
}

// load the genome blob the brain was seeded with and prove it is THAT genome before a
// single gas is spent: the chain checks keccak256(connBlob)==connRoot every step anyway,
// so a mismatch here would just be a paid revert -- refuse early and say why
async function ensureBlob() {
  if (blobHex) return blobHex;
  const text = (await (await fetch(BLOB_URL)).text()).trim();
  if (!/^0x[0-9a-fA-F]+$/.test(text)) throw new Error(t("c04.wake_root_fail"));
  if (keccak256(text) !== CONN_ROOT) throw new Error(t("c04.wake_root_fail"));
  blobHex = text;
  return blobHex;
}

/** Send advance(1, connBlob) from the visitor's own wallet. Nothing else, ever. */
async function wake() {
  if (!window.ethereum) {
    setStatus("c04.no_wallet", null, "err");
    return;
  }
  const go = el("wake-go");
  if (go) go.disabled = true;
  try {
    setStatus("c04.wake_fetching", null, "");
    const blob = await ensureBlob();
    setStatus("c04.waiting", null, "");
    provider = provider || new BrowserProvider(window.ethereum);
    const granted = await provider.send("eth_requestAccounts", []);
    if (!Array.isArray(granted) || !granted.length) throw new Error(t("c04.no_account"));
    const signer = await provider.getSigner(granted[0]);
    const who = await signer.getAddress();
    if (getAddress(who) !== getAddress(granted[0])) throw new Error(t("c04.account_changed"));
    const net = await provider.getNetwork();
    if (BigInt(net.chainId) !== 56n) throw new Error(t("c04.wrong_chain"));
    const c = new Contract(BRAIN, WAKE_ABI, signer);
    const before = await c.tick();
    // one step, never more: clamp the headroom under the per-tx ceiling BSC will accept
    let limit;
    try {
      limit = ((await c.advance.estimateGas(1n, blob)) * 13n) / 10n;
    } catch {
      limit = 14_000_000n;
    }
    if (limit > TX_GAS_CAP) limit = TX_GAS_CAP;
    const tx = await c.advance(1n, blob, { gasLimit: limit });
    setStatus("c04.tx_sent", { h: tx.hash.slice(0, 18) }, "");
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) {
      setStatus("c04.reverted", null, "err");
      return;
    }
    const after = await c.tick();
    // the honest payoff: the animal really moved one step, or we say it did not
    if (after > before) setStatus("c04.wake_step", { from: before.toString(), to: after.toString() }, "ok");
    else setStatus("c04.wake_moved_none", { n: after.toString() }, "err");
  } catch (e) {
    const m = (e && (e.shortMessage || e.message)) || String(e);
    setStatus("c04.not_sent", { m }, "err");
  } finally {
    if (go) go.disabled = false;
  }
}

export function init() {
  const b = el("wake-go");
  if (b) b.addEventListener("click", wake);
  // prewarm + verify the genome the moment the UI is armed, so a mismatch surfaces before
  // the visitor ever reaches for their wallet rather than after a failed click
  ensureBlob().catch(() => {});
  onLangChange(() => repaintStatus());
}
