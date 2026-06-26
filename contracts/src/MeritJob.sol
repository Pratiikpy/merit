// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IACPHook} from "./interfaces/IACPHook.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title MeritJob — an ERC-8183 Agentic Commerce job with USDC escrow (Merit's native settlement spine).
/// @notice Implements the ERC-8183 job lifecycle so a Merit run IS a canonical Arc agent job: a CLIENT
/// creates a job naming a PROVIDER, an EVALUATOR, and an optional HOOK; the provider sets a budget; the
/// client funds USDC into escrow; the provider submits a deliverable hash; the EVALUATOR `complete`s
/// (release to provider) or `reject`s (refund to client); an unfunded-past-expiry job is refundable via
/// `claimRefund`. A named hook is invoked around every state-changing step and may GATE it by reverting in
/// `beforeAction` — this is where Merit's proof-of-citation plugs in as the on-chain `evaluate` gate (see
/// {MeritVerificationHook}). Non-custodial: only the evaluator can release or refund a submitted job, escrow
/// funds are conserved, and checks-effects-interactions plus a reentrancy guard make every payout safe even
/// against an adversarial hook.
contract MeritJob {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        address client;
        address provider;
        address evaluator;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
        bytes32 deliverable;
        string description;
    }

    IERC20 public immutable usdc;
    uint256 public nextId = 1;
    mapping(uint256 => Job) public jobs;

    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error BadState();
    error ZeroAddress();
    error ZeroBudget();
    error NotExpired();

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    /// @notice Client opens a job naming the provider, the evaluator (who adjudicates), and an optional hook.
    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external
        returns (uint256 jobId)
    {
        if (evaluator == address(0)) revert ZeroAddress();
        jobId = nextId++;
        Job storage j = jobs[jobId];
        j.client = msg.sender;
        j.provider = provider;
        j.evaluator = evaluator;
        j.expiredAt = expiredAt;
        j.status = JobStatus.Open;
        j.hook = hook;
        j.description = description;
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
    }

    /// @notice Client may (re)assign the provider while the job is still Open.
    function setProvider(uint256 jobId, address provider_) external {
        Job storage j = jobs[jobId];
        if (msg.sender != j.client) revert NotClient();
        if (j.status != JobStatus.Open) revert BadState();
        j.provider = provider_;
        emit ProviderSet(jobId, provider_);
    }

    /// @notice Provider sets the job price (ERC-8183: the provider quotes the budget) while Open.
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external {
        Job storage j = jobs[jobId];
        if (msg.sender != j.provider) revert NotProvider();
        if (j.status != JobStatus.Open) revert BadState();
        if (amount == 0) revert ZeroBudget();
        j.budget = amount;
        _before(jobId, j.hook, optParams);
        emit BudgetSet(jobId, amount);
        _after(jobId, j.hook, optParams);
    }

    /// @notice Client funds the budget into escrow, moving the job to Funded. Requires prior USDC approval.
    function fund(uint256 jobId, bytes calldata optParams) external nonReentrant {
        Job storage j = jobs[jobId];
        if (msg.sender != j.client) revert NotClient();
        if (j.status != JobStatus.Open) revert BadState();
        if (j.budget == 0) revert ZeroBudget();
        uint256 amount = j.budget;
        _before(jobId, j.hook, optParams);
        j.status = JobStatus.Funded; // effects before interaction
        emit JobFunded(jobId, msg.sender, amount);
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        _after(jobId, j.hook, optParams);
    }

    /// @notice Provider submits the deliverable hash, moving the job to Submitted.
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant {
        Job storage j = jobs[jobId];
        if (msg.sender != j.provider) revert NotProvider();
        if (j.status != JobStatus.Funded) revert BadState();
        _before(jobId, j.hook, optParams);
        j.deliverable = deliverable;
        j.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);
        _after(jobId, j.hook, optParams);
    }

    /// @notice Evaluator approves the deliverable — releases escrow to the provider. The hook may GATE this.
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage j = jobs[jobId];
        if (msg.sender != j.evaluator) revert NotEvaluator();
        if (j.status != JobStatus.Submitted) revert BadState();
        uint256 amount = j.budget;
        address payee = j.provider;
        _before(jobId, j.hook, optParams); // proof-of-citation gate fires here
        j.status = JobStatus.Completed; // effects before interaction
        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, payee, amount);
        require(usdc.transfer(payee, amount), "transfer failed");
        _after(jobId, j.hook, optParams);
    }

    /// @notice Evaluator rejects the deliverable — refunds the client. Never gated by the hook.
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage j = jobs[jobId];
        if (msg.sender != j.evaluator) revert NotEvaluator();
        if (j.status != JobStatus.Submitted) revert BadState();
        uint256 amount = j.budget;
        address client = j.client;
        _before(jobId, j.hook, optParams);
        j.status = JobStatus.Rejected;
        emit JobRejected(jobId, msg.sender, reason);
        emit Refunded(jobId, client, amount);
        require(usdc.transfer(client, amount), "transfer failed");
        _after(jobId, j.hook, optParams);
    }

    /// @notice Client reclaims escrow on a funded-but-unresolved job once it has expired.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (msg.sender != j.client) revert NotClient();
        if (j.status != JobStatus.Funded && j.status != JobStatus.Submitted) revert BadState();
        if (j.expiredAt == 0 || block.timestamp <= j.expiredAt) revert NotExpired();
        uint256 amount = j.budget;
        j.status = JobStatus.Expired;
        emit JobExpired(jobId);
        emit Refunded(jobId, j.client, amount);
        require(usdc.transfer(j.client, amount), "transfer failed");
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function _before(uint256 jobId, address hook, bytes calldata data) internal {
        if (hook != address(0)) IACPHook(hook).beforeAction(jobId, msg.sig, data);
    }

    function _after(uint256 jobId, address hook, bytes calldata data) internal {
        if (hook != address(0)) IACPHook(hook).afterAction(jobId, msg.sig, data);
    }
}
