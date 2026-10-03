// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IWormBrain} from "./IWormBrain.sol";
import {WormNeurons} from "./WormNeurons.sol";

interface ITokenLite {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title WormGuess -- a bet against the next beat of a real nervous system
/// @notice Stake on whether the worm's NEXT tick fires more than `threshold`
///         neurons. There is no house, no oracle, no referee and no operator: the
///         result is `totalSpikes()` read at exactly the tick the round was opened
///         for, which is a number the brain itself publishes.
/// @dev   THE SETTLEMENT SOURCE IS THE ANIMAL, NOT A CLAIM ABOUT THE ANIMAL:
///         WormBrainV2 emits Advanced(tick, fired, totalSpikes) and keeps
///         totalSpikes() as a monotonically growing public counter, so the spikes
///         produced by one single step are exactly the delta across that step. A
///         round is therefore bound to one tick and settles only when
///         `brain.tick() == targetTick`; reading the counter before and after that
///         one step cannot be spoofed, front-run or reinterpreted.
///
///       ANTI-PATTERN THIS DESIGN AVOIDS:
///         - no randomness, no committee, no price feed: a prediction market about
///           a deterministic-but-unpredictable system must not add a second trust
///           assumption;
///         - stakes close the moment the outcome becomes observable: joining is
///           only possible while `brain.tick() < targetTick`, so nobody can look at
///           the result first and then place the winning side;
///         - a skipped tick refunds instead of awarding. If the keeper advances more
///           than one step at a time, the round's exact tick never lands and the
///           pot is returned in full rather than gifted to whichever side happened
///           to be guessed -- a stalled or batching keeper can never pay itself.
///
///       TAXED TOKEN ACCOUNTING: the project token charges a transfer tax, so both
///       sides of every movement are measured as balanceOf deltas. Payouts are
///       pro-rata over what actually ARRIVED in the pot, and the amount a winner
///       really receives is emitted next to the amount owed. Nothing is ever
///       accounted at nominal value.
///
///       A PARTICIPANT CAN NUDGE THE OUTCOME, AND THAT IS DECLARED, NOT HIDDEN:
///       anyone may stimulate the worm, because that entry point is permissionless
///       by design, and stimuli change which neurons fire. That is part of the
///       game, not a flaw to patch: a bet is a wager about a system the bettor can
///       nudge but not control. The contract never calls stimulate() or advance()
///       itself -- it only reads.
contract WormGuess {
    /// @notice one tick can fire at most every neuron in the genome
    uint256 public constant MAX_FIRED = WormNeurons.N;

    uint8 public constant STATUS_OPEN = 0;
    uint8 public constant STATUS_SETTLED = 1;
    uint8 public constant STATUS_REFUNDED = 2;

    IWormBrain public immutable brain;
    ITokenLite public immutable token;
    /// @notice the amount that must ARRIVE for a stake to count, net of transfer tax
    uint256 public immutable minStake;

    struct Round {
        uint256 targetTick;  // the one and only tick this round is about
        uint256 threshold;   // YES wins if fired > threshold
        uint256 startSpikes; // totalSpikes() when the round was opened
        uint256 fired;       // spikes produced by targetTick, set at settlement
        uint256 yesStake;    // tokens arrived on the YES side
        uint256 noStake;     // tokens arrived on the NO side
        uint256 pot;         // yesStake + noStake, in tokens actually received
        uint64 openedBlock;
        uint8 status;
        bool yesWins;
    }

    struct Position {
        uint256 yes;
        uint256 no;
        bool claimed;
    }

    uint256 public roundCount;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => Position)) public positions;
    /// @dev one round per tick, so nobody can spam parallel rounds for the same beat
    mapping(uint256 => uint256) public roundIdForTick;

    event RoundCreated(uint256 indexed id, uint256 indexed targetTick, uint256 threshold, uint256 startSpikes);
    event Joined(uint256 indexed id, address indexed who, bool yes, uint256 nominal, uint256 arrived);
    event Settled(uint256 indexed id, uint256 indexed targetTick, uint256 fired, bool yesWins, uint8 status);
    event Expired(uint256 indexed id, uint256 indexed targetTick, uint256 nowTick);
    event Claimed(uint256 indexed id, address indexed who, uint256 owed, uint256 paid);

    constructor(address brain_, address token_, uint256 minStake_) {
        require(brain_ != address(0) && token_ != address(0), "zero addr");
        require(minStake_ > 0, "bad min stake");
        brain = IWormBrain(brain_);
        token = ITokenLite(token_);
        minStake = minStake_;
    }

    /// @notice Open a wager on the very next tick of the animal.
    function createRound(uint256 threshold) external returns (uint256 id) {
        require(threshold <= MAX_FIRED, "threshold out of range");
        uint256 t = brain.tick();
        require(t > 0, "brain not seeded");
        uint256 target = t + 1;
        require(roundIdForTick[target] == 0, "round for that tick exists");

        uint256 start = brain.totalSpikes();
        id = ++roundCount;
        roundIdForTick[target] = id;
        rounds[id] = Round({
            targetTick: target,
            threshold: threshold,
            startSpikes: start,
            fired: 0,
            yesStake: 0,
            noStake: 0,
            pot: 0,
            openedBlock: uint64(block.number),
            status: STATUS_OPEN,
            yesWins: false
        });
        emit RoundCreated(id, target, threshold, start);
    }

    /// @notice Stake on YES (fired > threshold) or NO. Only while the tick has not
    ///         happened yet -- after it happens, the side that is already correct is
    ///         simply closed to new money.
    function join(uint256 id, bool yes, uint256 nominal) external {
        Round storage r = rounds[id];
        require(r.targetTick != 0, "no such round");
        require(r.status == STATUS_OPEN, "round closed");
        require(brain.tick() < r.targetTick, "outcome already observable");
        require(nominal >= minStake, "stake below minimum");

        Position storage p = positions[id][msg.sender];
        require(yes ? p.no == 0 : p.yes == 0, "already on the other side");

        uint256 bal0 = token.balanceOf(address(this));
        require(token.transferFrom(msg.sender, address(this), nominal), "transferFrom failed");
        uint256 arrived = token.balanceOf(address(this)) - bal0;
        require(arrived >= minStake, "net stake below minimum");

        r.pot += arrived;
        if (yes) {
            r.yesStake += arrived;
            p.yes += arrived;
        } else {
            r.noStake += arrived;
            p.no += arrived;
        }
        emit Joined(id, msg.sender, yes, nominal, arrived);
    }

    /// @notice Settle a round against the animal's own counter. Callable by anyone;
    ///         the caller gains nothing, so settlement needs no trusted actor.
    function settle(uint256 id) external {
        Round storage r = rounds[id];
        require(r.status == STATUS_OPEN, "not open");
        require(brain.tick() == r.targetTick, "not that tick");

        uint256 fired = brain.totalSpikes() - r.startSpikes;
        r.fired = fired;
        r.yesWins = fired > r.threshold;

        // if nobody stands on the winning side there is no one to pay: hand the pot
        // back instead of letting it rot or awarding it to whoever was wrong
        uint256 winSide = r.yesWins ? r.yesStake : r.noStake;
        r.status = winSide == 0 ? STATUS_REFUNDED : STATUS_SETTLED;
        emit Settled(id, r.targetTick, fired, r.yesWins, r.status);
    }

    /// @notice The round's tick has been passed without anyone settling it.
    ///         settle() is only legal while tick == targetTick, so as soon as the
    ///         animal has moved on, that one step's firing count can no longer be
    ///         measured out of the cumulative totalSpikes: the round refunds.
    ///         A keeper that batches several steps into one tx cannot do it on BSC
    ///         (advance(2) needs ~19M gas, over the 2**24 per-tx ceiling), so the
    ///         reachable case is simply nobody showing up to settle in time -- the
    ///         stake-holders' money comes back either way, it is never re-dealt to
    ///         whichever side happens to call first.
    function expire(uint256 id) external {
        Round storage r = rounds[id];
        require(r.targetTick != 0, "no such round");
        require(r.status == STATUS_OPEN, "not open");
        uint256 nowTick = brain.tick();
        require(nowTick > r.targetTick, "tick has not been passed");
        r.status = STATUS_REFUNDED;
        emit Expired(id, r.targetTick, nowTick);
    }

    /// @notice Pull payout for one's own position. Winners take a pro-rata share of
    ///         the pot; everyone whose round was refunded takes back exactly what
    ///         they put in (measured net of tax, as always).
    function claim(uint256 id) external {
        Round storage r = rounds[id];
        require(r.status != STATUS_OPEN, "round still open");

        Position storage p = positions[id][msg.sender];
        require(!p.claimed, "claimed");
        uint256 mine = p.yes + p.no;
        require(mine > 0, "no stake");
        p.claimed = true; // effects before interaction: no re-enterable state remains

        uint256 owed;
        if (r.status == STATUS_REFUNDED) {
            owed = mine;
        } else {
            uint256 winSide = r.yesWins ? r.yesStake : r.noStake;
            uint256 mineWin = r.yesWins ? p.yes : p.no;
            owed = (r.pot * mineWin) / winSide;
        }
        if (owed == 0) {
            emit Claimed(id, msg.sender, 0, 0);
            return;
        }

        uint256 bal0 = token.balanceOf(msg.sender);
        require(token.transfer(msg.sender, owed), "transfer failed");
        uint256 paid = token.balanceOf(msg.sender) - bal0;
        emit Claimed(id, msg.sender, owed, paid);
    }

    // ---- read helpers for the frontend / off-chain verifiers ----

    function stakeOf(uint256 id, address who) external view returns (uint256 yes, uint256 no, bool claimed) {
        Position storage p = positions[id][who];
        return (p.yes, p.no, p.claimed);
    }

    /// @notice what a settled round says, straight from the animal's counter
    function resultOf(uint256 id) external view returns (bool decided, uint256 fired, bool yesWins, uint8 status) {
        Round storage r = rounds[id];
        status = r.status;
        fired = r.fired;
        yesWins = r.yesWins;
        decided = r.status != STATUS_OPEN;
    }

    /// @notice rounding dust that no claim can reach; shown so the page can be exact
    function unclaimed() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
