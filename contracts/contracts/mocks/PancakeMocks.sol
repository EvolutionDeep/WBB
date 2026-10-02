// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev TEST-ONLY mocks. Not part of the organism and never deployed to a public
///      chain. They stand in for PancakeSwap V2 so SenseAdapter.sample() can be
///      exercised deterministically with hand-set reserves.

contract FakePancakePair {
    uint112 public reserve0;
    uint112 public reserve1;

    function setReserves(uint112 r0, uint112 r1) external {
        reserve0 = r0;
        reserve1 = r1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }
}

contract FakePancakeFactory {
    address public immutable pair;

    constructor(address pair_) {
        pair = pair_;
    }

    // returns the same pair for any token query (single frozen pool in tests)
    function getPair(address, address) external view returns (address) {
        return pair;
    }
}
