// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title PredictionMarket — a market on whether a contested citation survives appeal (Merit #18).
/// @notice Traders stake USDC on YES/NO. The pool's YES fraction is a live crowd-probability the Auditor can
/// read as a prior. On resolution by the oracle (the appeal outcome), the WINNING side splits the ENTIRE pool
/// pro-rata to their stake — pari-mutuel, so it is solvent by construction with no AMM math, and a market
/// with no winners refunds everyone. Losing stakes pay nothing.
contract PredictionMarket {
    enum Outcome {
        Open,
        Yes,
        No
    }

    struct Market {
        uint256 yesPool;
        uint256 noPool;
        Outcome outcome;
    }

    IERC20 public immutable usdc;
    address public immutable oracle;

    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => mapping(address => uint256)) public yesStake;
    mapping(bytes32 => mapping(address => uint256)) public noStake;
    mapping(bytes32 => mapping(address => bool)) public redeemed;

    event Staked(bytes32 indexed marketId, address indexed trader, bool yes, uint256 amount);
    event Resolved(bytes32 indexed marketId, Outcome outcome);
    event Redeemed(bytes32 indexed marketId, address indexed trader, uint256 payout);

    error NotOracle();
    error NotOpen();
    error NotResolved();
    error ZeroAmount();
    error AlreadyRedeemed();
    error NothingToRedeem();
    error ZeroAddress();

    constructor(address _usdc, address _oracle) {
        if (_usdc == address(0) || _oracle == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        oracle = _oracle;
    }

    function stake(bytes32 marketId, bool yes, uint256 amount) external {
        if (markets[marketId].outcome != Outcome.Open) revert NotOpen();
        if (amount == 0) revert ZeroAmount();
        if (yes) {
            markets[marketId].yesPool += amount;
            yesStake[marketId][msg.sender] += amount;
        } else {
            markets[marketId].noPool += amount;
            noStake[marketId][msg.sender] += amount;
        }
        emit Staked(marketId, msg.sender, yes, amount);
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
    }

    /// @notice Live crowd probability the citation survives, in basis points (0..10000). 5000 = empty / 50-50.
    function yesProbabilityBps(bytes32 marketId) external view returns (uint256) {
        Market storage m = markets[marketId];
        uint256 total = m.yesPool + m.noPool;
        if (total == 0) return 5000;
        return (m.yesPool * 10000) / total;
    }

    function resolve(bytes32 marketId, bool yesWon) external {
        if (msg.sender != oracle) revert NotOracle();
        if (markets[marketId].outcome != Outcome.Open) revert NotOpen();
        markets[marketId].outcome = yesWon ? Outcome.Yes : Outcome.No;
        emit Resolved(marketId, markets[marketId].outcome);
    }

    function redeem(bytes32 marketId) external {
        Market storage m = markets[marketId];
        if (m.outcome == Outcome.Open) revert NotResolved();
        if (redeemed[marketId][msg.sender]) revert AlreadyRedeemed();
        uint256 total = m.yesPool + m.noPool;
        uint256 winningPool = m.outcome == Outcome.Yes ? m.yesPool : m.noPool;
        uint256 payout;
        if (winningPool == 0) {
            // no one backed the winning side → refund this trader's stake on both sides
            payout = yesStake[marketId][msg.sender] + noStake[marketId][msg.sender];
        } else {
            uint256 myStake = m.outcome == Outcome.Yes ? yesStake[marketId][msg.sender] : noStake[marketId][msg.sender];
            payout = (myStake * total) / winningPool; // winners split the WHOLE pool pro-rata
        }
        if (payout == 0) revert NothingToRedeem();
        redeemed[marketId][msg.sender] = true;
        emit Redeemed(marketId, msg.sender, payout);
        require(usdc.transfer(msg.sender, payout), "transfer failed");
    }
}
