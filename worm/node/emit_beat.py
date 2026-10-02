"""Step 5: off-chain simulation node -> produce one heartbeat's stateRoot commitment.

Runs a few steps of the same LIF kernel as lif_worm.py and quantizes the final
neural state into a deterministic bytes32 commitment:
  stateRoot = keccak256(int16le(round(V*1000)) || int16le(pos*1000) || uint64 tick)
Anyone with WormGenome's connectomeRoot + the same seed can reproduce the same stateRoot.

Outputs worm/node/beat_payload.json, signed and submitted by submit_beat.js.
"""
import json
import numpy as np
from pathlib import Path
from Crypto.Hash import keccak

HERE = Path(__file__).parent
NPZ = HERE.parent / "data" / "connectome_cook2019.npz"

d = np.load(NPZ, allow_pickle=True)
names = [str(n) for n in d["neurons"]]
W_chem, W_elec = d["W_chem"], d["W_elec"]
N = len(names)
idx = {n: i for i, n in enumerate(names)}

import re
GABA = re.compile(r"^(D[BV]A|DB\d|AS\d+|DVA|R25|AVC)")
sign = np.array([-1.0 if GABA.match(n) else 1.0 for n in names])
S = W_chem * sign[:, None] + W_elec
S = S / np.maximum(np.abs(S).sum(axis=1, keepdims=True), 1e-6)

SENSORS = np.array([idx[n] for n in names if re.match(r"AWA[LR]|AWC[LR]", n)])
rng = np.random.default_rng(seed=20261002)
V = rng.uniform(0, 0.3, N)
gate = np.zeros(N)
pos = np.array([12.0, 10.0])
FOOD = np.array([62.0, 38.0]); LAM = 16.0
dt, STEPS = 0.02, 500  # run 10 seconds = tick 500

for step in range(STEPS):
    c = np.exp(-np.sum((pos - FOOD) ** 2) / (2 * LAM ** 2))
    I = np.zeros(N)
    I[SENSORS] += 2.4 * c
    I += rng.uniform(0, 0.35, N)
    gate += (-gate + np.maximum(V - 0.4, 0)) * dt / 0.4
    V += (-V + np.clip(2.2 * (S @ gate), -3, 3) + I) * dt / 0.25
    fired = V >= 0.62
    V[fired] -= 1.2
    V = np.clip(V, -2.5, 4.0)
    if step % 25 == 0:
        pos = pos + 0.18 * (0.25 + 0.75 * np.clip(gate.mean(), 0, 1)) * dt * np.array([1.0, 0.3])

def q16(x):
    return np.round(np.asarray(x, dtype=float) * 1000).astype("<i2").tobytes()

def k256(b):
    h = keccak.new(digest_bits=256); h.update(b); return "0x" + h.hexdigest()

tick = STEPS
state_root = k256(q16(V) + q16(pos) + np.uint64(tick).astype("<u8").tobytes())

payload = {
    "tick": int(tick),
    "stateRoot": state_root,
    "pos": [round(float(pos[0]), 3), round(float(pos[1]), 3)],
    "activeNeurons": int((V >= 0.3).sum()),
    "note": "stateRoot = keccak(int16le(V*1000)||int16le(pos*1000)||uint64(tick))",
}
(HERE / "beat_payload.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
print(json.dumps(payload, indent=2))
