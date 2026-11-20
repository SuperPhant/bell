// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Coinbase's onchain oracle registry for tokenized stocks on Base
///         (0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD on Base mainnet). Chainlink tokenized-equity feeds read the
///         multiplier and the pause flag from it; the pause flag is set during corporate actions.
interface IOracleRegistry {
    function getOracleParams(address token) external view returns (uint256 multiplier, bool paused);
}
