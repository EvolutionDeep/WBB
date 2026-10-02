/**
 * Time-lapse player for the worm's real on-chain past.
 *
 * Every frame here was captured by scripts/gen_replay_data.mjs as a read of
 * WormBrainV2 state replayed AT the block of that heartbeat:
 * 302 membrane voltages plus the body pose (px,py,hx,hy). Nothing is
 * simulated, interpolated or faked — this is a recording, like a video
 * of an animal that already lived those moments on chain.
 *
 * The player is a static asset: it opens no RPC connection at all and
 * ships no signing or state-changing capability of any kind. It is
 * dynamically imported only when the visitor presses PLAY, so the
 * default page never even downloads the 0.4 MB recording.
 */

const DATA_URL = "/data/replay.json";
const N = 302;
const W = 900;
const H = 320;

// signed int8 (two's complement hex byte)
function s8(hex2) {
  const v = parseInt(hex2, 16);
  return v < 128 ? v : v - 256;
}
// signed int16 (two's complement hex nibble pair)
function s16(hex4) {
  const v = parseInt(hex4, 16);
  return v < 32768 ? v : v - 65536;
}

function decodeV(frame) {
  const out = new Int16Array(N);
  for (let i = 0; i < N; i++) out[i] = s8(frame.v.substr(i * 2, 2));
  return out;
}
function decodePose(frame) {
  const q = [0, 1, 2, 3].map((k) => s16(frame.pose.substr(k * 4, 4)));
  // Q10 body units -> pixels; the worm spans a few units around the origin
  const scale = 26 / 1024;
  const px = q[0] * scale, py = q[1] * scale;
  const hx = q[2] * scale, hy = q[3] * scale;
  const hn = Math.hypot(hx, hy) || 1;
  return { px, py, dx: hx / hn, dy: hy / hn };
}

function el(id) { return document.getElementById(id); }

export async function start(container) {
  const meta = { note: el("replay-status") };
  const setNote = (t) => { if (meta.note) meta.note.textContent = t; };
  setNote("loading the recording…");

  const raw = await fetch(DATA_URL);
  if (!raw.ok) throw new Error("replay.json not available (" + raw.status + ")");
  const data = await raw.json();
  const frames = data.frames;
  if (!Array.isArray(frames) || !frames.length) throw new Error("empty recording");

  // --- controls -------------------------------------------------------------
  const bar = el("replay-bar");
  if (bar) bar.innerHTML = `
    <button id="replay-play" type="button">▶ PLAY</button>
    <button id="replay-step" type="button">STEP +1</button>
    <label class="note">speed <input id="replay-speed" type="range" min="1" max="30" value="8"> <span id="replay-fps" class="v mono">8/s</span></label>
    <input id="replay-scrub" type="range" min="0" max="${frames.length - 1}" value="0" style="flex:1;min-width:120px">
  `;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  canvas.style.width = "100%"; canvas.style.height = "auto";
  container.innerHTML = "";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // neuron grid: 302 ids in 16 columns, ordered like the connectome table
  const COLS = 16;
  const ROWS = Math.ceil(N / COLS);
  const cell = Math.min((W - 240) / COLS, (H - 20) / ROWS);
  const gridX0 = 16, gridY0 = 12;

  let idx = 0;
  let playing = false;
  let fps = 8;
  let raf = null;
  let lastTs = 0;

  function voltageColor(q) {
    // q is |V|/V_THRESH in [-1..1] after the display band; gamma 2 like the
    // 3D viewer: depolarisation warm, hyperpolarisation cool
    const a = Math.min(1, Math.abs(q));
    const g = a * a;
    return q >= 0
      ? `rgba(255,${Math.round(140 - 90 * g)},60,${0.12 + 0.88 * g})`
      : `rgba(60,120,255,${0.10 + 0.80 * g})`;
  }

  function draw() {
    const f = frames[idx];
    const v = decodeV(f);
    ctx.fillStyle = "#0a0f16";
    ctx.fillRect(0, 0, W, H);

    // neuron voltage matrix
    for (let i = 0; i < N; i++) {
      const q = v[i] / 127;
      const cx = gridX0 + (i % COLS) * cell + cell / 2;
      const cy = gridY0 + Math.floor(i / COLS) * cell + cell / 2;
      ctx.fillStyle = voltageColor(q);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1.2, (cell / 2 - 1) * (0.35 + 0.65 * Math.abs(q * q))), 0, 6.2832);
      ctx.fill();
    }

    // body pose: the recorded head/tail orientation, drawn as a simple
    // undulating silhouette (display only — pose is real, the curve is a
    // schematic of the four recorded pose scalars, nothing more)
    const p = decodePose(f);
    const bx = W - 190 + p.px * 3.6, by = H / 2 + p.py * 3.6;
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(Math.atan2(p.dy, p.dx));
    ctx.strokeStyle = "rgba(140,220,180,0.9)";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    const wob = (f.t % 7) - 3; // deterministic per-tick offset, not random
    for (let s = -60; s <= 60; s += 6) {
      const yy = Math.sin((s / 60) * 3.1 + wob) * 4;
      if (s === -60) ctx.moveTo(s, yy); else ctx.lineTo(s, yy);
    }
    ctx.stroke();
    ctx.restore();

    // HUD: exactly which on-chain frame is on screen
    ctx.fillStyle = "#8fa3b8";
    ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
    ctx.fillText(`tick ${f.t} · block ${f.b} · ${f.ts}`, 16, H - 8);
    ctx.fillText(`${f.fired} neurons fired this step · ${f.spikes} spikes lifetime`, W / 2 + 40, H - 8);
    ctx.fillText(`frame ${idx + 1}/${frames.length}`, W - 120, H - 8);

    const scrub = el("replay-scrub");
    if (scrub) scrub.value = String(idx);
  }

  function loop(ts) {
    if (!playing) return;
    if (ts - lastTs >= 1000 / fps) {
      lastTs = ts;
      idx = (idx + 1) % frames.length;
      draw();
    }
    raf = requestAnimationFrame(loop);
  }

  // --- wiring ---------------------------------------------------------------
  const playBtn = el("replay-play");
  playBtn.addEventListener("click", () => {
    playing = !playing;
    playBtn.textContent = playing ? "⏸ PAUSE" : "▶ PLAY";
    if (playing) raf = requestAnimationFrame(loop);
    else if (raf) cancelAnimationFrame(raf);
  });
  el("replay-step").addEventListener("click", () => {
    playing = false; playBtn.textContent = "▶ PLAY";
    idx = Math.min(idx + 1, frames.length - 1);
    draw();
  });
  const speed = el("replay-speed");
  speed.addEventListener("input", () => {
    fps = Number(speed.value);
    el("replay-fps").textContent = fps + "/s";
  });
  el("replay-scrub").addEventListener("input", (e) => {
    idx = Number(e.target.value);
    draw();
  });

  setNote(`recording: ${frames.length} heartbeats (tick ${frames[0].t} → ${frames.at(-1).t}), every frame a replayed on-chain read — generated ${data.meta.generated.slice(0, 10)}`);
  draw();
  return { stop() { playing = false; if (raf) cancelAnimationFrame(raf); } };
}
