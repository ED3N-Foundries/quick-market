// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Testnet balance for quick-market. The treasury key is the only minter.
contract QuickMarketUSDC {
    string public constant name = "quick-market USDC";
    string public constant symbol = "qmUSDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    address public immutable minter;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    error NotMinter();
    error InsufficientBalance();

    constructor() {
        minter = msg.sender;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 balance = balanceOf[msg.sender];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[msg.sender] = balance - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }
}
