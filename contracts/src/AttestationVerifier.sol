// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AttestationVerifier — on-chain check of a verdict's deterministic attestation (Merit #19).
/// @notice Confirms that an attestation digest was signed by the canonical Auditor, so the machine-checkable
/// commitment of a verdict (numeric + similarity) is verifiable ON-CHAIN, not just offline. This is the
/// integration point for a succinct proof: swap `ecrecover` for a ZK verifier and everything else is unchanged.
contract AttestationVerifier {
    address public immutable auditor;

    error ZeroAuditor();

    constructor(address _auditor) {
        if (_auditor == address(0)) revert ZeroAuditor();
        auditor = _auditor;
    }

    /// @notice True iff `digest` was signed by the auditor (pass the EIP-191 message hash of the attestation).
    function verify(bytes32 digest, uint8 v, bytes32 r, bytes32 s) external view returns (bool) {
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == auditor;
    }
}
