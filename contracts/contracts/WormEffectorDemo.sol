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
/// @dev   The effector measures staleness from the animal's TICK, not from
///        read().blockNumber. That field is the height at read time, so comparing
///        it to the current block always yields ~0 and would call a dead worm
///        "fresh". A real consumer can only know the animal has stopped moving by
///        watching tick fail to advance between its own reads: here the effector
///        stores the block at which it last SAW the tick increase, and marks a
///        reading stale once that many blocks (STALE_WINDOW) have passed without
///        movement. It performs no stimulate and no advance itself.
contract WormEffectorDemo {
    WormReadout public immutable readout;

    struct Action {
        int16 approach;
        int16 turn;
        int16 speed;
        uint64 tick;
        uint64 blockNumber;
        bytes32 stateHash;
        bool fresh; // false => the animal has not advanced within STALE_WINDOW of the last observed tick change
    }

    Action public lastAction;
    bool public hasActed;
    uint64 public lastSeenTick;      // tick value at the last observed advance
    uint64 public lastAdvanceSeen;   // block at which the effector last saw the tick increase

    event Acted(int16 approach, int16 turn, int16 speed, uint64 tick, bool fresh);

    constructor(address readout_) {
        require(readout_ != address(0), "readout=0");
        readout = WormReadout(readout_);
    }

    /// @notice Read the animal from this contract's own address and record the action.
    ///         View-only on the brain: performs no stimulate, no advance.
    function act() external {
        WormReadout.Readout memory r = readout.read();
        // freshness = time since the effector last observed the tick change
        if (!hasActed || r.tick > lastSeenTick) {
            lastSeenTick = r.tick;
            lastAdvanceSeen = uint64(block.number);
        }
        bool fresh = (uint64(block.number) - lastAdvanceSeen) <= readout.STALE_WINDOW();
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
