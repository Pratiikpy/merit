// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MeritJob} from "../src/MeritJob.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract MeritJobTest is Test {
    MeritJob job;
    MockUSDC usdc;
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address evaluator = makeAddr("evaluator");

    function setUp() public {
        usdc = new MockUSDC();
        job = new MeritJob(address(usdc));
        usdc.mint(client, 1000);
        vm.prank(client);
        usdc.approve(address(job), type(uint256).max);
    }

    function _open() internal returns (uint256 id) {
        vm.prank(client);
        id = job.createJob(provider, evaluator, block.timestamp + 1 hours, "research job", address(0));
    }

    function _submitted(uint256 amt) internal returns (uint256 id) {
        id = _open();
        vm.prank(provider);
        job.setBudget(id, amt, "");
        vm.prank(client);
        job.fund(id, "");
        vm.prank(provider);
        job.submit(id, keccak256("deliverable"), "");
    }

    function test_fullLifecycle_paysProvider() public {
        uint256 id = _submitted(100);
        assertEq(usdc.balanceOf(address(job)), 100);
        vm.prank(evaluator);
        job.complete(id, keccak256("approved"), "");
        assertEq(usdc.balanceOf(provider), 100);
        assertEq(usdc.balanceOf(address(job)), 0);
        assertEq(uint256(job.getJob(id).status), uint256(MeritJob.JobStatus.Completed));
    }

    function test_reject_refundsClient() public {
        uint256 id = _submitted(100);
        vm.prank(evaluator);
        job.reject(id, keccak256("unsupported"), "");
        assertEq(usdc.balanceOf(client), 1000);
        assertEq(uint256(job.getJob(id).status), uint256(MeritJob.JobStatus.Rejected));
    }

    function test_onlyEvaluator_canComplete() public {
        uint256 id = _submitted(100);
        vm.prank(client);
        vm.expectRevert(MeritJob.NotEvaluator.selector);
        job.complete(id, "", "");
    }

    function test_onlyProvider_setsBudget() public {
        uint256 id = _open();
        vm.prank(client);
        vm.expectRevert(MeritJob.NotProvider.selector);
        job.setBudget(id, 100, "");
    }

    function test_onlyClient_funds() public {
        uint256 id = _open();
        vm.prank(provider);
        job.setBudget(id, 100, "");
        vm.prank(provider);
        vm.expectRevert(MeritJob.NotClient.selector);
        job.fund(id, "");
    }

    function test_cannotSubmitBeforeFunded() public {
        uint256 id = _open();
        vm.prank(provider);
        job.setBudget(id, 100, "");
        vm.prank(provider);
        vm.expectRevert(MeritJob.BadState.selector);
        job.submit(id, keccak256("x"), "");
    }

    function test_zeroBudget_reverts() public {
        uint256 id = _open();
        vm.prank(provider);
        vm.expectRevert(MeritJob.ZeroBudget.selector);
        job.setBudget(id, 0, "");
    }

    function test_cannotCompleteTwice() public {
        uint256 id = _submitted(100);
        vm.prank(evaluator);
        job.complete(id, "", "");
        vm.prank(evaluator);
        vm.expectRevert(MeritJob.BadState.selector);
        job.complete(id, "", "");
        assertEq(usdc.balanceOf(provider), 100); // paid exactly once
    }

    function test_claimRefund_afterExpiry() public {
        uint256 id = _open();
        vm.prank(provider);
        job.setBudget(id, 100, "");
        vm.prank(client);
        job.fund(id, "");
        vm.prank(client);
        vm.expectRevert(MeritJob.NotExpired.selector);
        job.claimRefund(id);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(client);
        job.claimRefund(id);
        assertEq(usdc.balanceOf(client), 1000);
        assertEq(uint256(job.getJob(id).status), uint256(MeritJob.JobStatus.Expired));
    }

    function testFuzz_completeConservesFunds(uint96 amt) public {
        vm.assume(amt > 0 && amt <= 1000);
        uint256 id = _submitted(amt);
        vm.prank(evaluator);
        job.complete(id, "", "");
        assertEq(usdc.balanceOf(provider), amt);
        assertEq(usdc.balanceOf(client), uint256(1000) - amt);
        assertEq(usdc.balanceOf(address(job)), 0); // nothing stuck in escrow
    }
}
