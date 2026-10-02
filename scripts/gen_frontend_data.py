"""Emit the static connectome graph the 3D frontend needs.

Reads worm/data/brain_weights.json (built by worm/brain_spec.py) and writes
frontend/public/data/graph.json: neuron names in contract index order, the
edge list as [src, dst, wq] triples and the Q20 constants the HUD uses.
Deterministic: same weights file -> byte-identical graph.json.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "worm", "data", "brain_weights.json")
OUT_DIR = os.path.join(ROOT, "frontend", "public", "data")
OUT = os.path.join(OUT_DIR, "graph.json")

with open(SRC, "r", encoding="utf-8") as f:
    bw = json.load(f)

n = bw["nNeurons"]
names = bw["names"]
src, dst, wq = bw["src"], bw["dst"], bw["wq"]
assert len(src) == len(dst) == len(wq) == bw["nEdges"], "edge arrays out of sync"
assert len(names) == n == 302, "expected 302 neurons"

consts = bw["consts"]
graph = {
    "nNeurons": n,
    "names": names,
    "edges": [[int(s), int(d), int(w)] for s, d, w in zip(src, dst, wq)],
    "consts": {
        "SCALE": consts.get("SCALE", 1048576),
        "V_THRESH": consts["V_THRESH"],
        "V_LO": consts["V_LO"],
        "V_HI": consts["V_HI"],
        "FOOD_X": consts["FOOD_X"],
        "FOOD_Y": consts["FOOD_Y"],
        "POS_LO_X": consts.get("POS_LO_X"),
        "POS_HI_X": consts.get("POS_HI_X"),
        "POS_LO_Y": consts.get("POS_LO_Y"),
        "POS_HI_Y": consts.get("POS_HI_Y"),
    },
}

os.makedirs(OUT_DIR, exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(graph, f, separators=(",", ":"))

print(f"graph.json: {n} neurons, {len(graph['edges'])} edges -> {OUT}")
