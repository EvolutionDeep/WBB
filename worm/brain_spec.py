"""WormBrain integer deterministic spec (chain-canonical LIF + body + chemotaxis).

This is the authoritative spec that WormBrain.sol must reproduce byte-for-byte
inside the EVM:
  - All math is Q20 fixed point (SCALE = 1<<20), no floating point at all.
  - PRNG is splitmix64 (pure multiply/shift/xor, identical in Python and
    Solidity), replacing the numpy RNG from lif_worm.py which cannot be
    reproduced on-chain; deterministic seed SEED=20261002.
  - Trigonometry is replaced by a first-order small-angle vector rotation plus
    isqrt renormalization (heading changes minimally per step; first order suffices).
  - The odor concentration field uses a rational decay c = R2/(R2+d2)
    (replacing the Gaussian exp; no transcendental functions).

Model skeleton matches lif_worm.py:
  gate low-pass -> sparse weighted sum (S@gate) -> clip -> coupling gain
  -> add sensory input -> membrane leak+integrate -> threshold spike
  -> afterhyperpolarization + post-spike suppression -> clamp
  body: motor group readout -> drive -> speed/turn -> vector rotation
  -> position integration -> boundary clamp
  chemotaxis: sensory neurons are driven by concentration c and dcdt.

Outputs (worm/data/):
  - brain_weights.json  packed sparse connectome (src/dst/wq + neuron names +
                        group indices), loaded by the deploy scripts
  - brain_golden.json   golden trajectory of the first GOLDEN_STEPS steps
                        (stateHash per checkpoint + final state), asserted by hardhat

Run: python worm/brain_spec.py
"""
import json
import re
import math
import struct
import hashlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
DATA = HERE / "data"
DATA.mkdir(exist_ok=True)

# ---------------- Fixed-point constants (Q20) ----------------
S = 1 << 20                      # SCALE
MASK64 = (1 << 64) - 1
SEED = 20261002

def q(x):
    return int(round(x * S))

A_SYN  = q(0.02 / 0.4)           # dt/TAU_SYN = 0.05
A_MEM  = q(0.02 / 0.25)          # dt/TAU_MEM = 0.08
GATE_OFF = q(0.4)                # firing drive threshold (V-0.4)+
V_THRESH = q(0.62)
POST_SUP = q(1.2)                # post-spike suppression
I_CAP  = q(3.0)                  # I_net clamp
V_LO   = q(-2.5)
V_HI   = q(4.0)
GAIN   = q(2.6)                  # network coupling strength (scanned sweet spot: 284/302 neurons spontaneously active)
NOISE_AMP = q(0.9)               # background noise amplitude
STIM_DECAY = q(0.9)              # per-step decay factor of injected stimulus current
STIM_CAP   = q(8.0)              # per-neuron stimulus current cap

# ---- v2 memory trace (on-chain learning) ----
# Every stimulation writes a persistent per-neuron memory M (sensitization);
# M drives a chronic bias current (expression); every spike of that neuron
# erodes M (habituation). M never vanishes on its own: the worm remembers
# every touch for the rest of its on-chain life.
K_MEM  = q(0.25)                 # memory write gain: dM = K_MEM * amp
M_CAP  = q(2.0)                  # memory clamp (keeps the bias sub-threshold)
G_MEM  = q(0.25)                 # expression gain: I_sens += G_MEM * M  (max +-0.5)
M_SPIKE_DECAY = q(0.995)         # habituation: M *= 0.995 per spike of that neuron

# sensory gains
G_ATTR_C   = q(2.4)              # attractant sensing 2.4*c
G_ATTR_DC  = q(4.8)              # 0.6*dcdt*8 = 4.8*max(dcdt,0)
G_OLI      = q(1.1)              # 1.1*(1-c)
AVERT_TH   = q(0.95)             # top-overload threshold
G_AVERT    = q(6.0)

