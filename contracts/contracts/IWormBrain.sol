// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IWormBrain -- the call surface of the already-live on-chain worm
/// @notice This interface MIRRORS THE EXACT SELECTORS of the deployed WormBrainV2
///         so other protocols can bind to the SAME organism without redeploying or
///         upgrading it. There is deliberately NO upgrade path, NO owner, NO pause:
///         the connectome was seeded once and cannot be replaced.
/// @dev   WHY uint256 AND NOT uint16 FOR THE NEURON INDEX:
///        the live genome exposes its per-neuron arrays through the auto-generated
///        public getters V(uint256)/gate(uint256)/stim(uint256)/spikeCount(uint256)
///        and stimulate(uint256,int256)/advance(uint256,bytes). A uint16 signature
///        would hash to a DIFFERENT 4-byte selector and could not bind to the
///        deployed contract. "Freeze the selectors" here therefore means "match the
///        deployment", so this file uses uint256. Index range is still 0..301 and is
///        re-checked by the contract (idx < N), which reverts on out-of-range.
///
///      LIFE-CRITICAL RULES THE IMPLEMENTER ALREADY HONORS (do not re-implement):
///        - advance() is permissionless: anyone keeps the animal alive, paying gas;
///        - advance() reverts unless keccak256(connBlob)==connRoot AND 0 < n <= 500
///          (n stays bounded on purpose: one cold step is ~8.6M gas already);
///        - stimulate() ONLY accumulates current into stim[idx] (a block-scope ADD,
///          never an overwrite) up to a hard cap; it takes effect on the NEXT step
///          and decays every step -- it NEVER recomputes the brain in this tx;
///        - seed() is callable exactly once by the deployer; after that the
///          deployer holds no privileged function.
///
///      CONSUMER CONTRACTS (adapters, readouts, marketplaces) MUST NEVER call
///      advance() inside their own swap/mint/liquidate transaction: a full brain
///      step is millions of gas and cannot fit in someone else's tx. External use
///      is limited to TWO things: queue current via stimulate(), and read the
///      three fresh movement quantities via WormReadout.read(). This interface does
///      not (and will not) expose a "decode all 302 neurons" helper on purpose.
///
///      Events are for indexing only, never a state source: external contracts read
///      storage. Advanced(tick, fired, stateHash-ish) and Stimulated(idx, amp) are
///      emitted by the brain; a stale read is defined by the consumer against
///      WormReadout.Readout.blockNumber (require block.number - blockNumber <= 20).
interface IWormBrain {
    // ---- identity / provenance ----
    function N() external view returns (uint256);
    function connRoot() external view returns (bytes32);

    // ---- cheap scalar reads (safe to call from another contract's tx) ----
    function tick() external view returns (uint256);
    function totalSpikes() external view returns (uint256);
    function stateHash() external view returns (bytes32);

    // ---- bounded per-neuron reads (view; NO step is estimated or performed) ----
    function gate(uint256 idx) external view returns (int256);
    function V(uint256 idx) external view returns (int256);
    function stim(uint256 idx) external view returns (int256);
    function spikeCount(uint256 idx) external view returns (uint256);

    // ---- the ONLY two mutations an external caller may use ----
    /// @notice Queue signed current into neuron idx; clamped to a hard cap by the
    ///         contract; accumulates within a block (adds, does not overwrite);
    ///         affects dynamics only on the next advance() and then decays.
    function stimulate(uint256 idx, int256 amp) external;

    /// @notice Permissionless keepalive. NOT for external consumers: callers must
    ///         supply the canonical connBlob and pay gas; reverts on bad blob or
    ///         n out of (0, 500]. Adapters/readouts must never call this.
    function advance(uint256 n, bytes calldata connBlob) external;

    event Advanced(uint256 indexed tick, uint256 fired, uint256 totalSpikes);
    event Stimulated(uint256 indexed idx, int256 amp);
}
