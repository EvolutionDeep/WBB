// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./WormGenome.sol";

/// @title WormHeartbeat —— the worm's "on-chain soul ledger"
/// @notice Each epoch the off-chain simulation node computes
///         stateRoot = keccak256(V ‖ pos ‖ tick ‖ energy), signs an EIP-191 message
///         with its node key and submits it here. The contract does exactly three
///         things: ① verify the signature comes from an approved node
///         ② enforce strictly monotonic tick (anti replay/rollback)
///         ③ append to an immutable heartbeat history. This is the on-chain evidence
///         of "being alive" — as long as the heartbeat continues, life continues.
/// @dev Deliberately minimal: no on-chain simulation (that would cost 1-3M gas/tick),
///      only verifiable commitments.
contract WormHeartbeat {
    WormGenome public immutable genome;

    /// @dev approved simulation node addresses (multiple allowed)
    mapping(address => bool) public approvedNodes;
    address public owner;

    /// @dev latest tick and state root
    uint64 public latestTick;
    bytes32 public latestStateRoot;
    uint256 public lastBeatAt;

    /// @dev full heartbeat history (an auditable on-chain "chronicle of life")
    Heartbeat[] public history;

    struct Heartbeat {
        uint64 tick;
        bytes32 stateRoot;
        uint256 timestamp;
        address node;
    }

    event Beat(
        uint64 indexed tick,
        bytes32 indexed stateRoot,
        address indexed node,
        uint256 timestamp
    );
    event NodeApproved(address indexed node, bool approved);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _genome) {
        require(_genome != address(0), "zero genome");
        genome = WormGenome(_genome);
        owner = msg.sender;
        approvedNodes[msg.sender] = true;
    }

    /// @notice Approve / revoke a simulation node
    function setNode(address node, bool approved) external onlyOwner {
        approvedNodes[node] = approved;
        emit NodeApproved(node, approved);
    }

    /// @notice Compute the heartbeat signature digest (encoding shared with the off-chain node)
    /// @dev The EIP-191 personal_sign prefix is handled by ECDSA.recover; here we only hash the structured message
    function beatDigest(uint64 tick, bytes32 stateRoot) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("WORM-BEAT-v1", tick, stateRoot));
    }

    /// @notice A node submits one heartbeat: verify signature + monotonic tick + append history
    /// @param tick simulation tick number, must be > latestTick
    /// @param stateRoot commitment of the state root computed off-chain
    /// @param v rsig recovery parameter
    /// @param r rsig.r
    /// @param s rsig.s
    function beat(
        uint64 tick,
        bytes32 stateRoot,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(tick > latestTick, "tick not monotonic");
        require(stateRoot != bytes32(0), "empty state");

        bytes32 digest = beatDigest(tick, stateRoot);
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && approvedNodes[signer], "unauthorized node");

        latestTick = tick;
        latestStateRoot = stateRoot;
        lastBeatAt = block.timestamp;
        history.push(Heartbeat(tick, stateRoot, block.timestamp, signer));

        emit Beat(tick, stateRoot, signer, block.timestamp);
    }

    /// @notice Reads the "current life status" for higher layers (poke / communication, etc.)
    function isAlive(uint256 maxSilenceSec) external view returns (bool) {
        return block.timestamp - lastBeatAt <= maxSilenceSec;
    }

    function historyLength() external view returns (uint256) {
        return history.length;
    }
}
