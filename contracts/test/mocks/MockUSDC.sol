// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @notice Six-decimal ERC20 stand-in for Base USDC, with open minting for test setup.
/// @dev Base USDC is a standard-returning ERC20 (its `transferFrom` returns `true`, seen in
///      a live trace), so a plain implementation is faithful here — no missing-return or
///      fee-on-transfer quirk to model.
contract MockUSDC is ERC20 {
    function name() public pure override returns (string memory) {
        return "USD Coin";
    }

    function symbol() public pure override returns (string memory) {
        return "USDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
