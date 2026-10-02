// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WormReadout} from "./WormReadout.sol";

/// @title WormEffectorDemo -- proof that brain and business are separate contracts
/// @notice A SEPARATE consumer that reads the worm through WormReadout and records
///         its own decision as an on-chain action. The brain is NOT told what to do
///         with any market, and this effector never stimulates or advances the brain:
///         life (WormBrain) and business (this) are cleanly split.
/// @dev   The effector calls read() from its own address, applies the documented
///        staleness window (block.number - blockNumber <= STALE_WINDOW), and only
///        then keeps a snapshot as "the last action it took". It is a demonstration
///        of the read-side contract, not a trading bot: no order routing, no tokens,
///        no leverage -- those would be a different consumer built on the same lens.
contract WormEffectorDemo {
    WormReadout public immutable readout;

    struct Action {
        int16 approach;
        int16 turn;
        int16 speed;
        uint64 tick;
        uint64 blockNumber;
        bytes32 stateHash;
        bool fresh; // false => the readout was stale and is flagged, not silently used
    }

    Action public lastAction;
    bool public hasActed;

    event Acted(int16 approach, int16 turn, int16 speed, uint64 tick, bool fresh);

    constructor(address readout_) {
        require(readout_ != address(0), "readout=0");
        readout = WormReadout(readout_);
    }

    /// @notice Read the animal from this contract's own address and record the action.
    ///         View-only on the brain: performs no stimulate, no advance.
    function act() external {
        WormReadout.Readout memory r = readout.read();
        bool fresh = (block.number - r.blockNumber) <= readout.STALE_WINDOW();
        lastAction = Action({
            approach: r.approach,
            turn: r.turn,
            speed: r.speed,
            tick: r.tick,
            blockNumber: r.blockNumber,
            stateHash: r.stateHash,
            fresh: fresh
        });
        hasActed = true;
        emit Acted(r.approach, r.turn, r.speed, r.tick, fresh);
    }
}
