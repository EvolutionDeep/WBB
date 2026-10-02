import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ethers } from "ethers";

/**
 * READ-ONLY 3D viewer for the on-chain worm.
 *
 * Everything drawn here is on-chain state of the deployed WormBrainV2, fetched with
 * eth_call only (V[], spikeCount[], motor gate[], tick, connRoot). It never signs,
 * never sends a transaction and never runs a second copy of the brain in the browser.
 *
 * Honesty contract (project rule: no animation may pretend the animal is alive):
 *   - the peristaltic wave amplitude, direction and speed come from the real motor
 *     neuron gates read from the contract;
 *   - when the brain stops advancing (nobody pays gas), the wave decays to zero and
 *     the body freezes, and the HUD says HALTED.
 *
 * Comment policy: English only (project rule).
 */

// ---- encoding helpers for the public array getters of WormBrainV2 ----
const VIZ_IFACE = new ethers.Interface([
  "function V(uint256) view returns (int256)",
  "function gate(uint256) view returns (int256)",
  "function spikeCount(uint256) view returns (uint256)",
  "function tick() view returns (uint256)",
  "function connRoot() view returns (bytes32)",
]);

// frozen motor / interneuron indices (WormNeurons table)
const GATE_IDX = [53, 54, 55, 56, 72, 73, 76, 77, 39, 40]; // AVAL AVAR AVBL AVBR AWAL AWAR AWCL AWCR ASEL ASER
const IDX = { AVAL: 53, AVAR: 54, AVBL: 55, AVBR: 56, AWAL: 72, AWAR: 73, AWCL: 76, AWCR: 77, ASEL: 39, ASER: 40 };

// ---- scene constants (world units, purely visual) ----
const LEN = 13; // body length
const R0 = 0.85; // widest body radius
const SAMPLES = 92; // rings along the body
const RING = 18; // vertices per ring
const TAU = Math.PI * 2;
const WAVES = 3.2; // wavelengths along the body
const POLL_MS = 12000; // chain read cadence
// One batch of a few hundred eth_call is what makes 302 live voltages affordable.
// Not every public gateway honours JSON-RPC batches: bsc-dataseed replies HTTP 200
// with an array whose items carry no result at all, so the reader below probes the
// candidates and sticks to the first endpoint that actually answers the batch.
const ETH_CHUNK = 300; // eth_call per JSON-RPC batch request

// analytic spine shared by the body mesh and the neuron placement: t 0 = nose, 1 = tail
function spine(t) {
  return { x: (0.5 - t) * LEN, y: Math.sin(t * Math.PI) * LEN * 0.05, z: 0 };
}
function radiusAt(t) {
  const u = Math.min(1, Math.max(0, t));
  return R0 * (0.2 + 0.8 * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.78)), 0.45));
}
function upAt(t) {
  const d = 1e-3;
  const a = spine(Math.max(0, t - d));
  const b = spine(Math.min(1, t + d));
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  return { x: -ty / len, y: tx / len }; // perpendicular to the tangent, in the bending plane
}

