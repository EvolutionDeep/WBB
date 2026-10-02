"""Step 4: compute on-chain genome parameters from the real Cook 2019 npz -> genome_args.json

Shared by deploy.js and the off-chain node: connectomeRoot must use one single
deterministic encoding, so that anyone holding the hash in WormGenome can
rebuild a byte-identical matrix using the same quantization rule.

Quantization: weight * SCALE rounded to int32 little-endian; W_chem and W_elec
are concatenated then keccak'd.
"""
import json
import numpy as np
from pathlib import Path
from Crypto.Hash import keccak  # pycryptodome

HERE = Path(__file__).parent
NPZ = HERE.parent.parent / "worm" / "data" / "connectome_cook2019.npz"
SCALE = 1000  # fixed point: 1/1000 of a weight unit

d = np.load(NPZ, allow_pickle=True)
W_chem = d["W_chem"].astype(np.float64)
W_elec = d["W_elec"].astype(np.float64)
neurons = [str(n) for n in d["neurons"]]


def q(mat):
    """Deterministic fixed-point quantization -> int32 little-endian bytes"""
    return np.round(mat * SCALE).astype("<i4").tobytes()


def keccak256(b: bytes) -> str:
    h = keccak.new(digest_bits=256)
    h.update(b)
    return "0x" + h.hexdigest()


connectome_root = keccak256(q(W_chem) + q(W_elec))
# commit the neuron name list too, so the ordering cannot be tampered with
names_root = keccak256((",".join(neurons)).encode("utf-8"))
source_hash = keccak256(b"Cook et al. 2019 via cect Cook2019Herm")

A = (W_chem != 0) | (W_elec != 0)
args = {
    "connectomeRoot": connectome_root,
    "namesRoot": names_root,
    "nNeurons": int(len(neurons)),
    "nEdges": int(A.sum()),
    "sourceHash": source_hash,
    "quantScale": SCALE,
    "note": "connectomeRoot = keccak(int32le(chem*1000) || int32le(elec*1000))",
}
(HERE.parent / "genome_args.json").write_text(json.dumps(args, indent=2), encoding="utf-8")
print(json.dumps(args, indent=2))
