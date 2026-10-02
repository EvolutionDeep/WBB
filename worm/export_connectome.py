"""Step 2: export the "genome" files needed by the LIF prototype from cect's Cook 2019 data.

Outputs (worm/data/):
  - edge_list.csv            neuron-neuron edge table (pre, post, weight, syn_type)
  - connectome_cook2019.npz  302x302 chemical/electrical dense matrices + neuron names
  - meta.json                graph statistics (nodes/edges, degree distribution, hubs),
                             used for BNB Chain gas budgeting and stateRoot design
"""
import json
import csv
import numpy as np
from pathlib import Path

from cect.Utils import get_connectome_dataset
from cect.Cells import ALL_PREFERRED_NEURON_NAMES
from cect.Neurotransmitters import CHEMICAL_SYN_TYPE, ELECTRICAL_SYN_TYPE

OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)

cds = get_connectome_dataset("Cook2019Herm")

# keep only connections among the 302 neurons
neurons = sorted(n for n in cds.nodes if n in ALL_PREFERRED_NEURON_NAMES)
idx = {n: i for i, n in enumerate(neurons)}
N = len(neurons)

W_chem = np.zeros((N, N))
W_elec = np.zeros((N, N))
edges = []

for ci in cds.get_current_connection_info_list():
    pre, post = ci.pre_cell, ci.post_cell
    if pre in idx and post in idx:
        w = float(ci.number)
        if ci.syntype == CHEMICAL_SYN_TYPE:
            W_chem[idx[pre], idx[post]] += w
            edges.append((pre, post, w, "chemical"))
        elif ci.syntype == ELECTRICAL_SYN_TYPE:
            W_elec[idx[pre], idx[post]] += w
            edges.append((pre, post, w, "electrical"))

# ---- save ----
np.savez_compressed(
    OUT / "connectome_cook2019.npz",
    neurons=np.array(neurons), W_chem=W_chem, W_elec=W_elec,
)

with open(OUT / "edge_list.csv", "w", newline="", encoding="utf-8") as f:
    wr = csv.writer(f)
    wr.writerow(["pre", "post", "weight", "syn_type"])
    wr.writerows(edges)

# ---- graph stats (basis for the gas estimate) ----
A = (W_chem != 0) | (W_elec != 0)
degree_in = A.sum(axis=0)
out_rank = np.argsort(A.sum(axis=1))[::-1][:10]

meta = {
    "source": "Cook et al. 2019 (via cect Cook2019Herm)",
    "n_neurons": int(N),
    "n_edges_chem": int(len([e for e in edges if e[3] == "chemical"])),
    "n_edges_elec": int(len([e for e in edges if e[3] == "electrical"])),
    "density_pct": round(100.0 * A.sum() / (N * N), 2),
    "mean_in_degree": round(float(degree_in.mean()), 1),
    "top10_hubs_outdegree": [(neurons[i], int(A[i].sum())) for i in out_rank],
    "chem_weight_max": float(W_chem.max()),
    "elec_weight_max": float(W_elec.max()),
    "gas_estimate_note": (
        "approx "
        f"{int(A.sum())} nonzero mul-adds per tick; fixed-point mul+add ~10 gas => ~{int(A.sum())*10/1e6:.1f}M gas/tick order of magnitude"
    ),
}
with open(OUT / "meta.json", "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)

print(json.dumps(meta, ensure_ascii=False, indent=2))
print("\nwritten:", *(p.name for p in OUT.iterdir()))
