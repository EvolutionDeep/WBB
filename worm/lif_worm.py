"""Step 3: minimal LIF (leaky integrate-and-fire) worm prototype.

Three layers (mirroring OpenWorm's c302 + simplified Sibernetic):
  1. Neural network: the real Cook 2019 connectome (302 neurons, 5146 edges)
     - chemical synapse sign comes from the presynaptic transmitter
       (GABAergic = inhibitory, others = excitatory)
     - electrical synapses (gap junctions) are always coupling terms
  2. Body: 2D kinematics -- traveling curvature wave drives undulation,
     frequency/amplitude modulated by motor neuron group activity
  3. Environment: Gaussian salt concentration field; head chemosensory
     neurons (AWA/AWC/ASH/ASI) receive concentration c and rate dC/dt
     -> check whether positive chemotaxis emerges (walking toward the food)

Run: python worm/lif_worm.py    outputs worm/out/*.png
"""
import re
import json
import hashlib
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

# ---------------- 1. load the genome ----------------
d = np.load(HERE / "data" / "connectome_cook2019.npz", allow_pickle=True)
names = [str(n) for n in d["neurons"]]
W_chem, W_elec = d["W_chem"], d["W_elec"]
N = len(names)
idx = {n: i for i, n in enumerate(names)}

# presynaptic transmitter -> sign (simplified WormAtlas consensus: GABAergic inhibitory, others excitatory)
GABAERGIC = re.compile(r"^(D[BV]A|DB\d|AS\d+|DVA|R25|AVC)")  # DB/AS/DVA etc. GABAergic
sign_chem = np.ones(N)
for i, n in enumerate(names):
    if GABAERGIC.match(n):
        sign_chem[i] = -1.0

# signed coupling matrix: S[j,i] = net connection i->j
S = W_chem * sign_chem[:, None] + W_elec
row_abs = np.abs(S).sum(axis=1, keepdims=True)
S = S / np.maximum(row_abs, 1e-6)          # row-normalize to prevent blow-up
GAIN_COUPLING = 2.2                        # network coupling strength

rng = np.random.default_rng(seed=20261002)  # deterministic seed -> reproducible

V_peak = 0.0

# ---------------- 2. neuron parameters (c302-style LIF) ----------------
TAU_MEM = 0.25      # membrane time constant s
TAU_SYN = 0.4       # synaptic gate time constant s
V_THRESH = 0.62
V_RESET = 0.0
dt = 0.02           # 50 Hz simulation
T_END = 900.0       # simulate 900 s (15 minutes)
NT = int(T_END / dt)

V = rng.uniform(0.0, 0.3, N)
syn_gate = np.zeros(N)        # low-passed firing rate
spike_count = np.zeros(N)

def i_e_and_fire(V):
    fire = V >= V_THRESH
    return fire

# sensory / motor neuron group indices
def grp(pat):
    return np.array([idx[n] for n in names if re.match(pat, n)])

SENSORS_ATTR = grp(r"AWA[LR]|AWC[LR]")          # attractant sensing
SENSORS_AVERT = grp(r"ASH[LR]")                  # high-concentration nociception
SENSORS_OLI = grp(r"ASI[LR]")                    # O2 / food state
MOTOR_FWD = grp(r"(DA|VA|VB)\d+")               # cholinergic excitatory motor neurons
MOTOR_GABA = grp(r"(AS\d+|DB\d+)")              # GABAergic motor neurons
INTER_AVA = grp(r"AVA[LR]")
INTER_AVB = grp(r"AVB[LR]")
TURN_IN = grp(r"AIB[LR]|RIF[LR]|ADB[LR]")

# ---------------- 3. environment ----------------
ARENA = (80.0, 50.0)                    # mm
FOOD = np.array([62.0, 38.0])           # food source location
LAMBDA = 16.0                           # concentration decay scale

def conc(p):
    return np.exp(-np.sum((p - FOOD) ** 2) / (2 * LAMBDA ** 2))

