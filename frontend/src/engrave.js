/**
 * Engraving — the wall's write path, and the second sanctioned place in this
 * frontend where a transaction can leave the page. It is loaded by dynamic import
 * only after an explicit click on "ENABLE ENGRAVING", and the smoke test fences it
 * the way it fences poke.js.
 *
 * Hard rules, all of them asserted by src/../test/smoke.mjs:
 *   - the only two contract addresses this module can name are the pinned
 *     WormLedger and the pinned WormBrain token; the brain itself is never
 *     referenced, so nothing here can move or stimulate the animal;
 *   - exactly two state-changing encodings exist: ERC20.approve(ledger, amount)
 *     and WormLedger.inscribe(slot, text, nominal). There is no generic tx sender,
 *     no `to` the caller chooses, no value, no data passthrough;
 *   - the key never enters this page. Signing happens inside the visitor's own
 *     wallet extension; we only relay what comes back;
 *   - everything is refused client-side before it is sent, because a reverted
 *     inscription still costs the sender gas: the text policy (1..64 printable
 *     ASCII), the slot window (already lived, not yet taken) and the tax-aware
 *     nominal are all checked here AND enforced by the contract.
 *
 * Why the nominal is not simply `price`: the token takes 3% on transfer, and the
 * ledger prices an inscription on what actually ARRIVES. Sending exactly 1.0 would
 * deliver 0.97 and revert. So the form sends price/0.97 plus a small margin, and
 * the ledger burns whatever arrives -- an over-send is extra burn, never a fee to
 * anybody.
 */
import { BrowserProvider, Contract, formatEther, formatUnits, parseUnits } from "ethers";

export const LEDGER = "0xb305bDcf97C26B1312E3C3b3158BAAc7cD5f6966";
export const TOKEN = "0xA18f90eF3d4cc543141986c80442F87a2d2a7777";

const LEDGER_ABI = [
  "function price() view returns (uint256)",
  "function currentSlot() view returns (uint256)",
  "function ticksPerSlot() view returns (uint256)",
  "function MAX_TEXT_LEN() view returns (uint256)",
  "function entries(uint256 slot) view returns (address author, uint64 blockAt, uint256 tickAt, uint256 nominal, uint256 burned, string text)",
  "function inscribe(uint256 slot, string text, uint256 nominal) external",
];
const TOKEN_ABI = [
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const CHAIN_ID = 56n;
const ARRIVE_BPS = 9700n;   // a 3% transfer tax leaves 97% of a nominal arriving
const MARGIN_BPS = 10200n;  // and the form asks for 2% above the bare minimum

const el = (id) => document.getElementById(id);
const setText = (id, v) => { const n = el(id); if (n) n.textContent = v; };
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

let ctx = null;
let provider = null;
let account = null;

function say(text, cls) {
  const s = el("wall-status");
  if (!s) return;
  s.textContent = text;
  s.className = "v " + (cls || "");
}

/** The contract's own text policy, mirrored so a bad string never costs gas. */
export function textProblem(text, max) {
  if (!text.length) return "write something — an empty slot is not an inscription";
  if (text.length > max) return `${text.length} characters, the ceiling is ${max}`;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      return `character "${text[i] === " " ? "space" : text[i]}" at position ${i + 1} is not printable ASCII — the wall refuses markup, control bytes and non-ASCII, and so do I`;
    }
  }
  return null;
}

/** the least the form should send so that `price` still arrives after tax, plus margin */
const minSend = (price) => (price * MARGIN_BPS + ARRIVE_BPS - 1n) / ARRIVE_BPS;

/** Balance and allowance of the connected account, read through the wallet's own
 *  provider. Pure reads: nothing here can spend. */
async function readWalletState() {
  const signer = await provider.getSigner();
  const token = new Contract(TOKEN, TOKEN_ABI, signer);
  const ledger = new Contract(LEDGER, LEDGER_ABI, signer);
  const [allowance, balance, symbol, decimals, price] = await Promise.all([
    token.allowance(account, LEDGER), token.balanceOf(account), token.symbol(), token.decimals(), ledger.price(),
  ]);
  const need = minSend(price);
  setText("wall-wallet", `${shortAddr(account)} holds ${Number(formatEther(balance)).toFixed(4)} ${symbol}`);
  setText("wall-allow", `${Number(formatEther(allowance)).toFixed(4)} ${symbol} approved · this form sends ${Number(formatEther(need)).toFixed(4)} for one slot`);
  const nominalEl = el("wall-nominal");
  if (nominalEl && !nominalEl.value) nominalEl.value = formatUnits(need, Number(decimals));
  const btn = el("wall-send");
  if (btn) btn.disabled = balance < need;
  if (btn && balance < need) say(`your balance is ${formatEther(balance)} ${symbol}; an inscription needs at least ${formatEther(need)} to survive the transfer tax`, "err");
}

async function connect() {
  if (!window.ethereum) { say("no wallet detected — an EIP-1193 browser wallet is required to engrave", "err"); return false; }
  provider = provider || new BrowserProvider(window.ethereum);
  const net = await provider.getNetwork();
  if (BigInt(net.chainId) !== CHAIN_ID) {
    say(`your wallet is on chain ${net.chainId}; the worm lives on BNB Chain mainnet (56) — switch network and try again`, "err");
    return false;
  }
  const signer = await provider.getSigner();
  account = await signer.getAddress();
  return true;
}

