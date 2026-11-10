// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Test token: the owner mints and airdrops, holders burn, decimals are chosen at deploy
/// @notice Built for testnets: deploy one with the exact name, symbol and decimals a test needs.
contract StandardTestToken is ERC20, ERC20Burnable, Ownable {
    uint8 private immutable _tokenDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply,
        address owner_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        _tokenDecimals = decimals_;
        if (initialSupply > 0) {
            _mint(owner_, initialSupply);
        }
    }

    function decimals() public view virtual override returns (uint8) {
        return _tokenDecimals;
    }

    /// @notice Mints `amount` base units to `to`
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Mints to many recipients in one transaction
    function airdrop(address[] calldata recipients, uint256[] calldata amounts) external onlyOwner {
        require(recipients.length == amounts.length, "airdrop: length mismatch");
        for (uint256 i = 0; i < recipients.length; i++) {
            _mint(recipients[i], amounts[i]);
        }
    }
}
