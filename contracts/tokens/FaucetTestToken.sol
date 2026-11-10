// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StandardTestToken} from "./StandardTestToken.sol";

/// @title Standard test token plus a public faucet
/// @notice Anyone can claim `faucetAmount` once per `faucetCooldown` seconds.
contract FaucetTestToken is StandardTestToken {
    uint256 public immutable faucetAmount;
    uint256 public immutable faucetCooldown;
    mapping(address => uint256) public lastClaim;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply,
        address owner_,
        uint256 faucetAmount_,
        uint256 faucetCooldown_
    ) StandardTestToken(name_, symbol_, decimals_, initialSupply, owner_) {
        faucetAmount = faucetAmount_;
        faucetCooldown = faucetCooldown_;
    }

    /// @notice Mints `faucetAmount` to the caller, at most once per cooldown
    function claim() external {
        uint256 last = lastClaim[msg.sender];
        require(last == 0 || block.timestamp >= last + faucetCooldown, "faucet: cooldown");
        lastClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
    }
}