async function send() {
  const btn = el("wall-send");
  if (btn) btn.disabled = true;
  try {
    if (!(await connect())) return;
    await readWalletState();
    const signer = await provider.getSigner();
    const ledger = new Contract(LEDGER, LEDGER_ABI, signer);
    const token = new Contract(TOKEN, TOKEN_ABI, signer);

    const slotRaw = ((el("wall-slot") && el("wall-slot").value) || "").trim();
    const text = (el("wall-text") && el("wall-text").value) || "";
    const nominalRaw = ((el("wall-nominal") && el("wall-nominal").value) || "0").trim();
    if (!/^(0|[1-9][0-9]*)$/.test(slotRaw)) throw new Error("slot must be a whole number");
    const slot = BigInt(slotRaw);
    const nominal = parseUnits(nominalRaw || "0", 18);

    const [price, currentSlot, maxLen, entry] = await Promise.all([
      ledger.price(), ledger.currentSlot(), ledger.MAX_TEXT_LEN(), ledger.entries(slot),
    ]);
    const need = minSend(price);

    // pre-flight everything the contract will also enforce, so a mistake costs a
    // keystroke here instead of a fee on mainnet
    const problem = textProblem(text, Number(maxLen));
    if (problem) throw new Error(problem);
    if (slot > currentSlot) throw new Error(`slot ${slot} has not been lived yet — the newest one is ${currentSlot}`);
    if (entry.text) throw new Error(`slot ${slot} is already engraved ("${entry.text}") — the wall has no overwrite`);
    if (nominal < need) throw new Error(`this form asks for at least ${formatUnits(need, 18)} (the price divided by 0.97, plus a 2% margin) — sending ${formatUnits(nominal, 18)} risks delivering under the price once the tax is taken`);

    const allowance = await token.allowance(account, LEDGER);
    if (allowance < nominal) {
      say(`step 1 of 2: approving ${formatUnits(nominal, 18)} for the ledger to pull — confirm in your wallet`, "");
      const a = await token.approve(LEDGER, nominal);
      await a.wait();
      say("approval landed · step 2 of 2: engraving — confirm in your wallet", "");
    } else {
      say("allowance already covers this — engraving, confirm in your wallet", "");
    }

    const tx = await ledger.inscribe(slot, text, nominal);
    say(`sent ${tx.hash.slice(0, 18)}… waiting for the block`, "");
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) throw new Error("the transaction reverted — nothing was engraved");
    const fee = rcpt.gasUsed * (rcpt.gasPrice ?? (await provider.getFeeData()).gasPrice ?? 0n);
    say(
      `engraved into slot ${slot} at block ${rcpt.blockNumber} · ${formatUnits(nominal, 18)} sent and what arrived was burned · ` +
      `you paid ${Number(formatEther(fee)).toFixed(6)} BNB gas · this can never be edited or removed`,
      "ok",
    );
    if (ctx && ctx.refresh) await ctx.refresh();
  } catch (e) {
    const m = (e && (e.shortMessage || e.reason || e.message)) || String(e);
    say("not engraved: " + m, "err");
  } finally {
    const again = el("wall-send");
    if (again) again.disabled = false;
  }
}

/**
 * Draw the form. This function performs no read and no write of its own: the
 * numbers it shows come from the facts wall.js already read, so arming the
 * engraver cannot spend or even transact anything until a button is pressed.
 */
export async function mount(where) {
  ctx = where;
  if (where.ledger !== LEDGER || where.token !== TOKEN) {
    throw new Error("the wall handed this module an address it does not pin");
  }
  const f = typeof where.facts === "function" ? where.facts() : null;
  const slotEl = el("wall-slot"), textEl = el("wall-text"), nominalEl = el("wall-nominal"), preview = el("wall-preview");
  const maxLen = f ? Number(f.maxLen) : 64;
  if (slotEl && f) {
    slotEl.value = String(f.currentSlot);
    slotEl.min = "0";
    slotEl.max = String(f.currentSlot);
  }
  if (nominalEl && f) nominalEl.value = formatUnits(minSend(f.price), f.decimals);
  if (textEl) {
    textEl.maxLength = maxLen;
    textEl.addEventListener("input", () => {
      const p = textProblem(textEl.value, maxLen);
      if (preview) preview.textContent = p || `${textEl.value.length}/${maxLen} · "${textEl.value}"`;
      if (preview) preview.className = p ? "note err" : "note";
    });
  }
  const connectBtn = el("wall-connect");
  if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      connectBtn.disabled = true;
      try {
        if (await connect()) {
          connectBtn.textContent = shortAddr(account);
          await readWalletState();
          say("wallet attached — the two buttons below still need your confirmation inside the wallet", "ok");
        }
      } catch (e) {
        say("wallet refused: " + ((e && (e.shortMessage || e.message)) || e), "err");
      } finally {
        if (connectBtn) connectBtn.disabled = false;
      }
    });
  }
  const btn = el("wall-send");
  if (btn) btn.addEventListener("click", send);
  say("engraving armed — nothing has been sent; the form only acts after you confirm in your own wallet", "ok");
}