export async function createWormViz({ container, getTarget }) {
  // ---- static connectome + anatomy ----
  const [graph, layout] = await Promise.all([
    fetch("data/graph.json").then((r) => r.json()),
    fetch("data/layout.json").then((r) => r.json()),
  ]);
  const names = graph.names;
  const nN = graph.nNeurons;
  const C = graph.consts;
  // display band for brightness: voltage read against the firing threshold, because
  // the Q20 floor V_LO is so deep that mapping to it would flatten every node to
  // nearly full brightness and hide the actual sub-threshold dynamics.
  const vBand = Math.abs(Number(C.V_THRESH)) || 650117;
  const scale = Number(C.SCALE) || 1048576;
  // display gain for the body wave: amplitude stays proportional to the real motor
  // gate difference, this factor only makes small sub-threshold drive visible.
  const AMP_GAIN = 4;

  // name -> contract index, contract index -> anatomy
  const byName = new Map(names.map((nm, i) => [nm, i]));
  const place = new Array(nN).fill(null);
  for (const nb of layout.neurons) {
    const i = byName.get(nb.name);
    if (i === undefined) continue;
    place[i] = nb;
  }

  // ---- renderer / camera / controls ----
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050a0e);
  scene.fog = new THREE.FogExp2(0x050a0e, 0.028);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 400);
  camera.position.set(6, 4.5, 13);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 3;
  controls.maxDistance = 60;

  scene.add(new THREE.AmbientLight(0x35506a, 1.1));
  const key = new THREE.DirectionalLight(0xbfefff, 1.5);
  key.position.set(6, 10, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x38f5b0, 0.8);
  rim.position.set(-8, -4, -6);
  scene.add(rim);

  // ---- body: rebuilt on the CPU so the wave is a real function of the chain gates ----
  const bodyGeom = new THREE.BufferGeometry();
  const verts = SAMPLES * RING;
  bodyGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  const idx = [];
  for (let s = 0; s < SAMPLES - 1; s++) {
    for (let k = 0; k < RING; k++) {
      const a = s * RING + k;
      const b = s * RING + ((k + 1) % RING);
      const c = (s + 1) * RING + k;
      const d = (s + 1) * RING + ((k + 1) % RING);
      idx.push(a, c, b, b, c, d);
    }
  }
  bodyGeom.setIndex(idx);
  const bodyMat = new THREE.MeshPhongMaterial({
    color: 0x14343c, emissive: 0x071b21, specular: 0x9fe8ff, shininess: 26,
    transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
  });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  scene.add(body);

  // ---- neurons: one instanced sphere per contract neuron ----
  const neuronGeom = new THREE.SphereGeometry(1, 12, 10);
  const neuronMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const nodes = new THREE.InstancedMesh(neuronGeom, neuronMat, nN);
  nodes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  nodes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nN * 3), 3);
  nodes.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(nodes);

  // ---- synapses: 5144 directed connections, pre -> post ----
  const eCount = graph.edges.length;
  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(eCount * 6), 3));
  const lineCol = new THREE.Float32BufferAttribute(new Float32Array(eCount * 6), 3);
  lineGeom.setAttribute("color", lineCol);
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22 });
  const lines = new THREE.LineSegments(lineGeom, lineMat);
  scene.add(lines);

  const EXC = new THREE.Color(0x2fd8ff);
  const INH = new THREE.Color(0xff5b7f);
  for (let e = 0; e < eCount; e++) {
    const w = graph.edges[e][2];
    const col = w < 0 ? INH : EXC;
    lineCol.setXYZ(e * 2, col.r, col.g, col.b);
    lineCol.setXYZ(e * 2 + 1, col.r, col.g, col.b);
  }
  lineCol.needsUpdate = true;

  // ---- live state read from chain ----
  const st = {
    V: new Float64Array(nN),
    spikePrev: new Array(nN).fill(0),
    spikeNow: new Array(nN).fill(0),
    flash: new Float32Array(nN),
    gates: {},
    tick: null,
    tickAt: 0,
    connRoot: null,
    error: null,
    busy: false,
  };

  // ---- per-frame geometry write ----
  const dummy = new THREE.Object3D();
  const colTmp = new THREE.Color();

  function waveAt(t, phase, amp) {
    return amp * Math.sin(TAU * (WAVES * t) - phase);
  }

  function writeScene(phase, amp, bend) {
    const pos = bodyGeom.attributes.position;
    for (let s = 0; s < SAMPLES; s++) {
      const t = s / (SAMPLES - 1);
      const c = spine(t);
      const up = upAt(t);
      const r = radiusAt(t);
      const arch = bend * r * 1.1 * Math.sin(t * Math.PI);
      const w = waveAt(t, phase, amp * r) + arch;
      for (let k = 0; k < RING; k++) {
        const ang = (k / RING) * TAU;
        const rr = r * (1 + 0.12 * Math.cos(2 * ang));
        const radial = Math.cos(ang) * rr;
        const lateral = Math.sin(ang) * rr;
        const off = w + radial;
        const i = s * RING + k;
        pos.setXYZ(i, c.x + up.x * off, c.y + up.y * off, lateral);
      }
    }
    pos.needsUpdate = true;
    bodyGeom.computeVertexNormals();

    // neurons ride the same wave
    for (let i = 0; i < nN; i++) {
      const nb = place[i];
      if (!nb) {
        dummy.position.set(0, 0, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        nodes.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const t = nb.t;
      const c = spine(t);
      const up = upAt(t);
      const r = radiusAt(t);
      const off = waveAt(t, phase, amp * r) + bend * r * 1.1 * Math.sin(t * Math.PI) + nb.dv * r;
      dummy.position.set(c.x + up.x * off, c.y + up.y * off, nb.lr * r);
      const heat = Math.pow(Math.min(1, Math.max(0, (st.V[i] + vBand) / (2 * vBand))), 2);
      const sz = 0.055 + nb.size * 0.05 + heat * 0.07 + st.flash[i] * 0.16;
      dummy.scale.setScalar(sz);
      dummy.updateMatrix();
      nodes.setMatrixAt(i, dummy.matrix);

      const fl = st.flash[i];
      colTmp.setRGB(
        0.06 + heat * 0.55 + fl * 0.95,
        0.42 + heat * 0.5 + fl * 0.95,
        0.5 + heat * 0.45 + fl * 0.95,
      );
      nodes.setColorAt(i, colTmp);
    }
    nodes.instanceMatrix.needsUpdate = true;
    if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true;

    // synapses follow their endpoints
    const lp = lineGeom.attributes.position;
    for (let e = 0; e < eCount; e++) {
      const [s, d] = graph.edges[e];
      const ps = place[s];
      const pd = place[d];
      if (!ps || !pd) continue;
      const cs = spine(ps.t);
      const us = upAt(ps.t);
      const rs = radiusAt(ps.t);
      const ws = waveAt(ps.t, phase, amp * rs);
      const cd = spine(pd.t);
      const ud = upAt(pd.t);
      const rd = radiusAt(pd.t);
      const wd = waveAt(pd.t, phase, amp * rd);
      lp.setXYZ(e * 2,
        cs.x + us.x * (ws + ps.dv * rs), cs.y + us.y * (ws + ps.dv * rs), ps.lr * rs);
      lp.setXYZ(e * 2 + 1,
        cd.x + ud.x * (wd + pd.dv * rd), cd.y + ud.y * (wd + pd.dv * rd), pd.lr * rd);
    }
    lp.needsUpdate = true;
  }

  // ---- read-only chain access (JSON-RPC batch of eth_call, chunked) ----
  async function batchEthCall(rpcUrl, brain, calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += ETH_CHUNK) {
      const part = calls.slice(i, i + ETH_CHUNK);
      const payload = part.map((c, j) => ({
        jsonrpc: "2.0", id: j, method: "eth_call", params: [{ to: brain, data: c }, "latest"],
      }));
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const arr = await res.json();
      if (!Array.isArray(arr)) {
        throw new Error(arr && arr.error && arr.error.message ? arr.error.message : "no batch reply");
      }
      const byId = new Map(arr.map((x) => [x.id, x]));
      for (let j = 0; j < part.length; j++) {
        const item = byId.get(j);
        // a gateway that answers with empty items is unusable for this view: fail it
        // so the caller rotates to the next endpoint instead of rendering zeros.
        if (!item || item.error || typeof item.result !== "string") throw new Error("batch not served");
        out.push(item.result);
      }
    }
    return out;
  }

  // remembered endpoint that proved it can serve batches (avoids re-probing each poll)
  let goodUrl = null;

  // built-in batch-capable fallback: the configured seed list can be narrowed by
  // a localStorage wbb_rpc override from earlier debugging, and gateways like
  // bsc-dataseed swallow batches entirely — if nothing configured serves a batch,
  // try this instead of leaving the viewer stuck reporting an error.
  const BATCH_FALLBACK = "https://bsc-rpc.publicnode.com";

  // endpoints observed to honour JSON-RPC batches are tried first
  const BATCH_FIRST = [/publicnode/i, /ankr/i, /llamarpc/i];
  const batchRank = (u) => { const i = BATCH_FIRST.findIndex((re) => re.test(u)); return i < 0 ? 99 : i; };
  const orderCandidates = (list) => [...list].sort((a, b) => batchRank(a) - batchRank(b));

  async function refresh() {
    if (st.busy) return;
    st.busy = true;
    try {
      const { rpcUrls, brain } = getTarget();
      if (!brain) throw new Error("brain address not resolved yet");
      const list = orderCandidates((rpcUrls || []).filter(Boolean));
      if (!list.length) throw new Error("no RPC endpoint configured");
      const url0 = list[0];
      // prefer the endpoint that already worked, then try the rest
      const order = goodUrl ? [goodUrl, ...list.filter((u) => u !== goodUrl)] : list;

      const calls = [];
      for (let i = 0; i < nN; i++) calls.push(VIZ_IFACE.encodeFunctionData("V", [i]));
      for (let i = 0; i < nN; i++) calls.push(VIZ_IFACE.encodeFunctionData("spikeCount", [i]));
      for (const gi of GATE_IDX) calls.push(VIZ_IFACE.encodeFunctionData("gate", [gi]));
      calls.push(VIZ_IFACE.encodeFunctionData("tick", []));
      calls.push(VIZ_IFACE.encodeFunctionData("connRoot", []));

      let raw = null;
      let lastErr = null;
      for (const url of order) {
        try {
          raw = await batchEthCall(url, brain, calls);
          if (goodUrl !== url) { goodUrl = url; st.probed = url; }
          break;
        } catch (e) { lastErr = e; }
      }
      if (!raw) {
        if (url0 !== BATCH_FALLBACK) {
          try { raw = await batchEthCall(BATCH_FALLBACK, brain, calls); goodUrl = BATCH_FALLBACK; st.probed = BATCH_FALLBACK; lastErr = null; }
          catch (e) { lastErr = e; }
        }
      }
      if (!raw) throw lastErr || new Error("no endpoint serves batches");
      const dec = (kind, hex) => VIZ_IFACE.decodeFunctionResult(kind, hex)[0];
      const prevTick = st.tick;

      for (let i = 0; i < nN; i++) st.V[i] = Number(dec("V", raw[i]));
      const spikeStart = nN;
      for (let i = 0; i < nN; i++) st.spikeNow[i] = Number(dec("spikeCount", raw[spikeStart + i]));
      const gateStart = spikeStart + nN;
      const g = {};
      GATE_IDX.forEach((gi, k) => { g[gi] = Number(dec("gate", raw[gateStart + k])) / scale; });
      st.gates = g;
      st.tick = Number(dec("tick", raw[gateStart + GATE_IDX.length]));
      st.connRoot = dec("connRoot", raw[gateStart + GATE_IDX.length + 1]);

      // liveness is the tick actually moving, not the read succeeding: stamp the beat
      // only on a change, so a stalled chain freezes the body instead of replaying
      // the last gates forever. A single transient read failure must not freeze an
      // animal whose tick was demonstrably moving seconds ago, so liveness is the
      // freshness window alone; the error line below still reports the failure.
      if (prevTick === null || st.tick !== prevTick) st.tickAt = Date.now();

      // a spike is a real event: spikeCount only ever grows, so any increase fired
      // within the observed window and lights up that neuron
      for (let i = 0; i < nN; i++) {
        if (st.spikeNow[i] > st.spikePrev[i]) st.flash[i] = 1;
        st.spikePrev[i] = st.spikeNow[i];
      }
      st.tickAt = st.tickAt || Date.now();
      st.error = null;
    } catch (e) {
      st.error = (e && e.message) || String(e);
    } finally {
      st.busy = false;
    }
  }

  // ---- animation: wave driven only by what the chain actually reports ----
  let phase = 0;
  let ampShown = 0;
  let bendShown = 0;
  let raf = 0;
  let last = performance.now();

  function targetMotion() {
    const gt = st.gates || {};
    const fwd = (gt[IDX.AVBL] || 0) + (gt[IDX.AVBR] || 0);
    const rev = (gt[IDX.AVAL] || 0) + (gt[IDX.AVAR] || 0);
    const turn = (gt[IDX.AWCL] || 0) + (gt[IDX.AWCR] || 0) - (gt[IDX.AWAL] || 0) - (gt[IDX.AWAR] || 0);
    const net = fwd - rev;
    const alive = st.tick !== null && Date.now() - st.tickAt < 90000;
    if (!alive) return { amp: 0, dir: 0, bend: 0, alive: false };
    const amp = Math.min(0.5, Math.abs(net) * AMP_GAIN);
    return { amp, dir: net >= 0 ? 1 : -1, bend: Math.max(-0.6, Math.min(0.6, turn * 0.15)), alive: true };
  }

  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const m = targetMotion();
    ampShown += (m.amp - ampShown) * Math.min(1, dt * 3);
    bendShown += (m.bend - bendShown) * Math.min(1, dt * 3);
    phase += dt * m.dir * (0.9 + ampShown * 3.5);
    for (let i = 0; i < nN; i++) if (st.flash[i] > 0) st.flash[i] = Math.max(0, st.flash[i] - dt * 1.6);
    writeScene(phase, ampShown, bendShown);
    hud(m);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  // ---- HUD ----
  const hudEl = document.createElement("div");
  hudEl.className = "viz-hud";
  container.appendChild(hudEl);
  const tipEl = document.createElement("div");
  tipEl.className = "viz-tip";
  container.appendChild(tipEl);

  function hud(m) {
    const tickTxt = st.tick === null ? "—" : String(st.tick);
    const rootTxt = st.connRoot ? st.connRoot.slice(0, 12) + "…" : "—";
    hudEl.innerHTML =
      `<div class="viz-line"><b>tick</b> ${tickTxt} · <b>connRoot</b> ${rootTxt}</div>` +
      `<div class="viz-line"><b>wave amp</b> ${ampShown.toFixed(3)} · <b>dir</b> ${m.dir > 0 ? "forward (AVB)" : m.dir < 0 ? "reverse (AVA)" : "—"} · <b>turn</b> ${bendShown.toFixed(2)}</div>` +
      `<div class="viz-line">display gains: wave = |AVB-AVA| gate x${AMP_GAIN} · node brightness = (V in [-V_THRESH,+V_THRESH])^2</div>` +
      (m.alive
        ? `<div class="viz-line ok">LIVE · motor gates read from chain, wave is their function</div>`
        : `<div class="viz-line halt">HALTED · no advance recently: the body is frozen, not animated</div>`) +
      (st.error ? `<div class="viz-line err">chain read failed: ${st.error}</div>` : "") +
      (st.probed && !st.error
        ? `<div class="viz-line">batch endpoint ${new URL(st.probed).host} · ${nN * 2 + GATE_IDX.length + 2} eth_call/poll</div>`
        : "");
  }

  // hover readout: which neuron, its on-chain voltage and spike history
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  renderer.domElement.addEventListener("pointermove", (ev) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(nodes);
    if (hit.length && hit[0].instanceId !== undefined) {
      const i = hit[0].instanceId;
      const nb = place[i] || {};
      tipEl.textContent = `${names[i]} · V ${Math.round(st.V[i])} (Q20) · spikes ${st.spikePrev[i]} · t ${nb.t ?? "—"} · ${nb.cls ?? ""}`;
      tipEl.style.opacity = "1";
    } else {
      tipEl.style.opacity = "0";
    }
  });

  function resize() {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 420;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  writeScene(0, 0, 0);
  raf = requestAnimationFrame(loop);
  refresh();
  const timer = setInterval(refresh, POLL_MS);

  return {
    refresh,
    stop() {
      cancelAnimationFrame(raf);
      clearInterval(timer);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      bodyGeom.dispose();
      neuronGeom.dispose();
      lineGeom.dispose();
      bodyMat.dispose();
      neuronMat.dispose();
      lineMat.dispose();
      hudEl.remove();
      tipEl.remove();
      renderer.domElement.remove();
    },
  };
}
