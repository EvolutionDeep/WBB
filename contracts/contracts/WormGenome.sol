// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title WormGenome —— the worm's "genome anchor"
/// @notice Immutably records the connectome fingerprint (302 neurons / 5146 edges /
///         weight-matrix hash). Anyone with this hash can rebuild an exactly identical
///         neural network locally from the same data — this is the on-chain birth
///         certificate behind the notion "immortality = deterministic reconstruction".
contract WormGenome {
    /// @dev keccak256 commitment of the dense connectome weight matrix (W_chem || W_elec)
    bytes32 public immutable connectomeRoot;
    /// @dev number of neurons (Cook 2019 hermaphrodite = 302)
    uint16 public immutable nNeurons;
    /// @dev number of unique directed edges (measured: 5146)
    uint16 public immutable nEdges;
    /// @dev hash identifying the data source ("Cook et al. 2019 via cect")
    bytes32 public immutable sourceHash;
    /// @dev when the genome was minted
    uint256 public immutable mintedAt;
    address public immutable genesisAuthor;

    event GenomeAnchored(
        bytes32 indexed connectomeRoot,
        uint16 nNeurons,
        uint16 nEdges,
        address indexed author
    );

    constructor(
        bytes32 _connectomeRoot,
        uint16 _nNeurons,
        uint16 _nEdges,
        bytes32 _sourceHash
    ) {
        require(_connectomeRoot != bytes32(0), "empty root");
        require(_nNeurons > 0 && _nEdges > 0, "zero dims");
        connectomeRoot = _connectomeRoot;
        nNeurons = _nNeurons;
        nEdges = _nEdges;
        sourceHash = _sourceHash;
        mintedAt = block.timestamp;
        genesisAuthor = msg.sender;
        emit GenomeAnchored(_connectomeRoot, _nNeurons, _nEdges, msg.sender);
    }
}
