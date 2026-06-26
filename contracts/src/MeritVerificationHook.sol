// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IACPHook, IERC165} from "./interfaces/IACPHook.sol";

/// @title MeritVerificationHook — proof-of-citation as an ERC-8183 evaluate gate.
/// @notice The {IACPHook} that any ERC-8183 job names to make its escrow release CONDITIONAL on Merit's
/// proof-of-citation verdict. Merit's Auditor runs off-chain (layered deterministic-numeric + adversarial
/// LLM-judge verification); its `validator` operator records the outcome on-chain via {recordVerdict}. When
/// the job's evaluator calls `complete` (release), the host calls `beforeAction(jobId, COMPLETE, …)`, and
/// this hook REVERTS unless a `verified` verdict was recorded for that exact (host, jobId) — binding the
/// on-chain payout to machine-checkable proof-of-citation. The verdict stores the signed attestation hash so
/// the release is linked to an offline-verifiable proof object. The refund/reject path is never gated, and
/// verdicts are keyed by (host, jobId) so a single hook safely serves every ERC-8183 job on Arc.
contract MeritVerificationHook is IACPHook {
    /// @dev Selectors of the host job's hookable functions (must match {MeritJob}).
    bytes4 internal constant SEL_COMPLETE = bytes4(keccak256("complete(uint256,bytes32,bytes)"));

    address public immutable validator; // Merit's Auditor operator — the only party that records verdicts

    struct Verdict {
        bool recorded;
        bool verified;
        bytes32 proofHash;
    }

    mapping(bytes32 => Verdict) public verdicts; // key = keccak256(host, jobId)

    event VerdictRecorded(address indexed host, uint256 indexed jobId, bool verified, bytes32 proofHash);
    event ReleaseGated(address indexed host, uint256 indexed jobId, bytes32 proofHash);

    error NotValidator();
    error NotVerified();

    constructor(address _validator) {
        validator = _validator == address(0) ? msg.sender : _validator;
    }

    function _key(address host, uint256 jobId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(host, jobId));
    }

    /// @notice Merit's Auditor operator records the proof-of-citation outcome for a job on a host contract.
    /// @param proofHash the hash of the signed attestation/receipt that justifies the verdict (audit link).
    function recordVerdict(address host, uint256 jobId, bool verified, bytes32 proofHash) external {
        if (msg.sender != validator) revert NotValidator();
        verdicts[_key(host, jobId)] = Verdict({recorded: true, verified: verified, proofHash: proofHash});
        emit VerdictRecorded(host, jobId, verified, proofHash);
    }

    function verdictOf(address host, uint256 jobId) external view returns (Verdict memory) {
        return verdicts[_key(host, jobId)];
    }

    /// @inheritdoc IACPHook
    /// @dev Gates `complete` (the escrow release) on a recorded, verified proof-of-citation verdict. `msg.sender`
    /// is the host job contract, so the verdict is scoped to (host, jobId). Other transitions pass through.
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata) external {
        if (selector == SEL_COMPLETE) {
            Verdict storage v = verdicts[_key(msg.sender, jobId)];
            if (!v.recorded || !v.verified) revert NotVerified();
            emit ReleaseGated(msg.sender, jobId, v.proofHash);
        }
    }

    /// @inheritdoc IACPHook
    function afterAction(uint256, bytes4, bytes calldata) external {}

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
