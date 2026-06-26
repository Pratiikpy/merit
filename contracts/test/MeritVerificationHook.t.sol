// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MeritJob} from "../src/MeritJob.sol";
import {MeritVerificationHook} from "../src/MeritVerificationHook.sol";
import {IACPHook} from "../src/interfaces/IACPHook.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// Integration: a real {MeritJob} (ERC-8183) wired to {MeritVerificationHook}. Proves the escrow release is
/// bound to a recorded proof-of-citation verdict, while the refund path stays open.
contract MeritVerificationHookTest is Test {
    MeritJob job;
    MeritVerificationHook hook;
    MockUSDC usdc;
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address evaluator = makeAddr("evaluator");
    address auditor = makeAddr("auditor"); // Merit's validator operator

    function setUp() public {
        usdc = new MockUSDC();
        job = new MeritJob(address(usdc));
        hook = new MeritVerificationHook(auditor);
        usdc.mint(client, 1000);
        vm.prank(client);
        usdc.approve(address(job), type(uint256).max);
    }

    function _submitted(uint256 amt) internal returns (uint256 id) {
        vm.prank(client);
        id = job.createJob(provider, evaluator, block.timestamp + 1 hours, "job", address(hook));
        vm.prank(provider);
        job.setBudget(id, amt, "");
        vm.prank(client);
        job.fund(id, "");
        vm.prank(provider);
        job.submit(id, keccak256("deliverable"), "");
    }

    function test_complete_blockedWithoutVerdict() public {
        uint256 id = _submitted(100);
        vm.prank(evaluator);
        vm.expectRevert(MeritVerificationHook.NotVerified.selector);
        job.complete(id, "", "");
        assertEq(usdc.balanceOf(provider), 0); // nothing released without proof
    }

    function test_complete_allowedAfterVerifiedVerdict() public {
        uint256 id = _submitted(100);
        vm.prank(auditor);
        hook.recordVerdict(address(job), id, true, keccak256("proof"));
        vm.prank(evaluator);
        job.complete(id, "", "");
        assertEq(usdc.balanceOf(provider), 100);
        assertEq(hook.verdictOf(address(job), id).proofHash, keccak256("proof"));
    }

    function test_complete_blockedWhenVerdictRefused() public {
        uint256 id = _submitted(100);
        vm.prank(auditor);
        hook.recordVerdict(address(job), id, false, keccak256("proof"));
        vm.prank(evaluator);
        vm.expectRevert(MeritVerificationHook.NotVerified.selector);
        job.complete(id, "", "");
    }

    function test_onlyValidator_recordsVerdict() public {
        uint256 id = _submitted(100);
        vm.prank(evaluator);
        vm.expectRevert(MeritVerificationHook.NotValidator.selector);
        hook.recordVerdict(address(job), id, true, keccak256("proof"));
    }

    function test_reject_ungated_refundsWithoutVerdict() public {
        uint256 id = _submitted(100);
        vm.prank(evaluator);
        job.reject(id, "", ""); // no verdict recorded — refund must still work
        assertEq(usdc.balanceOf(client), 1000);
    }

    function test_verdictKeyedPerHost() public {
        uint256 id = _submitted(100);
        // a verified verdict recorded for a DIFFERENT host must not unlock this job
        vm.prank(auditor);
        hook.recordVerdict(address(0xBEEF), id, true, keccak256("proof"));
        vm.prank(evaluator);
        vm.expectRevert(MeritVerificationHook.NotVerified.selector);
        job.complete(id, "", "");
    }

    function test_supportsInterface() public view {
        assertTrue(hook.supportsInterface(type(IACPHook).interfaceId));
    }
}
