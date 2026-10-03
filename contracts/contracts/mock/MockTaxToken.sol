// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MockTaxToken -- a LOCAL-TEST-ONLY stand-in for the project's taxed token
/// @notice NEVER deploy this on any public network. It exists so the ledger and the
///         wager contracts can be tested against the one property the real token
///         has and a plain ERC20 does not: a transfer of X credits the recipient
///         with LESS than X. Without it the "price is what arrives, not what was
///         asked for" accounting in WormLedger / WormGuess would be untested.
/// @dev   taxBps defaults to 300 (3%), matching the live token's buy/sell tax.
///        Transfers to address(0) are deliberately allowed so the burn path in
///        WormLedger is exercised the same way a real token would take it.
contract MockTaxToken {
    string public name = "Mock Taxed WormBrain";
    string public symbol = "mWORM";
    uint8 public immutable decimals = 18;
    uint256 public totalSupply;
    uint256 public taxBps = 300;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function setTaxBps(uint256 b) external {
        require(b <= 10000, "bad tax");
        taxBps = b;
    }

    function mint(address to, uint256 v) external {
        totalSupply += v;
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function approve(address sp, uint256 v) external returns (bool) {
        allowance[msg.sender][sp] = v;
        emit Approval(msg.sender, sp, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        return _move(msg.sender, to, v);
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - v;
        return _move(from, to, v);
    }

    function _move(address from, address to, uint256 v) private returns (bool) {
        require(balanceOf[from] >= v, "balance");
        uint256 tax = (v * taxBps) / 10000;
        uint256 net = v - tax;
        balanceOf[from] -= v;
        // the recipient is credited the net amount, and the tax is taken from the
        // sender's balance: exactly the asymmetry the production contracts must survive
        balanceOf[to] += net;
        balanceOf[address(0)] += tax;
        totalSupply -= tax;
        emit Transfer(from, to, net);
        return true;
    }
}
