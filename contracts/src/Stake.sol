// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title Stake — staking + slashing for sources (Merit #15).
/// @notice A source stakes USDC to list (skin in the game behind its reputation). The slasher (Merit's
/// Auditor/operator) can slash a proven mis-citer's stake into a treasury; the source withdraws its own
/// stake after a cooldown if not slashed. Non-custodial: only the staker withdraws their stake, only the
/// slasher slashes, a slash is capped at the stake, and checks-effects-interactions makes payouts safe.
contract Stake {
    IERC20 public immutable usdc;
    address public immutable slasher;
    address public immutable treasury;
    uint256 public immutable cooldown;

    struct StakeInfo {
        uint256 amount;
        uint256 unlockAt; // 0 = no pending withdrawal
    }

    mapping(address => StakeInfo) public stakes;
    uint256 public totalStaked;
    uint256 public totalSlashed;

    event Staked(address indexed source, uint256 amount, uint256 newTotal);
    event Slashed(address indexed source, uint256 amount, string reason);
    event WithdrawRequested(address indexed source, uint256 unlockAt);
    event Withdrawn(address indexed source, uint256 amount);

    error NotSlasher();
    error NothingStaked();
    error StillLocked();
    error ZeroAmount();
    error ZeroAddress();

    constructor(address _usdc, address _slasher, address _treasury, uint256 _cooldown) {
        if (_usdc == address(0) || _slasher == address(0) || _treasury == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        slasher = _slasher;
        treasury = _treasury;
        cooldown = _cooldown;
    }

    /// @notice Source stakes USDC to list (or tops up). Cancels any pending withdrawal.
    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        StakeInfo storage s = stakes[msg.sender];
        s.amount += amount;
        s.unlockAt = 0;
        totalStaked += amount;
        emit Staked(msg.sender, amount, s.amount);
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
    }

    /// @notice The slasher burns a mis-citer's stake into the treasury. Capped at the source's stake.
    function slash(address source, uint256 amount, string calldata reason) external {
        if (msg.sender != slasher) revert NotSlasher();
        StakeInfo storage s = stakes[source];
        if (s.amount == 0) revert NothingStaked();
        uint256 slashAmt = amount > s.amount ? s.amount : amount;
        s.amount -= slashAmt;
        totalStaked -= slashAmt;
        totalSlashed += slashAmt;
        emit Slashed(source, slashAmt, reason);
        require(usdc.transfer(treasury, slashAmt), "transfer failed");
    }

    /// @notice Source requests withdrawal — starts the cooldown so a slash can still land first.
    function requestWithdraw() external {
        StakeInfo storage s = stakes[msg.sender];
        if (s.amount == 0) revert NothingStaked();
        s.unlockAt = block.timestamp + cooldown;
        emit WithdrawRequested(msg.sender, s.unlockAt);
    }

    /// @notice Source withdraws its remaining stake after the cooldown elapses.
    function withdraw() external {
        StakeInfo storage s = stakes[msg.sender];
        if (s.amount == 0) revert NothingStaked();
        if (s.unlockAt == 0 || block.timestamp < s.unlockAt) revert StillLocked();
        uint256 amount = s.amount;
        s.amount = 0;
        s.unlockAt = 0;
        totalStaked -= amount;
        emit Withdrawn(msg.sender, amount);
        require(usdc.transfer(msg.sender, amount), "transfer failed");
    }

    function stakeOf(address source) external view returns (uint256) {
        return stakes[source].amount;
    }
}
