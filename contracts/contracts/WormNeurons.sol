// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title WormNeurons -- the frozen C. elegans neuron index table
/// @notice The 302-wide state vectors (V/gate/stim/M/spikeCount) inside WormBrain
///         are indexed by the SORTED (alphabetical) list of the 302 Cook-2019
///         hermaphrodite preferred neuron names, exactly as emitted by
///         worm/export_connectome.py into worm/data/brain_weights.json ("names").
///         Only the 302 neurons are used: no 95 muscle cells, no 76 pharyngeal
///         cells, no male complement. Chemical vs electrical synapses are kept
///         separate in the genome and their signs come straight from the dataset
///         (GABAergic neurons carry the dataset sign) -- never hand-edited.
/// @dev   THESE INDICES ARE FROZEN. They are a property of the connectome that is
///        already seeded on-chain; changing one makes you stimulate a DIFFERENT
///        neuron than you name, i.e. a different animal. Do not edit any value.
///        Compiler provenance of the organism this table addresses:
///        solc 0.8.24, optimizer enabled runs=200, viaIR=true (see hardhat.config.js;
///        identical to WormBrain.sol). Swapping the compiler swaps the worm.
library WormNeurons {
    /// @dev number of neurons in the genome (Cook 2019 hermaphrodite)
    uint256 internal constant N = 302;

    // ---- Frozen somatic indices (0-based, per brain_weights.json "names") ----
    uint256 internal constant ASEL = 39;   // amphid chemoreceptor, left  (ON-food / attractant)
    uint256 internal constant ASER = 40;   // amphid chemoreceptor, right (away / repellant)
    uint256 internal constant AVAL = 53;   // backward-command interneuron, left
    uint256 internal constant AVAR = 54;   // backward-command interneuron, right
    uint256 internal constant AVBL = 55;   // forward-command interneuron,  left
    uint256 internal constant AVBR = 56;   // forward-command interneuron,  right
    uint256 internal constant AWAL = 72;   // amphid warm/odor sensory, left
    uint256 internal constant AWAR = 73;   // amphid warm/odor sensory, right
    uint256 internal constant AWCL = 76;   // amphid olfactory neuron, left
    uint256 internal constant AWCR = 77;   // amphid olfactory neuron, right
    uint256 internal constant PVCL = 172;  // motor/decussation, left ventral cord
    uint256 internal constant PVCR = 173;  // motor/decussation, right ventral cord

    /// @dev Q20 fixed-point scale, shared with the brain dynamics (1.0 == 1<<20)
    int256 internal constant SCALE = 1048576;
}
