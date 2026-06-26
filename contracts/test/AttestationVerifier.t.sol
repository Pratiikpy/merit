// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AttestationVerifier} from "../src/AttestationVerifier.sol";

contract AttestationVerifierTest is Test {
    AttestationVerifier av;
    uint256 auditorKey = uint256(keccak256("auditor"));
    address auditor;

    function setUp() public {
        auditor = vm.addr(auditorKey);
        av = new AttestationVerifier(auditor);
    }

    function test_verifiesAuditorSignature() public view {
        bytes32 digest = keccak256("attestation-commitment");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(auditorKey, digest);
        assertTrue(av.verify(digest, v, r, s));
    }

    function test_rejectsOtherSigner() public view {
        bytes32 digest = keccak256("attestation-commitment");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256("mallory")), digest);
        assertFalse(av.verify(digest, v, r, s));
    }

    function testFuzz_onlyAuditorPasses(uint256 key, bytes32 digest) public view {
        key = bound(key, 1, type(uint128).max);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        assertEq(av.verify(digest, v, r, s), vm.addr(key) == auditor);
    }
}
