/**
 * Journal & Wakers leaderboard -- a read-only card that fetches narrative entries
 * and the advance-sender ranking from the project's own Worker. No wallet, no
 * signing, no transaction. Only GET against api.bscworm.com.
 */
import { t, label, take } from "./i18n.js";

const WORKER = "https://api.bscworm.com";

let loaded = false;

export function init() {
  if (loaded) return;
  loaded = true;
  refresh();
}

async function refresh() {
  const status = document.getElementById("journal-status");
  if (status) label(take(status), "c08.loading");
  try {
    const [journalRes, wakersRes] = await Promise.all([
      fetch(`${WORKER}/api/journal?limit=30`).then((r) => r.json()),
      fetch(`${WORKER}/api/wakers`).then((r) => r.json()),
    ]);
    renderJournal(journalRes);
    renderWakers(wakersRes);
    if (status) label(take(status), "c08.loaded", { n: journalRes.count || 0, w: wakersRes.uniqueWakers || 0 });
  } catch (e) {
    if (status) label(take(status), "c08.fail", { m: (e && e.message) || e });
  }
}

function renderJournal(data) {
  const feed = document.getElementById("journal-feed");
  if (!feed) return;
  feed.innerHTML = "";
  const entries = data.entries || [];
  if (!entries.length) {
    const d = document.createElement("div");
    d.className = "journal-entry";
    d.textContent = t("c08.empty");
    feed.appendChild(d);
    return;
  }
  for (const e of entries) {
    const div = document.createElement("div");
    div.className = "journal-entry";
    const when = e.at ? new Date(e.at * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
    div.innerHTML =
      `<span class="entry-time">${esc(when)}</span>` +
      `<span class="tick-badge">#${e.tick}</span>` +
      esc(e.text || "");
    feed.appendChild(div);
  }
}

function renderWakers(data) {
  const table = document.getElementById("wakers-table");
  if (!table) return;
  table.innerHTML = "";
  const wakers = data.wakers || [];
  if (!wakers.length) {
    const d = document.createElement("div");
    d.className = "waker-row";
    d.textContent = t("c08.no_wakers");
    table.appendChild(d);
    return;
  }
  wakers.slice(0, 20).forEach((w, i) => {
    const row = document.createElement("div");
    row.className = "waker-row";
    const short = w.addr.length > 14 ? w.addr.slice(0, 8) + "\u2026" + w.addr.slice(-4) : w.addr;
    row.innerHTML =
      `<span class="rank">${i + 1}</span>` +
      `<span class="addr" title="${esc(w.addr)}">${esc(short)}</span>` +
      `<span class="steps">${w.steps}</span>`;
    table.appendChild(row);
  });
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// wire up the load button
export function wireJournal() {
  const btn = document.getElementById("journal-load");
  const refreshBtn = document.getElementById("journal-refresh");
  if (btn) {
    btn.addEventListener("click", () => {
      init();
      btn.disabled = true;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.addEventListener("click", refresh);
      }
    }, { once: true });
  }
}
