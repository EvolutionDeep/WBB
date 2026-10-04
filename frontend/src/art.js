/**
 * Perception Lab: generative art -- draws a unique pattern seeded by the brain's
 * stateHash. Each tick produces a one-of-a-kind visual fingerprint of the entire
 * neural state. Purely browser-side canvas; no network, no wallet.
 */

let canvas = null;
let g = null;
let lastHash = "";

export function init() {
  canvas = document.getElementById("art-canvas");
  if (!canvas) return;
  g = canvas.getContext("2d");
  drawEmpty();
}

function drawEmpty() {
  if (!g) return;
  g.fillStyle = "#020810";
  g.fillRect(0, 0, 400, 400);
  g.fillStyle = "rgba(53,224,255,0.3)";
  g.font = "12px monospace";
  g.textAlign = "center";
  g.fillText("waiting for stateHash\u2026", 200, 200);
}

/**
 * Render a generative pattern from a stateHash. Called by sound.js when snapshot data arrives.
 * Uses a simple deterministic PRNG seeded from the hash bytes.
 */
export function render(stateHash, snap) {
  if (!g || !stateHash) return;
  if (stateHash === lastHash) return;
  lastHash = stateHash;

  const seed = hashToSeed(stateHash);
  const rng = mulberry32(seed);

  // background gradient influenced by body speed
  const speed = snap && snap.speed ? snap.speed : 0;
  const hue = (180 + speed * 0.02) % 360;
  const grad = g.createRadialGradient(200, 200, 20, 200, 200, 220);
  grad.addColorStop(0, `hsl(${hue}, 60%, 4%)`);
  grad.addColorStop(1, `hsl(${(hue + 40) % 360}, 40%, 2%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 400, 400);

  // draw circles (neurons that fired)
  const spikes = snap && snap.spikes ? snap.spikes : [];
  const firedCount = spikes.filter((s) => s > 0).length;
  const numCircles = Math.min(60, Math.max(8, firedCount));
  for (let i = 0; i < numCircles; i++) {
    const x = rng() * 360 + 20;
    const y = rng() * 360 + 20;
    const r = rng() * 30 + 4;
    const alpha = rng() * 0.4 + 0.1;
    const hue2 = (hue + rng() * 120) % 360;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = `hsla(${hue2}, 70%, 55%, ${alpha})`;
    g.fill();
    // ring
    g.beginPath();
    g.arc(x, y, r + 2, 0, Math.PI * 2);
    g.strokeStyle = `hsla(${hue2}, 80%, 65%, ${alpha * 0.6})`;
    g.lineWidth = 0.5;
    g.stroke();
  }

  // connecting lines (synapses)
  const numLines = Math.min(40, numCircles);
  g.lineWidth = 0.3;
  for (let i = 0; i < numLines; i++) {
    const x1 = rng() * 400;
    const y1 = rng() * 400;
    const x2 = rng() * 400;
    const y2 = rng() * 400;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.strokeStyle = `hsla(${hue}, 50%, 60%, ${rng() * 0.15 + 0.03})`;
    g.stroke();
  }

  // center label
  g.fillStyle = "rgba(220,250,255,0.6)";
  g.font = "10px monospace";
  g.textAlign = "center";
  const tickLabel = snap && snap.tick ? `tick ${snap.tick}` : "";
  g.fillText(tickLabel, 200, 392);
}

function hashToSeed(hash) {
  // take first 8 hex chars of the 0x-prefixed hash -> 32-bit integer
  const h = hash.replace(/^0x/, "").slice(0, 8);
  return parseInt(h, 16) || 42;
}

// Mulberry32: fast deterministic PRNG
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