# body: head position + heading angle + undulation phase
pos = np.array([12.0, 10.0])
heading = np.arctan2(*(FOOD - pos)[::-1]) + rng.uniform(-0.6, 0.6)
phase = 0.0

traj, times = [], []
dist_hist, drive_hist, turn_hist = [], [], []
state_roots = []          # deterministic state commitment every 500 steps (the future on-chain heartbeat)
turn_events = 0
spike_events = []       # (t, neuron index) stream of real spike events

c_prev = conc(pos)
for step in range(NT):
    t = step * dt

    # ---- sensory input ----
    c = conc(pos)
    dcdt = (c - c_prev) / dt
    c_prev = c
    I_sens = np.zeros(N)
    I_sens[SENSORS_ATTR] += 2.4 * c + 0.6 * max(dcdt, 0.0) * 8.0
    I_sens[SENSORS_OLI] += 1.1 * (1.0 - c)
    I_sens[SENSORS_AVERT] += max(0.0, (c - 0.95)) * 6.0     # top overload -> escape
    I_sens += rng.uniform(0.0, 0.35, N)                      # background noise

    # ---- LIF network dynamics ----
    syn_gate += (-syn_gate + np.maximum(V - 0.4, 0.0)) * dt / TAU_SYN
    I_net = GAIN_COUPLING * (S @ syn_gate)
    V += (-V + np.clip(I_net, -3, 3) + I_sens) * dt / TAU_MEM
    fired = i_e_and_fire(V)
    spike_count[fired] += 1.0
    if fired.any():
        spike_events.extend((t, i) for i in np.nonzero(fired)[0])
    V[fired] = V[fired] - V_RESET - 1.2       # repolarize + post-spike suppression
    V = np.clip(V, -2.5, 4.0)
    V_peak = max(V_peak, float(V.max()))

    # ---- neuron group readout ----
    r_fwd = syn_gate[MOTOR_FWD].mean() if len(MOTOR_FWD) else 0.0
    r_ava = syn_gate[INTER_AVA].mean()
    r_avb = syn_gate[INTER_AVB].mean()
    r_turn = syn_gate[TURN_IN].mean() if len(TURN_IN) else 0.0

    # ---- body layer: traveling-wave undulation ----
    move_drive = 0.25 + 0.75 * np.clip(r_fwd + 0.5 * r_avb, 0, 1)
    freq = 0.7 + 1.8 * move_drive             # Hz
    amp = 1.2 * move_drive                    # mm curvature amplitude
    phase += freq * dt
    speed = 0.18 * move_drive                 # mm/s (real C. elegans ~0.2 mm/s)
    s_path = phase * 2 * np.pi
    curve = amp * np.sin(s_path) * 0.9

    # turn command: left/right receptor asymmetry + interneurons + klinokinesis
    left_right = (syn_gate[idx["AWCL"]] + syn_gate[idx["AWCR"]]) - \
                 (syn_gate[idx["AWAL"]] + syn_gate[idx["AWAR"]])
    turn_cmd = 0.9 * left_right + 0.8 * r_turn
    # dC/dt<0 -> raise turn probability (klinokinesis, biologically plausible)
    if dcdt < -1e-4:
        turn_cmd += 0.5 + rng.random() * r_ava
    if abs(turn_cmd) > 0.35 and rng.random() < 0.02:
        heading += np.sign(turn_cmd) * rng.uniform(0.15, 0.5)
        turn_events += 1
    heading += turn_cmd * dt * 0.4

    pos = pos + speed * dt * np.array([np.cos(heading), np.sin(heading)])
    pos = np.clip(pos, [0.5, 0.5], [ARENA[0] - 0.5, ARENA[1] - 0.5])
    _ = curve  # curvature kept as a rendering param (for future body visualization)

    if step % 25 == 0:
        traj.append(pos.copy()); times.append(t)
        dist_hist.append(np.linalg.norm(pos - FOOD))
        drive_hist.append(move_drive); turn_hist.append(abs(turn_cmd))

    if step % 500 == 0:  # state commitment: hash of neuron voltages (future stateRoot into the contract)
        blob = np.round(V, 3).tobytes() + pos.tobytes() + np.array([step]).tobytes()
        state_roots.append((t, hashlib.sha256(blob).hexdigest()[:16]))