# body constants
ARENA_X = q(80.0)
ARENA_Y = q(50.0)
FOOD_X  = q(62.0)
FOOD_Y  = q(38.0)
R_FIELD = q(22.0)                # concentration decay scale R (mm)
POS_LO_X = q(0.5); POS_HI_X = q(79.5)
POS_LO_Y = q(0.5); POS_HI_Y = q(49.5)
F_SPEED = q(0.18)                # speed = 0.18*drive (mm/s)
DT      = q(0.02)                # step duration (for pos += speed*dt and continuous heading change)
TURN_CONT = q(0.4)               # heading += turn_cmd*dt*0.4
TURN_TH   = q(0.35)              # |turn_cmd| threshold that triggers discrete turns
KLIN_EPS  = q(0.0001)            # dcdt < -1e-4 test
DRIVE_BASE = S // 4              # 0.25
DRIVE_SPAN = 3 * S // 4          # 0.75
G_LU = q(0.9); G_LT = q(0.8)     # turn_cmd = 0.9*lr + 0.8*r_turn

GOLDEN_STEPS = 90

# ---------------- splitmix64 (deterministic, reproducible on-chain) ----------------
def mix64(x):
    x = (x + 0x9E3779B97F4A7C15) & MASK64
    z = x
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
    z = (z ^ (z >> 31)) & MASK64
    return z

def noise(step, i):
    """Background noise for sensory neurons -> [0, NOISE_AMP) in Q20, identical in Python/Solidity."""
    u = mix64(((step << 16) ^ i ^ SEED) & MASK64)
    return (u * NOISE_AMP) >> 64

def rand01(step, salt):
    u = mix64(((step << 16) ^ salt ^ (SEED * 2654435761)) & MASK64)
    return u

def clip(x, lo, hi):
    return lo if x < lo else (hi if x > hi else x)

def tdiv(a, b):
    """Truncating division toward zero, matching Solidity int256 '/' (Python // floors negatives, which would diverge)."""
    r = abs(a) // abs(b)
    return -r if (a < 0) ^ (b < 0) else r

# ---------------- Load connectome and quantize into sparse integer weights ----------------
d = np.load(DATA / "connectome_cook2019.npz", allow_pickle=True)
names = [str(n) for n in d["neurons"]]
# The exporter stores W_[pre, post] (row = presynaptic, col = postsynaptic).
W_chem, W_elec = d["W_chem"].astype(float), d["W_elec"].astype(float)
N = len(names)
idx = {n: i for i, n in enumerate(names)}

GABAERGIC = re.compile(r"^(D[BV]A|DB\d|AS\d+|DVA|R25|AVC)")
sign_chem = np.ones(N)
for i, n in enumerate(names):
    if GABAERGIC.match(n):
        sign_chem[i] = -1.0

# Transpose to Smat[post, pre] so Smat[j, i] is the signed weight of the real
# pre -> post synapse (row = postsynaptic receiver, col = presynaptic source).
# The chemical sign (GABAergic) belongs to the PRESYNAPTIC neuron = the column.
Smat = W_chem.T * sign_chem[None, :] + W_elec.T           # Smat[post, pre]: net connection pre->post
row_abs = np.abs(Smat).sum(axis=1, keepdims=True)         # per-POST sum of |in-weights|
Smat = Smat / np.maximum(row_abs, 1e-6)                   # row-normalize (each post's in-weights sum |w|=1)

# sparsify: wq = round(Smat[post,pre]*SCALE), keep nonzero in-edges (src=pre, dst=post)
SRC, DST, WQ = [], [], []
for j in range(N):            # j = postsynaptic (row)
    for i in range(N):        # i = presynaptic (col)
        wq = int(round(Smat[j, i] * S))
        if wq != 0:
            SRC.append(i); DST.append(j); WQ.append(wq)    # edge src=pre -> dst=post
E = len(SRC)

def grp(pat):
    return [idx[n] for n in names if re.match(pat, n)]

