import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * DEMO 3D viewer for the worm's connectome.
 *
 * This module talks to nothing but two local data files. No ethereum client, no chain
 * read of any kind, no signing: the animation is self-driven and runs forever, so the
 * card is a visualisation of the animal's shape, not a reading of its state.
 *
 * What is still real: the anatomy. 302 neuron ids, their dorsoventral / left-right
 * placement along the body and the 5,144 directed synapses come from graph.json and
 * layout.json, which are generated from the connectome baked into the on-chain genome.
 * Signal pulses therefore travel along genuine pre -> post edges, in the correct
 * direction. What is synthetic: the peristaltic wave, the crawling/reversal schedule,
 * every neuron's brightness and every pulse. The HUD says so on every frame.
 *
 * Honesty contract (project rule: no animation may pretend the animal is alive):
 * a live reading of the animal's state lives on the identity card, and this canvas is
 * labelled DEMO with its drive described as synthetic.
 *
 * Comment policy: English only (project rule).
 */

// ---- body shape (world units, purely visual) ----
const LEN = 13; // body length
const R0 = 0.85; // widest body radius
const SAMPLES = 100; // rings along the cuticle
const RING = 20; // vertices per ring
const G_SAMPLES = 64; // rings of the inner gut
const G_RING = 12;
const TAU = Math.PI * 2;
const WAVES = 3.2; // wavelengths along the body
const N_PULSE = 54; // travelling signals
const N_DUST = 420; // suspended particles in the medium

// ---- seeded pseudo-randomness: the demo plays the same choreography every load,
// so a screenshot taken during review matches what a visitor sees ----
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/**
 * Displaced centreline plus its local frame. The cuticle, the gut, the nerve cord and
 * every soma are all positioned through this one function, so nothing can drift out of
 * the body when the wave changes.
 */
function frame(t, phase, amp, bend, out) {
  const sp = spine(t);
  const up = upAt(t);
  const r = radiusAt(t);
  const k = TAU * (WAVES * t) - phase;
  // a second harmonic keeps the peristalsis from looking like a metronome
  const dw = amp * r * (Math.sin(k) + 0.26 * Math.sin(2 * k - phase * 0.4));
  const arch = bend * r * 1.15 * Math.sin(t * Math.PI);
  const off = dw + arch;
  out.x = sp.x + up.x * off;
  out.y = sp.y + up.y * off;
  out.z = amp * r * 0.3 * Math.sin(TAU * (WAVES * 0.5 * t) - phase * 0.85);
  out.ux = up.x;
  out.uy = up.y;
  out.r = r;
  return out;
}

// ---- neuron classes: one colour per anatomical group, so the picture reads as
// a nervous system rather than as 302 identical dots ----
const PALETTE = {
  ring: 0x7ef0ff, // nerve ring around the pharynx
  sensor_head: 0xffd27a, // head sensory endings
  cord_motor: 0x6bff9e, // motor neurons of the ventral cord
  cord_misc: 0x93b9ff, // cord interneurons
  postdeirid: 0xc58bff, // post-deirid mechanosensors
  midbody: 0x41e3c8,
  tail: 0xff7a9c,
};
const FALLBACK = 0x9db8c8;

// a soft round sprite for the additive glow layers
function glowTexture() {
  const n = 64;
  const cv = document.createElement("canvas");
  cv.width = n;
  cv.height = n;
  const g = cv.getContext("2d");
  const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.22, "rgba(255,255,255,0.58)");
  grd.addColorStop(0.6, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, n, n);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// glow points share one shader: world-sized squares that always face the camera
