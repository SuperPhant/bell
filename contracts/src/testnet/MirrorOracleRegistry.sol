// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracleRegistry} from "../interfaces/IOracleRegistry.sol";

/// @title MirrorOracleRegistry
/// @notice Testnet mirror of Coinbase's onchain oracle registry. A relayer copies each mainnet token's
///         (multiplier, paused) pair onto the testnet token that mirrors it, so testnet protocols see the same
///         corporate-action pauses as mainnet.
contract MirrorOracleRegistry is IOracleRegistry {
    struct Params {
        uint256 multiplier;
        bool paused;
        uint64 updatedAt;
    }

    address public owner;
    address public relayer;
    mapping(address token => Params) public params;
    mapping(address token => address) public mainnetTokenOf;

    event Mirrored(address indexed token, uint256 multiplier, bool paused);
    event TokenMapped(address indexed token, address indexed mainnetToken);
    event RelayerChanged(address indexed relayer);

    error NotOwner();
    error NotRelayer();
    error LengthMismatch();

    constructor(address relayer_) {
        owner = msg.sender;
        relayer = relayer_;
        emit RelayerChanged(relayer_);
    }

    function setRelayer(address relayer_) external {
        if (msg.sender != owner) revert NotOwner();
        relayer = relayer_;
        emit RelayerChanged(relayer_);
    }

    function mapToken(address token, address mainnetToken) external {
        if (msg.sender != owner) revert NotOwner();
        mainnetTokenOf[token] = mainnetToken;
        emit TokenMapped(token, mainnetToken);
    }

    function mirror(address[] calldata tokens, uint256[] calldata multipliers, bool[] calldata paused) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (tokens.length != multipliers.length || tokens.length != paused.length) revert LengthMismatch();
        for (uint256 i; i < tokens.length; ++i) {
            params[tokens[i]] = Params(multipliers[i], paused[i], uint64(block.timestamp));
            emit Mirrored(tokens[i], multipliers[i], paused[i]);
        }
    }

    function getOracleParams(address token) external view returns (uint256 multiplier, bool paused) {
        Params memory p = params[token];
        return (p.multiplier == 0 ? 1e18 : p.multiplier, p.paused);
    }
}
