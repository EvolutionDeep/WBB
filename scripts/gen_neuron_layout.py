"""Generate a deterministic 3D anatomical layout for all 302 neurons.

This is an ARTISTIC APPROXIMATION of the real C. elegans wiring diagram, not
measured coordinates: each neuron gets a longitudinal position t in [0,1]
(nose -> tail), a dorsoventral offset dv and a laterolateral offset lr, decided
by its neuro-anatomical class (amphid sensory, ventral-cord motor, ring
interneuron, postdeirid ...) plus deterministic splitmix64 jitter so the output
is byte-reproducible like everything else in this repo.

The frontend consumes worm/data/neuron_layout.json and maps (t, dv, lr) onto
the animated body curve, so on-chain neuron index i can be highlighted 1:1.

Usage: python scripts/gen_neuron_layout.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
MASK64 = (1 << 64) - 1
SEED = 20261002


def mix64(x):
    """splitmix64, identical to brain_spec.mix64."""
    x = (x + 0x9E3779B97F4A7C15) & MASK64
    z = x
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
    return (z ^ (z >> 31)) & MASK64


def jitter(i, salt, lo, hi):
    """Deterministic float in [lo,hi) derived from neuron index."""
    u = mix64((i << 8) ^ salt ^ (SEED * 2654435761) & MASK64)
    return lo + (u >> 11) / float(1 << 53) * (hi - lo)


# Class ranges along the body axis, nose=0.0 -> tail=1.0. Values chosen from
# the classic White 1986 anatomy sketch (head ring, ventral cord, postdeirids).
CLASS_RANGES = {
    "sensor_head":  (0.00, 0.12),   # amphid/phasmid-like sensory organs cluster in the head
    "ring":         (0.06, 0.18),   # nerve ring interneurons (AVA-AVG, RIA-RIG...)
    "cord_motor":   (0.18, 0.72),   # ventral nerve cord motor neurons spread head->mid
    "cord_misc":    (0.15, 0.80),   # other elongated processes
    "midbody":      (0.35, 0.65),   # HSN, VC, DVC...
    "postdeirid":   (0.55, 0.95),   # Pxx tail neurons
    "tail":         (0.80, 1.00),   # PH, URA...
}

RE_MOTOR = re.compile(r"^(DA|DB|DD|VA|VB|VD)\d+")
RE_CORD = re.compile(r"^(AVL|AVA|AVB|AVD|AVE|AVF|AVG|PVC|PVA|LSD|FLP)")
RE_RING = re.compile(r"^(RIA|RIB|RIG|RIZ|RIS|RI[SZ]|AVAL|AVAR)")
RE_MID = re.compile(r"^(HSN|VC\d|DVC|PVM|PQ[LR])")
RE_POST = re.compile(r"^P[A-Z][LR]?$")           # PLM, PQR, PVQ...
RE_PHASM = re.compile(r"^(PH[LR]|SHA|SHP|SHT|UR[AB])")
RE_MECH = re.compile(r"^(ALM|PLM|PVR|PV[LR]?)")  # touch receptors: ALMs head, PLMs mid-tail


def classify(name, groups_by_name):
    """Return (cls, forced_t_or_None). Group members from the on-chain genome win."""
    if name in groups_by_name.get("SENSORS_ATTR", set()) | groups_by_name.get("SENSORS_OLI", set()) \
            | groups_by_name.get("SENSORS_AVERT", set()):
        return "sensor_head", None
    if name in groups_by_name.get("AWCL", set()) | groups_by_name.get("AWCR", set()) \
            | groups_by_name.get("AWAL", set()) | groups_by_name.get("AWAR", set()):
        return "sensor_head", None
    if name in groups_by_name.get("MOTOR_FWD", set()):
        return "cord_motor", None
    if name in groups_by_name.get("INTER_AVA", set()) | groups_by_name.get("INTER_AVB", set()) \
            | groups_by_name.get("TURN_IN", set()):
        return "ring", None
    if RE_MOTOR.match(name):
        return "cord_motor", None
    if RE_POST.match(name) or RE_PHASM.match(name):
        return "postdeirid" if RE_POST.match(name) else "tail", None
    if RE_MECH.match(name):
        # ALM touches near the head, PLM sits mid-body
        return ("sensor_head", None) if name.startswith("ALM") else ("postdeirid", 0.62)
    if RE_MID.match(name):
        return "midbody", None
    if RE_RING.match(name):
        return "ring", None
    if RE_CORD.match(name):
        return "cord_misc", None
    headish = re.match(r"^(AD|AF|AI|AIZ|ALA|ALN|AQR|A[SW]|ASE|ASH|ASI|BAG|BD|FLA|FLB|FR[AG]|GUR|I[ANOPSR]|LFS|OLQ|PFR|R[FGHIM]|SR[AD]|URX|UDU)", name)
    return ("sensor_head", None) if headish else ("cord_misc", None)


def main():
    W = json.loads((ROOT / "worm" / "data" / "brain_weights.json").read_text(encoding="utf-8"))
    names = W["names"]
    idx = {n: i for i, n in enumerate(names)}
    gset = {k: {names[i] for i in v} if isinstance(v, list) else {v and names[v] or None}
            for k, v in W["groups"].items()}
    # scalar group members (AWCL etc. are single indices)
    for k, v in W["groups"].items():
        if isinstance(v, int):
            gset[k] = {names[v]}

    out = []
    for i, name in enumerate(names):
        cls, forced_t = classify(name, gset)
        lo, hi = CLASS_RANGES[cls]
        t = forced_t if forced_t is not None else jitter(i, 0x11, lo, hi)
        # left/right partners (…L / …R) mirror across the midline
        lateral = jitter(i, 0x22, -1.0, 1.0)
        if name.endswith("L"):
            lateral = -abs(lateral)
        elif name.endswith("R"):
            lateral = abs(lateral)
        dv = jitter(i, 0x33, -1.0, 1.0)  # dorsoventral
        out.append({
            "name": name,
            "t": round(t, 4),
            "dv": round(dv * 0.55, 4),
            "lr": round(lateral * 0.45, 4),
            "size": round(0.7 + jitter(i, 0x44, 0.0, 0.6), 3),
            "cls": cls,
        })

    dest = ROOT / "worm" / "data" / "neuron_layout.json"
    dest.write_text(json.dumps({
        "note": "Deterministic artistic approximation of C. elegans neuron anatomy; "
                "t=0 nose, t=1 tail; dv dorsoventral, lr laterolateral, body radii units.",
        "seed": SEED,
        "neurons": out,
    }, indent=1), encoding="utf-8")
    counts = {}
    for o in out:
        counts[o["cls"]] = counts.get(o["cls"], 0) + 1
    print(f"302 neurons -> {dest}")
    print("class counts:", counts)


if __name__ == "__main__":
    main()
