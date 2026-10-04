/**
 * Perception Lab: sound -- maps neural spikes to audible clicks via Web Audio.
 *
 * This module is entirely read-only: it fetches the same cached snapshot the worker
 * already provides, detects tick changes, and synthesizes one short oscillator burst
 * per neuron that fired. Pitch is proportional to membrane voltage. No data leaves
 * the browser. No wallet, no transaction.
 */
import { t, label, take } from "./i18n.js";

const WORKER = "https://api.bscworm.com";
const POLL_MS = 10000; // poll the cached snapshot every 10 s (zero extra RPC on the gateway)

let ctx = null;
let polling = null;
let lastTick = 0;
let active = false;

export function start() {
  if (active) return;
  active = true;
  // AudioContext requires user gesture on most browsers; this is called from a click
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  const status = document.getElementById("sound-status");
  if (status) label(take(status), "c09.audio_on");
  poll();
  polling = setInterval(poll, POLL_MS);
}

export function stop() {
  active = false;
  if (polling) { clearInterval(polling); polling = null; }
  const status = document.getElementById("sound-status");
  if (status) label(take(status), "c09.audio_off");
}

async function poll() {
  if (!active) return;
  try {
    const snap = await fetch(`${WORKER}/api/snapshot`).then((r) => r.json());
    if (!snap || snap.tick === undefined) return;
    if (snap.tick > lastTick && lastTick > 0) {
      // tick advanced: play spike sounds
      playSpikes(snap);
    }
    lastTick = snap.tick;
    // update canvas art if available
    const artMod = window.__wormArt;
    if (artMod && snap.stateHash) artMod.render(snap.stateHash, snap);
  } catch { /* silent: a failed poll is just a missed beat */ }
}

function playSpikes(snap) {
  if (!ctx || ctx.state !== "running") return;
  const spikes = snap.spikes || [];
  const V = snap.V || [];
  // find neurons that spiked most recently (spikeCount > 0, pick hottest 20)
  const fired = [];
  for (let i = 0; i < Math.min(302, spikes.length); i++) {
    if (spikes[i] > 0) fired.push({ idx: i, voltage: V[i] || 0 });
  }
  // sort by voltage magnitude, take top 20 for audio
  fired.sort((a, b) => Math.abs(b.voltage) - Math.abs(a.voltage));
  const top = fired.slice(0, 20);
  const now = ctx.currentTime;
  for (let i = 0; i < top.length; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    // map Q20 voltage [-2*SCALE, +2*SCALE] to frequency [200, 1200] Hz
    const norm = Math.max(-1, Math.min(1, top[i].voltage / 2097152)); // 2*SCALE = 2*2^20
    const freq = 200 + (norm + 1) * 500; // 200-1200 Hz
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.value = 0.04; // gentle
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08 + i * 0.02);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.015);
    osc.stop(now + 0.08 + i * 0.015);
  }
}

export function wireSound() {
  const btnStart = document.getElementById("sound-enable");
  const btnStop = document.getElementById("sound-stop");
  if (btnStart) {
    btnStart.addEventListener("click", () => {
      start();
      btnStart.disabled = true;
      if (btnStop) btnStop.disabled = false;
    }, { once: false });
  }
  if (btnStop) {
    btnStop.addEventListener("click", () => {
      stop();
      btnStop.disabled = true;
      if (btnStart) btnStart.disabled = false;
    }, { once: false });
  }
}
