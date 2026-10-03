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
import { t, label, take, onLangChange } from "./i18n.js";

export const LEDGER = "0x16a4d26C90fE7613f22Da41150E4847e1fE47495";
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

function say(key, params, cls) {
  const s = el("wall-status");
  if (!s) return;
  label(take(s), key, params);
  s.className = "v " + (cls || "");
}

/** The contract's own text policy, mirrored so a bad string never costs gas. It
 *  answers with a dictionary key and its holes, never with a sentence: the message is
 *  shown on screen and thrown as an error, and both paths render it in the language
 *  the visitor is reading. */
export function textProblem(text, max) {
  if (!text.length) return { key: "c05f.empty_text" };
  if (text.length > max) return { key: "c05f.long_text", params: { n: text.length, max } };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      return {
        key: "c05f.bad_char",
        params: { c: text[i] === " " ? t("c05f.char_space") : text[i], i: i + 1 },
      };
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
  label(el("wall-wallet"), "c05f.holds", {
    addr: shortAddr(account), n: Number(formatEther(balance)).toFixed(4), sym: symbol,
  });
  label(el("wall-allow"), "c05f.allow_line", {
    n: Number(formatEther(allowance)).toFixed(4), sym: symbol, m: Number(formatEther(need)).toFixed(4),
  });
  const nominalEl = el("wall-nominal");
  if (nominalEl && !nominalEl.value) nominalEl.value = formatUnits(need, Number(decimals));
  const btn = el("wall-send");
  if (btn) btn.disabled = balance < need;
  if (btn && balance < need) say("c05f.low_balance", {
    n: formatEther(balance), sym: symbol, m: formatEther(need),
  }, "err");
}

async function connect() {
  if (!window.ethereum) { say("c05f.no_wallet", null, "err"); return false; }
  provider = provider || new BrowserProvider(window.ethereum);
  const net = await provider.getNetwork();
  if (BigInt(net.chainId) !== CHAIN_ID) {
    say("c05f.wrong_chain", { net: net.chainId }, "err");
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
    if (!/^(0|[1-9][0-9]*)$/.test(slotRaw)) throw new Error(t("c05f.err_slot"));
    const slot = BigInt(slotRaw);
    const nominal = parseUnits(nominalRaw || "0", 18);

    const [price, currentSlot, maxLen, entry] = await Promise.all([
      ledger.price(), ledger.currentSlot(), ledger.MAX_TEXT_LEN(), ledger.entries(slot),
    ]);
    const need = minSend(price);

    // pre-flight everything the contract will also enforce, so a mistake costs a
    // keystroke here instead of a fee on mainnet
    const problem = textProblem(text, Number(maxLen));
    if (problem) throw new Error(t(problem.key, problem.params));
    if (slot > currentSlot) throw new Error(t("c05f.err_not_lived", { slot, newest: currentSlot }));
    if (entry.text) throw new Error(t("c05f.err_taken", { slot, text: entry.text }));
    if (nominal < need) throw new Error(t("c05f.err_nominal", { need: formatUnits(need, 18), got: formatUnits(nominal, 18) }));

    const allowance = await token.allowance(account, LEDGER);
    if (allowance < nominal) {
      say("c05f.step1", { n: formatUnits(nominal, 18) }, "");
      const a = await token.approve(LEDGER, nominal);
      await a.wait();
      say("c05f.step2", null, "");
    } else {
      say("c05f.allow_covers", null, "");
    }

    const tx = await ledger.inscribe(slot, text, nominal);
    say("c05f.sent", { h: tx.hash.slice(0, 18) }, "");
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) throw new Error(t("c05f.reverted"));
    const fee = rcpt.gasUsed * (rcpt.gasPrice ?? (await provider.getFeeData()).gasPrice ?? 0n);
    say("c05f.engraved", {
      slot, block: rcpt.blockNumber, n: formatUnits(nominal, 18), gas: Number(formatEther(fee)).toFixed(6),
    }, "ok");
    if (ctx && ctx.refresh) await ctx.refresh();
  } catch (e) {
    const m = (e && (e.shortMessage || e.reason || e.message)) || String(e);
    say("c05f.not_engraved", { m }, "err");
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
  // compared case-insensitively so a checksummed and a lowercase spelling of the
  // same contract cannot disagree: this module spends real tokens, so it would
  // rather refuse to appear than write to a ledger it did not pick itself
  if (String(where.ledger).toLowerCase() !== LEDGER.toLowerCase()) {
    throw new Error(t("c05f.pin_ledger"));
  }
  if (String(where.token).toLowerCase() !== TOKEN.toLowerCase()) {
    throw new Error(t("c05f.pin_token"));
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
    textEl.addEventListener("input", paintPreview);
  }
  // a language switch re-answers the text check: the rule is the contract's own and
  // never moves, only the wording it is told back in changes
  onLangChange(paintPreview);

  function paintPreview() {
    if (!preview || !textEl) return;
    const p = textProblem(textEl.value, maxLen);
    if (p) label(take(preview), p.key, p.params);
    else label(take(preview), "c05f.preview", { len: textEl.value.length, max: maxLen, text: textEl.value });
    preview.className = p ? "note err" : "note";
  }

  const connectBtn = el("wall-connect");
  if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      connectBtn.disabled = true;
      try {
        if (await connect()) {
          // an address is not prose: the module takes the node over so a language
          // switch leaves the connected account on the button instead of "ATTACH WALLET"
          take(connectBtn);
          connectBtn.textContent = shortAddr(account);
          await readWalletState();
          say("c05f.attached", null, "ok");
        }
      } catch (e) {
        say("c05f.wallet_refused", { m: (e && (e.shortMessage || e.message)) || e }, "err");
      } finally {
        if (connectBtn) connectBtn.disabled = false;
      }
    });
  }
  const btn = el("wall-send");
  if (btn) btn.addEventListener("click", send);
  say("c05f.armed_idle", null, "ok");
}
