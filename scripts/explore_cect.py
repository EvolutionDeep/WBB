"""Step 1: load the Cook et al. 2019 hermaphrodite connectome via cect and print a structural summary.

Output: total node count, neuron/muscle classification, synapse connection counts,
chemical/electrical synapse breakdown. These numbers determine the scale of the
LIF prototype and the BNB Chain gas budget estimate.
"""
import cect
from cect.Utils import get_connectome_dataset

cds = get_connectome_dataset("Cook2019Herm")

print("dataset:", type(cds).__name__)
print("total nodes:", len(cds.nodes))
print("total connections:", len(cds.original_connection_infos))

# neuron-to-neuron connections
from cect import Cells
from cect.Cells import ALL_PREFERRED_NEURON_NAMES, BODY_WALL_MUSCLE_NAMES

n2n_result = cds.get_neuron_to_neuron_conns()
neuron_set, n2n = n2n_result if isinstance(n2n_result, tuple) else (None, n2n_result)
print("\nneuron->neuron connections:", len(n2n))

neurons = [n for n in cds.nodes if n in ALL_PREFERRED_NEURON_NAMES]
muscles = [n for n in cds.nodes if n in BODY_WALL_MUSCLE_NAMES]
others = [n for n in cds.nodes if n not in ALL_PREFERRED_NEURON_NAMES
          and n not in BODY_WALL_MUSCLE_NAMES]
print(f"\nnode classification: neurons {len(neurons)} | muscles {len(muscles)} | other {len(others)}")
print("example other cells:", others[:20])

# synapse class stats
from collections import Counter
synclasses = Counter(str(ci.synclass) for ci in n2n)
print("\nneuron-neuron synapse class breakdown:")
for s, c in synclasses.most_common():
    print(f"  {s:16s} {c}")