SENSORS_ATTR = grp(r"AWA[LR]|AWC[LR]")
SENSORS_AVERT = grp(r"ASH[LR]")
SENSORS_OLI = grp(r"ASI[LR]")
MOTOR_FWD = grp(r"(DA|VA|VB)\d+")
INTER_AVA = grp(r"AVA[LR]")
INTER_AVB = grp(r"AVB[LR]")
TURN_IN = grp(r"AIB[LR]|RIF[LR]|ADB[LR]")
AWCL, AWCR = idx["AWCL"], idx["AWCR"]
AWAL, AWAR = idx["AWAL"], idx["AWAR"]

# ---------------- State ----------------
class State:
    def __init__(self):
        self.V = [mix64((i * 2654435761 ^ SEED) & MASK64) % (q(0.3)) for i in range(N)]  # init in [0,0.3)
        self.gate = [0] * N
        self.spike = [0] * N
        self.stim = [0] * N              # injected external stimulus current (Q20), decays each step
        self.M = [0] * N                 # v2 persistent memory trace per neuron (Q20), written by stimulate
        # position: start at (12,10) mm; heading unit vector aimed at food (one-off float init)
        self.px = q(12.0); self.py = q(10.0)
        ang = math.atan2(float(FOOD_Y - self.py), float(FOOD_X - self.px))
        self.hx = int(round(math.cos(ang) * S))
        self.hy = int(round(math.sin(ang) * S))
        self.tick = 0
        self.cprev = self._conc(self.px, self.py)
        self.total_spikes = 0

    def _conc(self, px, py):
        dx = px - FOOD_X; dy = py - FOOD_Y
        d2 = (dx * dx + dy * dy) // S              # Q20 mm^2
        r2 = (R_FIELD * R_FIELD) // S              # Q20 mm^2
        return (S * r2) // (r2 + d2 + 1)

    def _w(self, v, signed=True):
        return int(v).to_bytes(32, "big", signed=signed)

    def encode_state(self):
        """Canonical encoding: 32-byte prefix + one 32-byte big-endian word per integer (byte-reproducible by Solidity sha256)."""
        buf = [b"WORM-BRAIN-v2".ljust(32, b"\x00")]
        for i in range(N):
            buf.append(self._w(self.V[i]))
        for i in range(N):
            buf.append(self._w(self.gate[i]))
        for i in range(N):
            buf.append(self._w(self.stim[i]))
        for i in range(N):
            buf.append(self._w(self.M[i]))
        buf.append(self._w(self.px)); buf.append(self._w(self.py))
        buf.append(self._w(self.hx)); buf.append(self._w(self.hy))
        buf.append(self._w(self.tick, signed=False))
        return b"".join(buf)

    def state_hash(self):
        return hashlib.sha256(self.encode_state()).hexdigest()

    def step(self):
        st = self.tick
        px, py = self.px, self.py
        c = self._conc(px, py)
        dcdt = c - self.cprev
        self.cprev = c

        # sensory input I_sens (incl. background noise)
        I_sens = [0] * N
        for i in SENSORS_ATTR:
            I_sens[i] += (G_ATTR_C * c) // S + (G_ATTR_DC * max(dcdt, 0)) // S
        for i in SENSORS_OLI:
            one_minus_c = S - c
            I_sens[i] += (G_OLI * one_minus_c) // S
        for i in SENSORS_AVERT:
            if c > AVERT_TH:
                I_sens[i] += (G_AVERT * (c - AVERT_TH)) // S
        for i in range(N):
            I_sens[i] += noise(st, i)
        # add injected external stimulus current (from stimulate), decayed at the end of this step
        for i in range(N):
            if self.stim[i]:
                I_sens[i] += self.stim[i]
        # v2 memory expression: persistent bias current from the memory trace
        for i in range(N):
            if self.M[i]:
                I_sens[i] += tdiv(G_MEM * self.M[i], S)

        # gate low-pass: gate += (-gate + (V-0.4)+) * dt/TAU_SYN
        for i in range(N):
            drive = self.V[i] - GATE_OFF
            if drive < 0:
                drive = 0
            self.gate[i] += tdiv((drive - self.gate[i]) * A_SYN, S)

        # I_net = GAIN * clip(S@gate); per-edge integer truncating sum (same value as the contract's sparse accumulation)
        acc = [0] * N
        for e in range(E):
            g = self.gate[SRC[e]]
            if g:
                acc[DST[e]] += tdiv(WQ[e] * g, S)
        for i in range(N):
            inet = clip(acc[i], -I_CAP, I_CAP)
            inet = tdiv(GAIN * inet, S)
            # membrane: V += (-V + I_net + I_sens) * dt/TAU_MEM
            self.V[i] += tdiv((inet + I_sens[i] - self.V[i]) * A_MEM, S)

        # spike + repolarize + clamp
        fired_any = 0
        for i in range(N):
            if self.V[i] >= V_THRESH:
                self.spike[i] += 1
                fired_any += 1
                self.V[i] -= POST_SUP
                # v2 habituation: every spike erodes this neuron's memory trace
                if self.M[i]:
                    self.M[i] = tdiv(self.M[i] * M_SPIKE_DECAY, S)
            self.V[i] = clip(self.V[i], V_LO, V_HI)
        self.total_spikes += fired_any

        # neuron group readout (mean of gate)
        def mean(lst):
            if not lst:
                return 0
            ssum = 0
            for i in lst:
                ssum += self.gate[i]
            return ssum // len(lst)

        r_fwd = mean(MOTOR_FWD)
        r_ava = mean(INTER_AVA)
        r_avb = mean(INTER_AVB)
        r_turn = mean(TURN_IN)

        # drive -> speed
        t = clip(r_fwd + r_avb // 2, 0, S)
        drive = DRIVE_BASE + tdiv(DRIVE_SPAN * t, S)
        speed = tdiv(F_SPEED * drive, S)                    # mm/s Q20
        step_len = tdiv(speed * DT, S)                     # displacement this step, mm Q20
        # position integration: pos += step_len * (hx,hy)
        self.px += tdiv(step_len * self.hx, S)
        self.py += tdiv(step_len * self.hy, S)

        # turning command
        lr = (self.gate[AWCL] + self.gate[AWCR]) - (self.gate[AWAL] + self.gate[AWAR])
        turn_cmd = tdiv(G_LU * lr, S) + tdiv(G_LT * r_turn, S)
        # continuous fine steering of heading: theta += turn_cmd*DT*TURN_CONT (first-order rotation)
        dth = tdiv(turn_cmd * DT * TURN_CONT, S * S)
        self._rotate(dth)
        # klinokinesis: when dcdt<0, occasionally take a discrete larger turn with small probability
        if dcdt < -KLIN_EPS:
            if (rand01(st, 7) % S) < (S // 50):             # p=0.02
                mag = q(0.15) + (rand01(st, 9) % (q(0.35)))  # [0.15,0.5) rad
                sgn = 1 if turn_cmd >= 0 else -1
                self._rotate(mag * sgn)

        # boundary clamp
        self.px = clip(self.px, POS_LO_X, POS_HI_X)
        self.py = clip(self.py, POS_LO_Y, POS_HI_Y)
        # stimulus current decay (already consumed this step)
        for i in range(N):
            if self.stim[i]:
                self.stim[i] = tdiv(self.stim[i] * STIM_DECAY, S)
        self.tick += 1

    def stimulate(self, i, amp):
        """External stimulation: inject current into neuron i (Q20); takes effect next step and decays beat by beat.
        v2: the touch also writes a persistent memory trace (sensitization) that outlives the current itself."""
        self.stim[i] = clip(self.stim[i] + amp, -STIM_CAP, STIM_CAP)
        self.M[i] = clip(self.M[i] + tdiv(K_MEM * amp, S), -M_CAP, M_CAP)

    def _rotate(self, dth):
        # first-order small-angle rotation (hx,hy) -> (hx - hy*dth, hy + hx*dth), then isqrt renormalize to unit length
        oldx = self.hx
        nhx = self.hx - tdiv(self.hy * dth, S)
        nhy = self.hy + tdiv(oldx * dth, S)
        l2 = nhx * nhx + nhy * nhy                          # Q40
        if l2 > 0:
            l = math.isqrt(l2)                              # Q20
            if l > 0:
                self.hx = tdiv(nhx * S, l)
                self.hy = tdiv(nhy * S, l)
        self._wrap()

    def _wrap(self):
        # guard against long-term drift of the vector out of range
        self.hx = clip(self.hx, -S, S)
        self.hy = clip(self.hy, -S, S)


def run(steps, collect_every=1, stimuli=None):
    """stimuli: dict {beforeStep:int -> (neuronIdx, ampFloat)}, injected before the given step."""
    stimuli = stimuli or {}
    s = State()
    trace = []
    dist0 = None
    for k in range(steps):
        if k in stimuli:
            i, amp = stimuli[k]
            s.stimulate(i, q(amp))
        s.step()
        if k % collect_every == 0:
            dx = (s.px - FOOD_X) // S
            dy = (s.py - FOOD_Y) // S
            dist = math.isqrt(dx * dx + dy * dy)
            if dist0 is None:
                dist0 = dist
            trace.append({
                "tick": s.tick,
                "stateHash": s.state_hash(),
                "totalSpikes": s.total_spikes,
                "distMM": dist,
                "px": s.px, "py": s.py,
            })
    return s, trace


def dump_weights():
    out = {
        "scale": S,
        "nNeurons": N,
        "names": names,
        "nEdges": E,
        "src": SRC, "dst": DST, "wq": WQ,
        "groups": {
            "SENSORS_ATTR": SENSORS_ATTR, "SENSORS_AVERT": SENSORS_AVERT,
            "SENSORS_OLI": SENSORS_OLI, "MOTOR_FWD": MOTOR_FWD,
            "INTER_AVA": INTER_AVA, "INTER_AVB": INTER_AVB, "TURN_IN": TURN_IN,
            "AWCL": AWCL, "AWCR": AWCR, "AWAL": AWAL, "AWAR": AWAR,
        },
        "init": {
            "V": State().V,
            "gate": [0] * N,
            "stim": [0] * N,
            "px": q(12.0), "py": q(10.0),
        },
        "consts": {
            "SCALE": S, "A_SYN": A_SYN, "A_MEM": A_MEM, "GATE_OFF": GATE_OFF,
            "V_THRESH": V_THRESH, "POST_SUP": POST_SUP, "I_CAP": I_CAP,
            "V_LO": V_LO, "V_HI": V_HI, "GAIN": GAIN, "NOISE_AMP": NOISE_AMP,
            "STIM_DECAY": STIM_DECAY, "STIM_CAP": STIM_CAP,
            "K_MEM": K_MEM, "M_CAP": M_CAP, "G_MEM": G_MEM, "M_SPIKE_DECAY": M_SPIKE_DECAY,
            "G_ATTR_C": G_ATTR_C, "G_ATTR_DC": G_ATTR_DC, "G_OLI": G_OLI,
            "AVERT_TH": AVERT_TH, "G_AVERT": G_AVERT,
            "FOOD_X": FOOD_X, "FOOD_Y": FOOD_Y, "R_FIELD": R_FIELD,
            "POS_LO_X": POS_LO_X, "POS_HI_X": POS_HI_X,
            "POS_LO_Y": POS_LO_Y, "POS_HI_Y": POS_HI_Y,
            "F_SPEED": F_SPEED, "DT": DT, "TURN_CONT": TURN_CONT,
            "G_LU": G_LU, "G_LT": G_LT, "DRIVE_BASE": DRIVE_BASE,
            "DRIVE_SPAN": DRIVE_SPAN, "SEED": SEED,
        },
    }
    # initial heading vector (consistent with State, for contract construction)
    s0 = State()
    out["init"]["hx"] = s0.hx
    out["init"]["hy"] = s0.hy
    # pack connectome: per edge src(2B BE)+dst(2B BE)+wq(4B BE signed), parsed byte-by-byte by the contract
    blob = bytearray()
    for e in range(E):
        blob += SRC[e].to_bytes(2, "big") + DST[e].to_bytes(2, "big") + struct.pack(">i", WQ[e])
    out["blob"] = "0x" + bytes(blob).hex()
    (DATA / "brain_weights.json").write_text(json.dumps(out), encoding="utf-8")
    return out


def check_direction():
    """Guard against the historical transpose bug: the packed (src,dst) triples must
    follow the raw connectome table's pre->post orientation, not its reverse. The
    Python<->Solidity golden test cannot catch a shared reversal, so we assert here."""
    import csv
    packed = set(zip(SRC, DST))
    rows = list(csv.DictReader((DATA / "edge_list.csv").open(encoding="utf-8")))
    chem = {(r["pre"], r["post"]) for r in rows if r["syn_type"] == "chemical"}
    uni = [(p, q) for (p, q) in chem if (q, p) not in chem]          # truly unidirectional chem edges
    correct = sum(1 for p, q in uni if (idx[p], idx[q]) in packed)   # pre->post present
    reversed_ = sum(1 for p, q in uni if (idx[q], idx[p]) in packed)  # post->pre present
    print(f"[direction] unidirectional chem edges={len(uni)} correct(pre->post)={correct} reversed={reversed_}")
    assert len(uni) == 0 or correct > reversed_, f"orientation looks reversed (correct={correct} reversed={reversed_})"
    assert len(uni) == 0 or correct >= 0.99 * len(uni), "orientation sanity failed"
    return correct, reversed_


def main():
    check_direction()
    w = dump_weights()
    print(f"neurons={N} edges={E}")
    AVAR = idx.get("AVAR", INTER_AVA[0] if INTER_AVA else 0)
    schedule = {60: (AVAR, 3.0)}                 # inject current 3.0 into hub neuron AVAR before step 60
    s, trace = run(GOLDEN_STEPS, collect_every=30, stimuli=schedule)
    early = trace[: max(1, len(trace) // 4)]
    late = trace[-max(1, len(trace) // 4):]
    d0 = sum(t["distMM"] for t in early) / len(early)
    d1 = sum(t["distMM"] for t in late) / len(late)
    checkpoints = [t for t in trace]
    golden = {
        "steps": GOLDEN_STEPS,
        "checkpointsEvery": 30,
        "stimuli": [{"beforeStep": k, "idx": i, "ampQ": q(a)} for k, (i, a) in schedule.items()],
        "init": w["init"],
        "consts": w["consts"],
        "finalStateHash": s.state_hash(),
        "finalTick": s.tick,
        "finalTotalSpikes": s.total_spikes,
        "finalPos": [s.px, s.py],
        "finalHeading": [s.hx, s.hy],
        "finalV": s.V,
        "finalGate": s.gate,
        "finalStim": s.stim,
        "finalM": s.M,
        "finalSpike": s.spike,
        "spikingNeurons": sum(1 for x in s.spike if x > 0),
        "memoryNeurons": sum(1 for x in s.M if x != 0),
        "approach": {"earlyDist": d0, "lateDist": d1, "ratio": d0 / max(d1, 1)},
        "checkpoints": checkpoints,
    }
    (DATA / "brain_golden.json").write_text(json.dumps(golden), encoding="utf-8")
    print(json.dumps({k: golden[k] for k in
                      ("finalStateHash", "finalTick", "finalTotalSpikes",
                       "spikingNeurons", "memoryNeurons", "approach")}, indent=2))
    print("\ngolden trajectory -> worm/data/brain_golden.json ; connectome -> worm/data/brain_weights.json")


if __name__ == "__main__":
    main()
