// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {StandardTestToken} from "./StandardTestToken.sol";

/// @title Standard test token plus pause and EIP-2612 permit
/// @notice Pausing makes every transfer revert, which is how a test gets a token that cannot move.
contract AdvancedTestToken is StandardTestToken, ERC20Pausable, ERC20Permit {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply,
        address owner_
    ) StandardTestToken(name_, symbol_, decimals_, initialSupply, owner_) ERC20Permit(name_) {}

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function decimals() public view override(ERC20, StandardTestToken) returns (uint8) {
        return super.decimals();
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable) {
        super._update(from, to, value);
    }
}
