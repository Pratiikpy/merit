// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title Insurance — a guarantee market on agent trust (Merit #17).
/// @notice An UNDERWRITER deposits collateral and binds policies: a buyer pays a premium to guarantee a job
/// for some coverage. If the buyer wins a dispute (the arbiter rules the claim valid), the policy pays the
/// coverage to the buyer from the underwriter's collateral; otherwise the reservation is released back.
/// Always solvent: a policy can only bind if the underwriter's FREE pool covers it, and that coverage is then
/// RESERVED, so every active policy is fully collateralized. Premiums grow the pool (the underwriter's yield).
contract Insurance {
    enum State {
        None,
        Bound,
        Claimed,
        Released
    }

    struct Policy {
        address buyer;
        address underwriter;
        uint256 premium;
        uint256 coverage;
        State state;
    }

    IERC20 public immutable usdc;
    address public immutable arbiter;

    mapping(address => uint256) public poolOf; // underwriter → free (unreserved) collateral
    mapping(address => uint256) public reservedOf; // underwriter → collateral locked by active policies
    mapping(bytes32 => Policy) public policies;

    event Deposited(address indexed underwriter, uint256 amount);
    event Bound(bytes32 indexed policyId, address indexed buyer, address indexed underwriter, uint256 premium, uint256 coverage);
    event Claimed(bytes32 indexed policyId, address indexed buyer, uint256 payout);
    event Released(bytes32 indexed policyId);
    event Withdrawn(address indexed underwriter, uint256 amount);

    error NotArbiter();
    error InsufficientPool();
    error Exists();
    error NotBound();
    error ZeroAmount();
    error ZeroAddress();

    constructor(address _usdc, address _arbiter) {
        if (_usdc == address(0) || _arbiter == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        arbiter = _arbiter;
    }

    /// @notice Underwriter deposits collateral into its free pool.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        poolOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
    }

    /// @notice Buyer binds a policy: pays `premium` (→ underwriter's pool) for `coverage` (reserved).
    function bind(bytes32 policyId, address underwriter, uint256 premium, uint256 coverage) external {
        if (policies[policyId].state != State.None) revert Exists();
        if (coverage == 0) revert ZeroAmount();
        if (poolOf[underwriter] < coverage) revert InsufficientPool();
        poolOf[underwriter] -= coverage;
        reservedOf[underwriter] += coverage;
        policies[policyId] = Policy(msg.sender, underwriter, premium, coverage, State.Bound);
        emit Bound(policyId, msg.sender, underwriter, premium, coverage);
        if (premium > 0) {
            require(usdc.transferFrom(msg.sender, address(this), premium), "premium failed");
            poolOf[underwriter] += premium; // premium is the underwriter's yield
        }
    }

    /// @notice Arbiter resolves a claim — pay the coverage to the buyer (valid) or release it (invalid).
    function resolve(bytes32 policyId, bool claimValid) external {
        if (msg.sender != arbiter) revert NotArbiter();
        Policy storage p = policies[policyId];
        if (p.state != State.Bound) revert NotBound();
        reservedOf[p.underwriter] -= p.coverage;
        if (claimValid) {
            p.state = State.Claimed;
            emit Claimed(policyId, p.buyer, p.coverage);
            require(usdc.transfer(p.buyer, p.coverage), "payout failed");
        } else {
            p.state = State.Released;
            poolOf[p.underwriter] += p.coverage; // reservation returns to the free pool
            emit Released(policyId);
        }
    }

    /// @notice Underwriter withdraws free (unreserved) collateral.
    function withdraw(uint256 amount) external {
        if (amount > poolOf[msg.sender]) revert InsufficientPool();
        poolOf[msg.sender] -= amount;
        emit Withdrawn(msg.sender, amount);
        require(usdc.transfer(msg.sender, amount), "transfer failed");
    }
}
