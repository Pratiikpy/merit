// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title Escrow — conditional, verification-native settlement for agent jobs (Merit #14).
/// @notice A buyer LOCKS USDC for a job, naming the payee and the validator (Merit's Auditor). The
/// validator then RELEASES the funds to the payee (work verified), REFUNDS the buyer (work failed), or the
/// job is DISPUTED (frozen pending resolution). Non-custodial beyond the lock: no owner can move locked
/// funds, the validator can only release-to-payee or refund-to-buyer, and checks-effects-interactions makes
/// every payout reentrancy-safe. Every transition emits an event for the off-chain indexer.
contract Escrow {
    enum State {
        None,
        Locked,
        Released,
        Refunded,
        Disputed
    }

    struct Job {
        address buyer;
        address payee;
        address validator;
        uint256 amount;
        State state;
    }

    IERC20 public immutable usdc;
    mapping(bytes32 => Job) public jobs;

    event Locked(bytes32 indexed jobId, address indexed buyer, address indexed payee, address validator, uint256 amount);
    event Released(bytes32 indexed jobId, address indexed payee, uint256 amount);
    event Refunded(bytes32 indexed jobId, address indexed buyer, uint256 amount);
    event Disputed(bytes32 indexed jobId, address indexed by);

    error AlreadyExists();
    error NotLocked();
    error NotValidator();
    error NotParty();
    error ZeroAmount();
    error ZeroAddress();

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    /// @notice Buyer locks `amount` USDC for `jobId`, naming the payee and the validator who adjudicates.
    function lock(bytes32 jobId, address payee, address validator, uint256 amount) external {
        if (jobs[jobId].state != State.None) revert AlreadyExists();
        if (amount == 0) revert ZeroAmount();
        if (payee == address(0) || validator == address(0)) revert ZeroAddress();
        jobs[jobId] = Job({buyer: msg.sender, payee: payee, validator: validator, amount: amount, state: State.Locked});
        emit Locked(jobId, msg.sender, payee, validator, amount);
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
    }

    function _onlyValidatorLocked(bytes32 jobId) internal view returns (Job storage j) {
        j = jobs[jobId];
        if (j.state != State.Locked) revert NotLocked();
        if (msg.sender != j.validator) revert NotValidator();
    }

    /// @notice Validator releases the locked USDC to the payee (the Auditor verified the work).
    function release(bytes32 jobId) external {
        Job storage j = _onlyValidatorLocked(jobId);
        j.state = State.Released; // effects before interaction — reentrancy-safe
        uint256 amount = j.amount;
        emit Released(jobId, j.payee, amount);
        require(usdc.transfer(j.payee, amount), "transfer failed");
    }

    /// @notice Validator refunds the buyer (the work failed verification).
    function refund(bytes32 jobId) external {
        Job storage j = _onlyValidatorLocked(jobId);
        j.state = State.Refunded;
        uint256 amount = j.amount;
        emit Refunded(jobId, j.buyer, amount);
        require(usdc.transfer(j.buyer, amount), "transfer failed");
    }

    /// @notice Either party (buyer or payee) freezes the job for dispute — funds stay locked.
    function dispute(bytes32 jobId) external {
        Job storage j = jobs[jobId];
        if (j.state != State.Locked) revert NotLocked();
        if (msg.sender != j.buyer && msg.sender != j.payee) revert NotParty();
        j.state = State.Disputed;
        emit Disputed(jobId, msg.sender);
    }

    /// @notice The validator resolves a disputed job — release to payee (`true`) or refund the buyer.
    function resolve(bytes32 jobId, bool releaseToPayee) external {
        Job storage j = jobs[jobId];
        if (j.state != State.Disputed) revert NotLocked();
        if (msg.sender != j.validator) revert NotValidator();
        uint256 amount = j.amount;
        if (releaseToPayee) {
            j.state = State.Released;
            emit Released(jobId, j.payee, amount);
            require(usdc.transfer(j.payee, amount), "transfer failed");
        } else {
            j.state = State.Refunded;
            emit Refunded(jobId, j.buyer, amount);
            require(usdc.transfer(j.buyer, amount), "transfer failed");
        }
    }

    function stateOf(bytes32 jobId) external view returns (State) {
        return jobs[jobId].state;
    }
}
