/**
 * Opt-in "poke the worm" module — the ONE place in this frontend that can send
 * a transaction, and it can only send one kind: SenseAdapter.inject(int256),
 * paid for and signed by the visitor's own wallet.
 *
 * Rules hard-wired here (asserted by the smoke test):
 *   - target is pinned to the deployed SenseAdapter; the brain, the readout and
 *     every other address are refused;
 *   - only the single `inject` entry point is ever encoded: the brain's own
 *     state-changing functions are never referenced from this module;
 *   - the key never passes through this page: signing happens inside the user's
 *     wallet extension, we only relay the result;
 *   - the worm is passive: a poke queues current into its chemoreceptors and
 *     takes effect on the NEXT advance by the keeper node — the UI says so.
 *
 * Everything else on the page stays read-only; this module is dynamically
 * imported only after the visitor explicitly enables it.
 */
import { BrowserProvider, Contract, formatEther } from "ethers";

export const ADAPTER = "0xbe0C5117f740a9333614D806Bd50C3907186C6fD";
// ampCap on the deployed adapter is 2097152 (2.0 in Q20); a full-scale poke
// clamps at exactly that, positive routes to ASEL, negative to ASER.
export const FULL_POKE = 2097152n;

const ADAPTER_ABI = [
  "function inject(int256 signedIntensity) external",
  "function ampCap() view returns (int256)",
  "event Injected(address indexed from, int256 amp, uint256 idx)",
];
// publicnode answers eth_getLogs for recent ranges; dataseeds throttle them.
const LOG_RPCS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed1.bnbchain.org",
];
const INJECTED_TOPIC = "0x2942585dbf804ae7e959e04576a8b411b030a9f8f35af47a6a7feb063bfeb4aa";
const FEED_MS = 30000;
const LOG_RANGE = 9000; // blocks per scan window, inside publicnode's log cap

let provider = null;
let feedTimer = null;

const el = (id) => document.getElementById(id);

function setStatus(text, cls) {
  const s = el("poke-status");
  if (!s) return;
  s.textContent = text;
  s.className = "v " + (cls || "");
}

/** One fetch-based JSON-RPC helper for the read-only log feed (no wallet). */
async function rpc(method, params) {
  let lastErr = null;
  for (const url of LOG_RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no log endpoint answered");
}

function shortAddr(a) {
  return a.slice(0, 6) + "…" + a.slice(-4);
}

/** Render the most recent Injected events — public facts straight off the chain. */
async function refreshFeed() {
  const list = el("poke-feed");
  if (!list) return;
  try {
    const head = BigInt(await rpc("eth_blockNumber", []));
    const from = "0x" + (head > BigInt(LOG_RANGE) ? head - BigInt(LOG_RANGE) : 0n).toString(16);
    const rows = await rpc("eth_getLogs", [{
      address: ADAPTER, topics: [INJECTED_TOPIC],
      fromBlock: from, toBlock: "0x" + head.toString(16),
    }]);
    const iface = new Contract(ADAPTER, ADAPTER_ABI).interface;
    const evs = rows.slice(-12).reverse()
      .map((lg) => ({ log: lg, parsed: iface.parseLog({ topics: lg.topics, data: lg.data }) }))
      .filter((x) => x.parsed);
    if (!evs.length) {
      list.innerHTML = '<div class="note">no pokes on record in the recent window — be the first, or let the keeper lead.</div>';
      return;
    }
    const blocks = [...new Set(evs.map((x) => Number(BigInt(x.log.blockNumber))))];
    const ts = {};
    await Promise.all(blocks.map(async (b) => {
      try { ts[b] = Number(BigInt((await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false])).timestamp)); }
      catch { ts[b] = 0; }
    }));
    list.innerHTML = evs.map((x) => {
      const a = x.parsed.args;
      const neuron = BigInt(a.idx) === 39n ? "ASEL" : BigInt(a.idx) === 40n ? "ASER" : "idx " + a.idx;
      const amp = Number(BigInt(a.amp)) / 1048576;
      const t = ts[Number(BigInt(x.log.blockNumber))];
      const ago = t ? Math.max(0, Math.round((Date.now() / 1000 - t) / 60)) + "m ago" : "";
      return `<div class="row"><span class="k">${shortAddr(a.from)}</span>` +
        `<span class="v">${amp >= 0 ? "+" : ""}${amp.toFixed(2)} → ${neuron} · <span class="note">${ago}</span></span></div>`;
    }).join("");
  } catch (e) {
    list.innerHTML = `<div class="note">poke feed unavailable: ${(e && e.message) || e}</div>`;
  }
}

/** Send inject(int256) from the visitor's own wallet. Nothing else, ever. */
async function poke(intensity) {
  if (!window.ethereum) {
    setStatus("no wallet detected — install an EIP-1193 browser wallet first", "err");
    return;
  }
  try {
    setStatus("waiting for your wallet…", "");
    provider = provider || new BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const who = await signer.getAddress();
    if (who.toLowerCase() !== (await provider.listAccounts())[0]?.toLowerCase()) {
      throw new Error("account changed, try again");
    }
    const c = new Contract(ADAPTER, ADAPTER_ABI, signer);
    // chain guard: refuse to sign blind on the wrong network
    const net = await provider.getNetwork();
    if (BigInt(net.chainId) !== 56n) throw new Error("connect to BNB Chain mainnet (chainId 56)");
    const tx = await c.inject(intensity);
    setStatus("tx sent: " + tx.hash.slice(0, 18) + "… waiting for receipt", "");
    const rcpt = await tx.wait();
    if (rcpt.status === 1) {
      const fee = rcpt.gasUsed * (rcpt.gasPrice ?? await provider.getFeeData().then((f) => f.gasPrice));
      setStatus(
        `poked ${intensity >= 0n ? "ASEL (food-like)" : "ASER (repellent-like)"} · ` +
        `you paid ${Number(formatEther(fee ?? 0n)).toFixed(6)} BNB gas · takes effect on the next advance`,
        "ok",
      );
    } else {
      setStatus("poke tx reverted — nothing was written", "err");
    }
    refreshFeed();
  } catch (e) {
    const m = (e && (e.shortMessage || e.message)) || String(e);
    setStatus("not sent: " + m, "err");
  }
}

export function init() {
  const food = el("poke-food"), avert = el("poke-avert");
  if (food) food.addEventListener("click", () => poke(FULL_POKE));
  if (avert) avert.addEventListener("click", () => poke(-FULL_POKE));
  refreshFeed();
  feedTimer = feedTimer || setInterval(refreshFeed, FEED_MS);
}
