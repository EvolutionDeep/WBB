// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IWormBrain} from "./IWormBrain.sol";
import {WormNeurons} from "./WormNeurons.sol";

/// @dev Minimal PancakeSwap-V2 style factory/pair surface. Declared locally so this
///      contract stays self-contained (no external library / OpenZeppelin imports).
interface IPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IPancakePair {
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

/// @title SenseAdapter -- the ONE sanctioned entry point for other protocols
/// @notice Translates an external, signed intensity into currents on the worm's
///         frozen chemoreceptors. It never interprets prices, never reads the brain
///         state to decide, and NEVER calls advance(). Stimulation is limited to the
///         sanctioned neurons only.
/// @dev   Two permissionless stimulation sources are implemented (in order):
///
///          1. inject(int256 signedIntensity) -- any protocol's direct entry. The
///             value is amplitude-limited (clamped, not reverted, per the block-scope
///             accumulate rule) then routed by sign: positive current -> ASEL,
///             negative current -> ASER. Nothing else is touched.
///
///          2. sample() -- permissionless polling of a single frozen market pool.
///             The WBNB/USDT pair is resolved once at deploy (factory.getPair) and
///             stored IMMUTABLE. Each call reads getReserves(), computes the reserve
///             ratio, subtracts the ratio saved on the previous sample, and writes
///             currents: a POSITIVE change accumulates into ASEL, a NEGATIVE change
///             into ASER, and the ABSOLUTE change into AWCL/AWCR (non-specific arousal).
///             It does NOT decide what up/down means -- it only moves charge. No
///             Chainlink, no block.number, no tx hash, no randomness, no owner
///             signature, no off-chain opinion -- those are all forbidden as stimuli.
///
///        Body feedback (the worm's own position/vault) is intentionally NOT wired
///        yet: it belongs to a later effector stage and must not be invented here.
///        Amplitude is always hard-capped here, and the brain applies its own cap +
///        per-step decay; multiple stimulate calls in one block accumulate.
contract SenseAdapter {
    IWormBrain public immutable brain;
    IPancakePair public immutable pair; // frozen from factory.getPair at deployment

    int256 public immutable gain;   // maps a reserve-ratio delta (Q20) to current (Q20)
    int256 public immutable ampCap; // hard cap on |amp| written per injection / sample

    uint256 private lastRatio;      // reserve ratio (Q20) captured at the previous sample
    bool private primed;            // first sample only records a baseline, injects nothing

    event Injected(address indexed from, int256 amp, uint256 idx);
    event Sampled(uint256 ratio, int256 delta, int256 signedAmp, int256 magAmp);

    /// @param factory_  PancakeV2 factory (used ONCE here to resolve the pair)
    /// @param tokenA_   pool token A (e.g. WBNB)
    /// @param tokenB_   pool token B (e.g. USDT)
    /// @param brain_    the live WormBrain address
    /// @param gain_     ratio-delta -> current gain, in Q20 (SCALE == identity)
    /// @param ampCap_   per-write amplitude cap, Q20 (must be <= the brain's STIM_CAP)
    constructor(
        address factory_,
        address tokenA_,
        address tokenB_,
        address brain_,
        int256 gain_,
        int256 ampCap_
    ) {
        require(factory_ != address(0) && brain_ != address(0), "zero addr");
        require(gain_ > 0 && ampCap_ > 0, "bad params");
        address p = IPancakeFactory(factory_).getPair(tokenA_, tokenB_);
        require(p != address(0), "no pair");
        brain = IWormBrain(brain_);
        pair = IPancakePair(p);
        gain = gain_;
        ampCap = ampCap_;
    }

    /// @notice Sanctioned direct entry for other protocols: clamp, then stimulate the
    ///         chemoreceptor pair by sign. Positive -> ASEL, negative -> ASER.
    function inject(int256 signedIntensity) external {
        int256 amp = _clamp(signedIntensity);
        uint256 idx = amp >= 0 ? WormNeurons.ASEL : WormNeurons.ASER;
        brain.stimulate(idx, amp);
        emit Injected(msg.sender, amp, idx);
    }

    /// @notice Permissionless sampling of the frozen pool. Reads reserves, differences
    ///         against the last stored ratio, and writes currents. Never advance().
    function sample() external {
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        require(r0 > 0 && r1 > 0, "empty reserves");
        uint256 ratio = (uint256(r1) * uint256(WormNeurons.SCALE)) / uint256(r0);

        if (!primed) {
            // baseline only: no opinion can be formed from a single frame
            lastRatio = ratio;
            primed = true;
            emit Sampled(ratio, 0, 0, 0);
            return;
        }

        int256 delta = int256(ratio) - int256(lastRatio);
        lastRatio = ratio;

        // signed change -> attractant/avoid chemoreceptor; |change| -> arousal pair
        int256 signedAmp = _clamp((delta * gain) / WormNeurons.SCALE);
        int256 magAmp = _clamp((_abs(delta) * gain) / WormNeurons.SCALE);

        if (signedAmp != 0) {
            uint256 idx = signedAmp > 0 ? WormNeurons.ASEL : WormNeurons.ASER;
            brain.stimulate(idx, signedAmp);
        }
        if (magAmp > 0) {
            brain.stimulate(WormNeurons.AWCL, magAmp);
            brain.stimulate(WormNeurons.AWCR, magAmp);
        }
        emit Sampled(ratio, delta, signedAmp, magAmp);
    }

    function lastReserveRatio() external view returns (uint256) {
        return lastRatio;
    }

    function isPrimed() external view returns (bool) {
        return primed;
    }

    // ---- helpers ----

    function _clamp(int256 x) private view returns (int256) {
        if (x > ampCap) return ampCap;
        if (x < -ampCap) return -ampCap;
        return x;
    }

    function _abs(int256 x) private pure returns (int256) {
        return x < 0 ? -x : x;
    }
}
