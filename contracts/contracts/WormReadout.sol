// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IWormBrain} from "./IWormBrain.sol";
import {WormNeurons} from "./WormNeurons.sol";

/// @title WormReadout -- three fresh, bounded movement quantities from the live worm
/// @notice A READ-ONLY lens on the on-chain animal. read() is a pure function of
///         on-chain gate values: it writes nothing, computes no brain step, and
///         trusts no off-chain number. It returns exactly three signed quantities
///         plus provenance -- deliberately NOT the 302-wide voltage vector.
/// @dev   This is the agreed INTERFACE for how consumers read the animal; it is a
///        small, stable subset, not the worm's full motor circuit. Every quantity is
///        a difference of named-neuron gates (the low-passed firing drive), scaled
///        from Q20 to basis points and clamped to [-10000, 10000]:
///          approach = gate(ASEL) - gate(ASER)                     (left vs right chemoreceptor)
///          turn     = gate(AWCL) + gate(AWCR) - gate(AWAL) - gate(AWAR)  (left vs right head)
///          speed    = gate(AVBL) + gate(AVBR) - gate(AVAL) - gate(AVAR)  (forward vs backward command)
///        No group means, no scan of the 32 motor neurons, no touch of the mainnet
///        world-line. The worm keeps living on its own; this contract only observes.
///
///        STALENESS: read().blockNumber is the chain height AT READ TIME -- it is
///        provenance, NOT a liveness clock. Because it is captured in the same call
///        it is returned in, `block.number - blockNumber` is always ~0 and can never
///        tell you how long the animal has been idle. The animal only changes state
///        on advance(); to detect a stalled one a consumer must watch `tick` (or the
///        Advanced event block) FAIL to change for more than STALE_WINDOW blocks, or
///        scan the chain for the last Advanced log. stateHash() ties a reading to
///        the exact on-chain state it came from, so it is verifiable.
contract WormReadout {
    IWormBrain public immutable brain;

    struct Readout {
        int16 approach;     // -10000..10000, ASEL minus ASER (approach vs avoid)
        int16 turn;         // left minus right head turning
        int16 speed;        // forward (AVB) minus backward (AVA) drive
        uint64 tick;        // the worm's step counter at read time
        uint64 blockNumber; // chain height at read time -- provenance only, NOT a staleness clock
        bytes32 stateHash;  // brain.stateHash() at read time -- provable provenance
    }

    /// @dev one full unit (Q20 1.0) of gate asymmetry maps to the +-10000 cap
    int256 private constant FULL_BP = 10000;

    /// @notice blockNumber staleness window advertised to consumers
    uint64 public constant STALE_WINDOW = 20;

    constructor(address brain_) {
        require(brain_ != address(0), "brain=0");
        brain = IWormBrain(brain_);
    }

    /// @notice Read the animal. Pure view: reads on-chain gates only, mutates nothing.
    function read() external view returns (Readout memory r) {
        r.approach = _toBp(brain.gate(WormNeurons.ASEL) - brain.gate(WormNeurons.ASER));
        r.turn = _toBp(
            (brain.gate(WormNeurons.AWCL) + brain.gate(WormNeurons.AWCR)) -
            (brain.gate(WormNeurons.AWAL) + brain.gate(WormNeurons.AWAR))
        );
        r.speed = _toBp(
            (brain.gate(WormNeurons.AVBL) + brain.gate(WormNeurons.AVBR)) -
            (brain.gate(WormNeurons.AVAL) + brain.gate(WormNeurons.AVAR))
        );
        r.tick = uint64(brain.tick());
        r.blockNumber = uint64(block.number);
        r.stateHash = brain.stateHash();
    }

    /// @dev Map a signed Q20 gate asymmetry to basis points in [-10000, 10000].
    ///      Division truncates toward zero (Solidity int256 '/'), matching the
    ///      integer semantics the brain itself is built on.
    function _toBp(int256 q20) private pure returns (int16) {
        int256 bp = (q20 * FULL_BP) / WormNeurons.SCALE;
        if (bp > FULL_BP) bp = FULL_BP;
        if (bp < -FULL_BP) bp = -FULL_BP;
        return int16(bp);
    }
}