function glowMaterial(tex) {
  return new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex }, uProj: { value: 700 } },
    vertexShader: `
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aAlpha;
      uniform float uProj;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(aSize * uProj / max(0.001, -mv.z), 260.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uTex;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float a = texture2D(uTex, gl_PointCoord).a;
        gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * A fresnel rim: a shell that only lights up where its surface turns away from the
 * camera. This is what makes a translucent animal and a glassy cell read as volume
 * instead of as a flat silhouette, and it costs one extra draw of geometry that is
 * already being rebuilt for the wave.
 *
 * `instanced` picks the variant for an InstancedMesh: three declares `instanceMatrix`
 * itself for instanced objects, so the attribute must not be redeclared here.
 */
function rimMaterial({ instanced, color, power = 2.4, strength = 1 }) {
  const pos = instanced ? "instanceMatrix * " : "";
  const nrm = instanced ? "mat3(instanceMatrix) * " : "";
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPower: { value: power },
      uStrength: { value: strength },
    },
    vertexShader: `
      uniform float uPower;
      varying float vRim;
      void main() {
        vec4 mv = modelViewMatrix * ${pos}vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * (${nrm}normal));
        vec3 v = normalize(-mv.xyz);
        vRim = pow(1.0 - abs(dot(n, v)), uPower);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uStrength;
      varying float vRim;
      void main() {
        gl_FragColor = vec4(uColor * vRim * uStrength, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export async function createWormViz({ container }) {
  // ---- static anatomy: the only files this module ever requests ----
  const [graph, layout] = await Promise.all([
    fetch("data/graph.json").then((r) => r.json()),
    fetch("data/layout.json").then((r) => r.json()),
  ]);
  const names = graph.names;
  const nN = graph.nNeurons;
  const eCount = graph.edges.length;

  const byName = new Map(names.map((nm, i) => [nm, i]));
  const place = new Array(nN).fill(null);
  for (const nb of layout.neurons) {
    const i = byName.get(nb.name);
    if (i !== undefined) place[i] = nb;
  }

  // edge endpoints as flat typed arrays, and the inhibitory flag from the real sign
  const ePre = new Int32Array(eCount);
  const ePost = new Int32Array(eCount);
  const wAbs = new Float32Array(eCount);
  const eInh = new Uint8Array(eCount);
  let wMax = 1;
  for (let e = 0; e < eCount; e++) {
    const [s, d, w] = graph.edges[e];
    ePre[e] = s;
    ePost[e] = d;
    eInh[e] = w < 0 ? 1 : 0;
    wAbs[e] = Math.abs(w);
    if (wAbs[e] > wMax) wMax = wAbs[e];
  }
  // adjacency, so a pulse that reaches a cell can carry on down that cell's own axon
  const outEdges = new Map();
  for (let e = 0; e < eCount; e++) {
    const s = ePre[e];
    const list = outEdges.get(s);
    if (list) list.push(e);
    else outEdges.set(s, [e]);
  }

  const rnd = mulberry32(0x5ef1c0);
  // per-neuron oscillator: a quiet baseline rhythm the pulses ride on top of
  const oscPhase = new Float32Array(nN);
  const oscRate = new Float32Array(nN);
  for (let i = 0; i < nN; i++) {
    oscPhase[i] = rnd() * TAU;
    oscRate[i] = 0.08 + rnd() * 0.5;
  }
  const drive = new Float32Array(nN);
  const flash = new Float32Array(nN);
  const npos = new Float32Array(nN * 3);

  // ---- renderer / camera / controls ----
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040910);
  scene.fog = new THREE.FogExp2(0x040910, 0.024);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
  camera.position.set(5.4, 4.2, 13.5);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // ACES pulls mid-tones down hard compared with the linear response this scene used
  // to render with, so the exposure has to come back up or the animal reads as a dark
  // outline: measured at exposure 1.12, 93% of the canvas was plain background.
  renderer.toneMappingExposure = 1.5;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 3;
  controls.maxDistance = 60;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  scene.add(new THREE.AmbientLight(0x35506a, 1.15));
  const key = new THREE.DirectionalLight(0xbfefff, 1.6);
  key.position.set(6, 10, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x38f5b0, 0.85);
  rim.position.set(-8, -4, -6);
  scene.add(rim);
  const headLamp = new THREE.PointLight(0xffd8a0, 1.2, 9, 2);
  scene.add(headLamp);

  // ---- cuticle: rebuilt on the CPU every frame so it is one continuous membrane,
  // shaded head -> mid -> tail with faint annular grooves ----
  const bodyGeom = new THREE.BufferGeometry();
  const bodyColor = new Float32Array(SAMPLES * RING * 3);
  const HEAD = new THREE.Color(0xf2c48c);
  const MID = new THREE.Color(0x2fa2b6);
  const TAIL = new THREE.Color(0xd8628c);
  for (let s = 0; s < SAMPLES; s++) {
    const t = s / (SAMPLES - 1);
    const c = HEAD.clone().lerp(MID, Math.min(1, t / 0.34));
    if (t > 0.34) c.lerp(TAIL, Math.min(1, (t - 0.34) / 0.66));
    // 21 shallow bands, the cuticle annuli of the animal, kept subtle
    const band = 0.88 + 0.12 * Math.cos(t * 21 * TAU);
    for (let k = 0; k < RING; k++) {
      const i = s * RING + k;
      bodyColor[i * 3] = c.r * band;
      bodyColor[i * 3 + 1] = c.g * band;
      bodyColor[i * 3 + 2] = c.b * band;
    }
  }
  bodyGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SAMPLES * RING * 3), 3));
  bodyGeom.setAttribute("color", new THREE.BufferAttribute(bodyColor, 3));
  const shellIdx = [];
  for (let s = 0; s < SAMPLES - 1; s++) {
    for (let k = 0; k < RING; k++) {
      const a = s * RING + k;
      const b = s * RING + ((k + 1) % RING);
      const c = (s + 1) * RING + k;
      const d = (s + 1) * RING + ((k + 1) % RING);
      shellIdx.push(a, c, b, b, c, d);
    }
  }
  bodyGeom.setIndex(shellIdx);
  const bodyMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.3,
    roughness: 0.2,
    metalness: 0,
    clearcoat: 0.7,
    clearcoatRoughness: 0.3,
    emissive: 0x061620,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  scene.add(body);

  // the same membrane lit only at its grazing angles: this is the outline of the
  // animal, and it shares the geometry the wave already writes
  const bodyRimMat = rimMaterial({ instanced: false, color: 0x63e6ff, power: 2.2, strength: 0.85 });
  const bodyRim = new THREE.Mesh(bodyGeom, bodyRimMat);
  bodyRim.renderOrder = 2;
  scene.add(bodyRim);

  // ---- gut: a second, thinner membrane running inside the same wave ----
  const gutGeom = new THREE.BufferGeometry();
  gutGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(G_SAMPLES * G_RING * 3), 3));
  const gutIdx = [];
  for (let s = 0; s < G_SAMPLES - 1; s++) {
    for (let k = 0; k < G_RING; k++) {
      const a = s * G_RING + k;
      const b = s * G_RING + ((k + 1) % G_RING);
      const c = (s + 1) * G_RING + k;
      const d = (s + 1) * G_RING + ((k + 1) % G_RING);
      gutIdx.push(a, c, b, b, c, d);
    }
  }
  gutGeom.setIndex(gutIdx);
  const gutMat = new THREE.MeshStandardMaterial({
    color: 0x2c2011,
    emissive: 0xe8a35a,
    emissiveIntensity: 0.4,
    transparent: true,
    opacity: 0.5,
    roughness: 0.55,
    depthWrite: false,
  });
  const gut = new THREE.Mesh(gutGeom, gutMat);
  scene.add(gut);

  // ---- the two organs that give the silhouette somewhere to look: the pharynx bulb
  // under the nerve ring and the tail tip. Both ride the same wave, so they cannot
  // come loose from the body when it bends.
  const pharynxGeom = new THREE.SphereGeometry(1, 24, 18);
  const pharynxMat = new THREE.MeshStandardMaterial({
    color: 0x3d2b16,
    emissive: 0xffb055,
    emissiveIntensity: 0.55,
    roughness: 0.45,
    transparent: true,
    opacity: 0.6,
  });
  const pharynx = new THREE.Mesh(pharynxGeom, pharynxMat);
  scene.add(pharynx);

  const tailGeom = new THREE.SphereGeometry(1, 16, 12);
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x3a1a24,
    emissive: 0xff7a9c,
    emissiveIntensity: 0.5,
    roughness: 0.5,
    transparent: true,
    opacity: 0.55,
  });
  const tailTip = new THREE.Mesh(tailGeom, tailMat);
  scene.add(tailTip);

  // ---- ventral nerve cord and nerve ring: two lit fibres, drawn from the same frame
  function lineGeom(n, closed) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    return { geom: g, n, closed };
  }
  const lineMat = (hex, op) =>
    new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false });

  const CORD_N = 120;
  const cord = lineGeom(CORD_N);
  const cordLine = new THREE.Line(cord.geom, lineMat(0x5fe8d0, 0.5));
  scene.add(cordLine);

  const RING_N = 40;
  const ringFibre = lineGeom(RING_N + 1);
  const ringLine = new THREE.Line(ringFibre.geom, lineMat(0x7ef0ff, 0.55));
  scene.add(ringLine);

  // ---- synapses: every one of the 5,144 directed connections, additive so dense
  // regions read as glow rather than as mud; brightness carries the connection weight
  const synGeom = new THREE.BufferGeometry();
  synGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(eCount * 6), 3));
  const synCol = new THREE.Float32BufferAttribute(new Float32Array(eCount * 6), 3);
  synGeom.setAttribute("color", synCol);
  const synMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.45,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const synapses = new THREE.LineSegments(synGeom, synMat);
  scene.add(synapses);

  const EXC = new THREE.Color(0x2fd8ff);
  const INH = new THREE.Color(0xff5b7f);
  for (let e = 0; e < eCount; e++) {
    // weak connections fall off so the 5,144-edge tangle keeps the body legible, but
    // the curve stays shallow enough that the mesh of the network is still visible:
    // the first attempt at this (exponent 1.15, opacity 0.34) dimmed the whole picture
    // to a fifth of its former light and left a dark field with one bright rim
    const b = 0.1 + 0.8 * Math.pow(wAbs[e] / wMax, 0.75);
    const col = eInh[e] ? INH : EXC;
    synCol.setXYZ(e * 2, col.r * b, col.g * b, col.b * b);
    synCol.setXYZ(e * 2 + 1, col.r * b, col.g * b, col.b * b);
  }
  synCol.needsUpdate = true;

  // ---- neuron somata: ellipsoids stretched along the body axis, lit and shaded so
  // they have volume, an additive halo that grows with activation, and a glassy
  // membrane shell around each one. Sizes are deliberately large enough that the
  // shading reads on screen: at the previous half-scale a soma was ~4 px and every
  // refinement in it disappeared into a single pixel.
  const neuronGeom = new THREE.IcosahedronGeometry(1, 2);
  const neuronMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.26,
    metalness: 0.02,
    clearcoat: 0.9,
    clearcoatRoughness: 0.2,
    emissive: 0x0b1a22,
  });
  const nodes = new THREE.InstancedMesh(neuronGeom, neuronMat, nN);
  nodes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // somata are rewritten every frame and their instance bounds would go stale
  nodes.frustumCulled = false;
  scene.add(nodes);

  const memRimMat = rimMaterial({ instanced: true, color: 0xa8f2ff, power: 2.8, strength: 0.5 });
  const membranes = new THREE.InstancedMesh(neuronGeom, memRimMat, nN);
  membranes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  membranes.frustumCulled = false;
  scene.add(membranes);

  // soma size follows what the cell is: motor cells and the nerve ring are the large
  // ones in the animal, cord interneurons the smallest, so the picture has hierarchy
  const CLASS_EMPHASIS = {
    cord_motor: 1.3,
    ring: 1.22,
    tail: 1.12,
    sensor_head: 1.04,
    postdeirid: 1.0,
    midbody: 0.98,
    cord_misc: 0.9,
  };
  const cellScale = new Float32Array(nN);
  for (let i = 0; i < nN; i++) {
    const nb = place[i];
    cellScale[i] = nb ? (CLASS_EMPHASIS[nb.cls] ?? 1) : 0.0001;
  }

  const tex = glowTexture();
  const haloMat = glowMaterial(tex);
  const haloGeom = new THREE.BufferGeometry();
  const haloPos = new Float32Array(nN * 3);
  const haloCol = new Float32Array(nN * 3);
  const haloSize = new Float32Array(nN);
  const haloAlpha = new Float32Array(nN);
  haloGeom.setAttribute("position", new THREE.BufferAttribute(haloPos, 3));
  haloGeom.setAttribute("aColor", new THREE.BufferAttribute(haloCol, 3));
  haloGeom.setAttribute("aSize", new THREE.BufferAttribute(haloSize, 1));
  haloGeom.setAttribute("aAlpha", new THREE.BufferAttribute(haloAlpha, 1));
  const halos = new THREE.Points(haloGeom, haloMat);
  halos.frustumCulled = false;
  scene.add(halos);

  const baseCol = new Array(nN);
  for (let i = 0; i < nN; i++) {
    const nb = place[i];
    const hex = nb ? (PALETTE[nb.cls] ?? FALLBACK) : FALLBACK;
    baseCol[i] = new THREE.Color(hex);
  }

  // ---- travelling pulses: a comet riding a real edge, head glow plus tail segment
  const pulseGeom = new THREE.BufferGeometry();
  pulseGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N_PULSE * 6), 3));
  const pulseCol = new THREE.Float32BufferAttribute(new Float32Array(N_PULSE * 6), 3);
  pulseGeom.setAttribute("color", pulseCol);
  const pulseMatl = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const pulseLines = new THREE.LineSegments(pulseGeom, pulseMatl);
  pulseLines.frustumCulled = false;
  scene.add(pulseLines);

  const pgGeom = new THREE.BufferGeometry();
  const pgPos = new Float32Array(N_PULSE * 3);
  const pgCol = new Float32Array(N_PULSE * 3);
  const pgSize = new Float32Array(N_PULSE);
  const pgAlpha = new Float32Array(N_PULSE);
  pgGeom.setAttribute("position", new THREE.BufferAttribute(pgPos, 3));
  pgGeom.setAttribute("aColor", new THREE.BufferAttribute(pgCol, 3));
  pgGeom.setAttribute("aSize", new THREE.BufferAttribute(pgSize, 1));
  pgGeom.setAttribute("aAlpha", new THREE.BufferAttribute(pgAlpha, 1));
  const pulseGlow = new THREE.Points(pgGeom, haloMat);
  pulseGlow.frustumCulled = false;
  scene.add(pulseGlow);

  const pickWeightedEdge = () => {
    // bias toward strong synapses so what the viewer shows is the backbone of the
    // network rather than a uniform lottery over its weakest links
    for (let tries = 0; tries < 8; tries++) {
      const e = Math.floor(rnd() * eCount);
      if (wAbs[e] / wMax > 0.25 || rnd() < 0.1) return e;
    }
    return Math.floor(rnd() * eCount);
  };
  const pulses = [];
  for (let p = 0; p < N_PULSE; p++) {
    pulses.push({ e: pickWeightedEdge(), u: rnd(), sp: 0.55 + rnd() * 0.9 });
  }

  // ---- suspended particles, purely set dressing, to give the medium depth
  const dustGeom = new THREE.BufferGeometry();
  const dustPos = new Float32Array(N_DUST * 3);
  for (let i = 0; i < N_DUST; i++) {
    dustPos[i * 3] = (rnd() - 0.5) * 34;
    dustPos[i * 3 + 1] = (rnd() - 0.5) * 18;
    dustPos[i * 3 + 2] = (rnd() - 0.5) * 22;
  }
  dustGeom.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    color: 0x2f6a86,
    size: 0.055,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeom, dustMat);
  scene.add(dust);

  // ---- behaviour: a scripted, deterministic sequence of crawl / pause / reversal /
  // turn episodes, the way the animal's own bout structure looks from outside
  const EPISODES = [
    { name: "forward crawl", dir: 1, amp: 0.3, bend: 0.03, tMin: 5, tMax: 11 },
    { name: "pause", dir: 0, amp: 0.05, bend: 0.08, tMin: 1.5, tMax: 3.5 },
    { name: "reversal", dir: -1, amp: 0.24, bend: -0.2, tMin: 2.5, tMax: 5 },
    { name: "turn", dir: 0, amp: 0.12, bend: 0.5, tMin: 2, tMax: 4 },
    { name: "slow crawl", dir: 1, amp: 0.13, bend: -0.06, tMin: 4, tMax: 9 },
  ];
  const W = [0.38, 0.16, 0.16, 0.1, 0.2];
  const episode = { idx: 0, name: EPISODES[0].name, dir: 1, amp: 0.3, bend: 0.03, left: 0 };
  function nextEpisode() {
    let x = rnd();
    let i = 0;
    while (i < EPISODES.length - 1 && x > W[i]) {
      x -= W[i];
      i++;
    }
    const ep = EPISODES[i];
    episode.idx = i;
    episode.name = ep.name;
    episode.dir = ep.dir;
    // a turn alternates its sign, which is what makes an omega turn look like one
    episode.bend = i === 3 ? (rnd() < 0.5 ? -1 : 1) * Math.abs(ep.bend) : ep.bend;
    episode.amp = ep.amp * (0.8 + rnd() * 0.4);
    episode.left = ep.tMin + rnd() * (ep.tMax - ep.tMin);
  }
  nextEpisode();

  // ---- per-frame scene write ----
  const dummy = new THREE.Object3D();
  const colTmp = new THREE.Color();
  const fr = { x: 0, y: 0, z: 0, ux: 0, uy: 0, r: 1 };

  function writeBody(phase, amp, bend) {
    const pos = bodyGeom.attributes.position;
    for (let s = 0; s < SAMPLES; s++) {
      const t = s / (SAMPLES - 1);
      frame(t, phase, amp, bend, fr);
      for (let k = 0; k < RING; k++) {
        const ang = (k / RING) * TAU;
        const rr = fr.r * (1 + 0.13 * Math.cos(2 * ang));
        const i = s * RING + k;
        pos.setXYZ(i, fr.x + fr.ux * Math.cos(ang) * rr, fr.y + fr.uy * Math.cos(ang) * rr, fr.z + Math.sin(ang) * rr);
      }
    }
    pos.needsUpdate = true;
    bodyGeom.computeVertexNormals();

    const gp = gutGeom.attributes.position;
    for (let s = 0; s < G_SAMPLES; s++) {
      const t = 0.06 + (s / (G_SAMPLES - 1)) * 0.78; // the gut runs from pharynx to anus
      frame(t, phase, amp, bend, fr);
      const gr = fr.r * 0.42;
      for (let k = 0; k < G_RING; k++) {
        const ang = (k / G_RING) * TAU;
        const i = s * G_RING + k;
        gp.setXYZ(i, fr.x + fr.ux * Math.cos(ang) * gr, fr.y + fr.uy * Math.cos(ang) * gr - gr * 0.12, fr.z + Math.sin(ang) * gr);
      }
    }
    gp.needsUpdate = true;
    gutGeom.computeVertexNormals();

    // ventral cord: a single fibre just inside the cuticle on the belly side
    const cp = cord.geom.attributes.position;
    for (let i = 0; i < cord.n; i++) {
      const t = i / (cord.n - 1);
      frame(t, phase, amp, bend, fr);
      cp.setXYZ(i, fr.x + fr.ux * fr.r * -0.42, fr.y + fr.uy * fr.r * -0.42, fr.z);
    }
    cp.needsUpdate = true;

    // nerve ring: a loop around the body at the pharynx level
    const rp = ringFibre.geom.attributes.position;
    const rt = 0.085;
    frame(rt, phase, amp, bend, fr);
    for (let i = 0; i <= RING_N; i++) {
      const ang = (i / RING_N) * TAU;
      rp.setXYZ(i, fr.x + fr.ux * Math.cos(ang) * fr.r * 0.72, fr.y + fr.uy * Math.cos(ang) * fr.r * 0.72, fr.z + Math.sin(ang) * fr.r * 0.72);
    }
    rp.needsUpdate = true;
  }

  // the pharynx is the one organ whose own rhythm shows through the body: the real
  // animal pumps it about twice a second to feed, so the bulb breathes on its own
  // clock while the rest of the picture rides the crawl wave
  function placeOrgans(time) {
    frame(0.075, phaseNow, ampShown, bendShown, fr);
    const pump = 1 + 0.13 * Math.sin(TAU * 0.5 * time);
    pharynx.position.set(fr.x, fr.y, fr.z);
    pharynx.scale.set(fr.r * 0.86 * pump, fr.r * 0.44, fr.r * 0.44);
    frame(0.962, phaseNow, ampShown, bendShown, fr);
    tailTip.position.set(fr.x, fr.y, fr.z);
    tailTip.scale.setScalar(fr.r * 0.6);
  }

  function writeNeurons(time, dt) {
    for (let i = 0; i < nN; i++) {
      const nb = place[i];
      if (!nb) {
        dummy.position.set(0, 0, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        nodes.setMatrixAt(i, dummy.matrix);
        membranes.setMatrixAt(i, dummy.matrix);
        haloAlpha[i] = 0;
        continue;
      }
      frame(nb.t, phaseNow, ampShown, bendShown, fr);
      const px = fr.x + fr.ux * nb.dv * fr.r;
      const py = fr.y + fr.uy * nb.dv * fr.r;
      const pz = fr.z + nb.lr * fr.r;
      npos[i * 3] = px;
      npos[i * 3 + 1] = py;
      npos[i * 3 + 2] = pz;

      // synthetic activation: a slow oscillator per cell, the local body strain, and
      // whatever signal just arrived over a synapse
      const osc = 0.5 + 0.5 * Math.sin(TAU * oscRate[i] * time + oscPhase[i]);
      const local = 0.5 + 0.5 * Math.sin(TAU * (WAVES * nb.t) - phaseNow);
      drive[i] = Math.min(1, 0.1 + 0.32 * osc + 0.22 * local + flash[i] * 0.9);
      flash[i] = Math.max(0, flash[i] - dt * 1.9);

      const heat = Math.pow(drive[i], 1.8);
      // a soma large enough to show its own shading, weighted by what the cell is
      const sz = (0.085 + (nb.size - 0.7) * 0.13 + heat * 0.085) * cellScale[i];
      dummy.position.set(px, py, pz);
      // soma stretched along the body axis: a cell body with a process, not a bead
      dummy.scale.set(sz * 1.35, sz, sz * 0.88);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      nodes.setMatrixAt(i, dummy.matrix);
      // its membrane, a glass shell a little wider than the cytoplasm it holds
      dummy.scale.multiplyScalar(1.5);
      dummy.updateMatrix();
      membranes.setMatrixAt(i, dummy.matrix);

      const b = baseCol[i];
      colTmp.setRGB(b.r, b.g, b.b).multiplyScalar(0.35 + 0.75 * heat);
      nodes.setColorAt(i, colTmp);

      haloPos[i * 3] = px;
      haloPos[i * 3 + 1] = py;
      haloPos[i * 3 + 2] = pz;
      haloCol[i * 3] = b.r;
      haloCol[i * 3 + 1] = b.g;
      haloCol[i * 3 + 2] = b.b;
      haloSize[i] = sz * (2.4 + 5.0 * heat);
      haloAlpha[i] = 0.14 + 0.66 * heat;
    }
    nodes.instanceMatrix.needsUpdate = true;
    membranes.instanceMatrix.needsUpdate = true;
    if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true;
    haloGeom.attributes.position.needsUpdate = true;
    haloGeom.attributes.aColor.needsUpdate = true;
    haloGeom.attributes.aSize.needsUpdate = true;
    haloGeom.attributes.aAlpha.needsUpdate = true;
  }

  function writeSynapses() {
    const lp = synGeom.attributes.position;
    for (let e = 0; e < eCount; e++) {
      const s = ePre[e];
      const d = ePost[e];
      lp.setXYZ(e * 2, npos[s * 3], npos[s * 3 + 1], npos[s * 3 + 2]);
      lp.setXYZ(e * 2 + 1, npos[d * 3], npos[d * 3 + 1], npos[d * 3 + 2]);
    }
    lp.needsUpdate = true;
  }

  function writePulses(dt) {
    const pp = pulseGeom.attributes.position;
    for (let p = 0; p < N_PULSE; p++) {
      const pl = pulses[p];
      pl.u += dt * pl.sp;
      if (pl.u >= 1) {
        // the signal has reached the postsynaptic cell: light it up and let it carry
        // on down that cell's own axon, or fade out if the cell has none
        const post = ePost[pl.e];
        flash[post] = Math.min(1.4, flash[post] + 0.9);
        const onward = outEdges.get(post);
        if (onward && onward.length && rnd() < 0.78) pl.e = onward[Math.floor(rnd() * onward.length)];
        else pl.e = pickWeightedEdge();
        pl.u = 0;
        pl.sp = 0.55 + rnd() * 0.9;
      }
      const s = ePre[pl.e];
      const d = ePost[pl.e];
      const ax = npos[s * 3];
      const ay = npos[s * 3 + 1];
      const az = npos[s * 3 + 2];
      const bx = npos[d * 3];
      const by = npos[d * 3 + 1];
      const bz = npos[d * 3 + 2];
      const tail = Math.max(0, pl.u - 0.22);
      pp.setXYZ(p * 2, ax + (bx - ax) * tail, ay + (by - ay) * tail, az + (bz - az) * tail);
      pp.setXYZ(p * 2 + 1, ax + (bx - ax) * pl.u, ay + (by - ay) * pl.u, az + (bz - az) * pl.u);

      const inh = eInh[pl.e] === 1;
      const bright = 1 - Math.min(1, pl.u) * 0.15;
      pulseCol.setXYZ(p * 2, inh ? 0.35 * bright : 0.1 * bright, inh ? 0.12 * bright : 0.5 * bright, inh ? 0.2 * bright : 0.75 * bright);
      pulseCol.setXYZ(p * 2 + 1, inh ? 1.0 : 0.55, inh ? 0.35 : 1.4, inh ? 0.5 : 1.6);

      const hx = ax + (bx - ax) * pl.u;
      const hy = ay + (by - ay) * pl.u;
      const hz = az + (bz - az) * pl.u;
      pgPos[p * 3] = hx;
      pgPos[p * 3 + 1] = hy;
      pgPos[p * 3 + 2] = hz;
      pgCol[p * 3] = inh ? 1.5 : 0.8;
      pgCol[p * 3 + 1] = inh ? 0.6 : 1.6;
      pgCol[p * 3 + 2] = inh ? 0.8 : 1.9;
      pgSize[p] = 0.24;
      pgAlpha[p] = 0.95;
    }
    pp.needsUpdate = true;
    pulseCol.needsUpdate = true;
    pgGeom.attributes.position.needsUpdate = true;
    pgGeom.attributes.aColor.needsUpdate = true;
    pgGeom.attributes.aSize.needsUpdate = true;
    pgGeom.attributes.aAlpha.needsUpdate = true;
  }

  // ---- animation loop: runs as long as the tab is visible, forever ----
  let phaseNow = 0;
  let ampShown = 0;
  let bendShown = 0;
  let timeNow = 0;
  let frames = 0;
  let raf = 0;
  let running = false;
  let last = performance.now();

  function loop(now) {
    raf = requestAnimationFrame(loop);
    // clamped at both ends: a system clock jump (a resumed laptop, a tab restored) can
    // hand back a timestamp older than the last one, and a negative dt would run the
    // flash decay backwards until every cell in the animal is lit at once
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    timeNow += dt;

    episode.left -= dt;
    if (episode.left <= 0) nextEpisode();

    // soft approach to the episode targets, plus a slow breath on the amplitude
    const k = Math.min(1, dt * 2.2);
    ampShown += (episode.amp * (0.88 + 0.12 * Math.sin(timeNow * 0.7)) - ampShown) * k;
    bendShown += (episode.bend - bendShown) * k;
    phaseNow += dt * episode.dir * (0.9 + ampShown * 3.4);

    writeBody(phaseNow, ampShown, bendShown);
    placeOrgans(timeNow);
    writeNeurons(timeNow, dt);
    // half of the 5,144-edge position write is enough: the synapses are faint, and
    // skipping alternate frames is what keeps this smooth on integrated graphics
    if ((frames & 1) === 0) writeSynapses();
    writePulses(dt);

    frame(0.02, phaseNow, ampShown, bendShown, fr);
    headLamp.position.set(fr.x, fr.y, fr.z);
    headLamp.intensity = 0.7 + 0.6 * Math.sin(timeNow * 1.3);
    dust.rotation.y += dt * 0.012;

    hud();
    renderer.render(scene, camera);
    frames++;
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stopLoop() {
    running = false;
    cancelAnimationFrame(raf);
  }
  // a background tab should not spend the visitor's battery
  const onVisibility = () => (document.hidden ? stopLoop() : start());
  document.addEventListener("visibilitychange", onVisibility);

  // ---- HUD: what is drawn, and explicitly what is invented ----
  const hudEl = document.createElement("div");
  hudEl.className = "viz-hud";
  container.appendChild(hudEl);
  const tipEl = document.createElement("div");
  tipEl.className = "viz-tip";
  container.appendChild(tipEl);

  function hud() {
    if ((frames & 7) !== 0) return; // text every 8th frame: the DOM is the slow part
    const dirTxt = episode.dir > 0 ? "forward" : episode.dir < 0 ? "reverse" : "no translation";
    const firing = (() => {
      let n = 0;
      for (let i = 0; i < nN; i++) if (flash[i] > 0.25) n++;
      return n;
    })();
    hudEl.innerHTML =
      `<div class="viz-line demo"><b>DEMO</b> — nothing here is read from the chain; the animation runs on its own</div>` +
      `<div class="viz-line"><b>episode</b> ${episode.name} · <b>wave</b> ${ampShown.toFixed(3)} · ${dirTxt} · <b>bend</b> ${bendShown.toFixed(2)}</div>` +
      `<div class="viz-line"><b>anatomy</b> ${nN} neurons · ${eCount.toLocaleString("en-US")} directed synapses · real positions</div>` +
      `<div class="viz-line"><b>signals</b> ${N_PULSE} pulses running pre → post · ${firing} cells lit right now</div>` +
      `<div class="viz-line">drive, brightness and timing are synthetic — the animal's live state is on card 01</div>`;
  }

  // hover readout: which cell, what class, how strongly it is being driven
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
      tipEl.textContent = `${names[i]} · ${nb.cls ?? "unplaced"} · t ${nb.t ?? "—"} · demo drive ${(drive[i] * 100).toFixed(0)}%`;
      tipEl.style.opacity = "1";
    } else {
      tipEl.textContent = "";
      tipEl.style.opacity = "0";
    }
  });

  function resize() {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 420;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    // world-sized glow points need the device-pixel height and the vertical field of
    // view folded into one factor, or the halos shrink when the window does
    const half = (h * renderer.getPixelRatio()) / 2;
    haloMat.uniforms.uProj.value = half / Math.tan((camera.fov * Math.PI) / 360);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  writeBody(0, 0.28, 0.02);
  placeOrgans(0);
  writeNeurons(0, 0.016);
  writeSynapses();
  writePulses(0.016);
  start();

  return {
    stop() {
      stopLoop();
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      controls.dispose();
      bodyGeom.dispose();
      gutGeom.dispose();
      pharynxGeom.dispose();
      tailGeom.dispose();
      cord.geom.dispose();
      ringFibre.geom.dispose();
      synGeom.dispose();
      neuronGeom.dispose();
      haloGeom.dispose();
      pulseGeom.dispose();
      pgGeom.dispose();
      dustGeom.dispose();
      bodyMat.dispose();
      gutMat.dispose();
      pharynxMat.dispose();
      tailMat.dispose();
      bodyRimMat.dispose();
      memRimMat.dispose();
      synMat.dispose();
      neuronMat.dispose();
      pulseMatl.dispose();
      haloMat.dispose();
      dustMat.dispose();
      cordLine.material.dispose();
      ringLine.material.dispose();
      tex.dispose();
      renderer.dispose();
      hudEl.remove();
      tipEl.remove();
      renderer.domElement.remove();
    },
  };
}