traj = np.array(traj)

# ---------------- 4. validation & output ----------------
first_quartile = dist_hist[: len(dist_hist) // 4]
last_quartile = dist_hist[-len(dist_hist) // 4:]
mean_d0, mean_d1 = np.mean(first_quartile), np.mean(last_quartile)

summary = {
    "sim_seconds": T_END, "neurons": N, "edges": int(((W_chem != 0) | (W_elec != 0)).sum()),
    "total_spikes": int(spike_count.sum()),
    "peak_V": round(V_peak, 3),
    "neurons_with_spikes": int((spike_count > 0).sum()),
    "mean_dist_early_mm": round(float(mean_d0), 2),
    "mean_dist_late_mm": round(float(mean_d1), 2),
    "approach_ratio": round(float(mean_d0 / max(mean_d1, 1e-6)), 2),
    "turn_events": int(turn_events),
    "final_dist_mm": round(float(dist_hist[-1]), 2),
    "top_spiking_neurons": [
        (names[i], int(spike_count[i]))
        for i in np.argsort(spike_count)[::-1][:10] if spike_count[i] > 0
    ],
    "state_root_samples": len(state_roots),
    "example_state_roots": state_roots[:3],
}
print(json.dumps(summary, indent=2, ensure_ascii=False))
(OUT / "run_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

# figure 1: trajectory + concentration field
fig, ax = plt.subplots(figsize=(9, 5.5))
gx = np.linspace(0, ARENA[0], 80); gy = np.linspace(0, ARENA[1], 50)
C = np.exp(-((gx[None, :] - FOOD[0]) ** 2 + (gy[:, None] - FOOD[1]) ** 2) / (2 * LAMBDA ** 2))
ax.contourf(gx, gy, C, levels=14, cmap="YlOrBr", alpha=0.85)
sc = ax.scatter(traj[:, 0], traj[:, 1], c=np.array(times), cmap="viridis", s=14)
ax.plot(traj[0, 0], traj[0, 1], "wo", ms=9, mec="k", label="start")
ax.plot(*FOOD, "r*", ms=18, label="food (salt)")
plt.colorbar(sc, ax=ax, label="time (s)")
ax.set_title("LIF C. elegans on Cook-2019 connectome: chemotaxis trajectory")
ax.legend(); ax.set_aspect("equal"); fig.tight_layout()
fig.savefig(OUT / "trajectory.png", dpi=130); plt.close(fig)

# figure 2: distance over time + turning
fig, (a1, a2) = plt.subplots(2, 1, figsize=(9, 6), sharex=True)
a1.plot(times, dist_hist, lw=1.5, color="tab:red")
a1.set_ylabel("distance to food (mm)"); a1.grid(alpha=0.3)
a1.set_title("Approach behaviour (klinokinesis from dC/dt)")
a2.plot(times, turn_hist, lw=1.0, color="tab:blue", alpha=0.8)
a2.set_ylabel("turn command |.|"); a2.set_xlabel("t (s)"); a2.grid(alpha=0.3)
fig.tight_layout(); fig.savefig(OUT / "distance.png", dpi=130); plt.close(fig)

# figure 3: spike raster of the top neurons (real firing times)
top = np.argsort(spike_count)[::-1][:12]
top_pos = {i: row for row, i in enumerate(top)}
fig, ax = plt.subplots(figsize=(9, 4.5))
for t, i in spike_events:
    if i in top_pos:
        ax.scatter(t, top_pos[i], s=3, color="k")
ax.set_yticks(range(len(top)), [names[i] for i in top])
ax.invert_yaxis(); ax.set_xlabel("t (s)")
ax.set_title("Top-12 neurons: real spike rasters (Cook-2019 LIF network)")
fig.tight_layout(); fig.savefig(OUT / "raster.png", dpi=130); plt.close(fig)

print("\nfigures written -> worm/out/{trajectory,distance,raster}.png")
