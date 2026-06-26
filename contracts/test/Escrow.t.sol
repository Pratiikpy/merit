// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract EscrowTest is Test {
    Escrow escrow;
    MockUSDC usdc;
    address buyer = makeAddr("buyer");
    address payee = makeAddr("payee");
    address validator = makeAddr("validator");
    bytes32 constant JOB = keccak256("job-1");

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new Escrow(address(usdc));
        usdc.mint(buyer, 1000);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _lock(uint256 amt) internal {
        vm.prank(buyer);
        escrow.lock(JOB, payee, validator, amt);
    }

    function test_lock_movesFunds() public {
        _lock(100);
        assertEq(usdc.balanceOf(address(escrow)), 100);
        assertEq(usdc.balanceOf(buyer), 900);
        assertEq(uint256(escrow.stateOf(JOB)), uint256(Escrow.State.Locked));
    }

    function test_release_paysPayee() public {
        _lock(100);
        vm.prank(validator);
        escrow.release(JOB);
        assertEq(usdc.balanceOf(payee), 100);
        assertEq(uint256(escrow.stateOf(JOB)), uint256(Escrow.State.Released));
    }

    function test_refund_paysBuyer() public {
        _lock(100);
        vm.prank(validator);
        escrow.refund(JOB);
        assertEq(usdc.balanceOf(buyer), 1000); // got it all back
        assertEq(uint256(escrow.stateOf(JOB)), uint256(Escrow.State.Refunded));
    }

    function test_onlyValidator_canRelease() public {
        _lock(100);
        vm.prank(buyer);
        vm.expectRevert(Escrow.NotValidator.selector);
        escrow.release(JOB);
    }

    function test_cannotLockTwice() public {
        _lock(100);
        vm.prank(buyer);
        vm.expectRevert(Escrow.AlreadyExists.selector);
        escrow.lock(JOB, payee, validator, 50);
    }

    function test_cannotReleaseUnlocked() public {
        vm.prank(validator);
        vm.expectRevert(Escrow.NotLocked.selector);
        escrow.release(JOB);
    }

    function test_zeroAmount_reverts() public {
        vm.prank(buyer);
        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.lock(JOB, payee, validator, 0);
    }

    function test_dispute_thenResolveToPayee() public {
        _lock(100);
        vm.prank(buyer);
        escrow.dispute(JOB);
        assertEq(uint256(escrow.stateOf(JOB)), uint256(Escrow.State.Disputed));
        vm.prank(validator);
        escrow.resolve(JOB, true);
        assertEq(usdc.balanceOf(payee), 100);
    }

    function test_nonParty_cannotDispute() public {
        _lock(100);
        vm.prank(validator); // validator is not buyer/payee
        vm.expectRevert(Escrow.NotParty.selector);
        escrow.dispute(JOB);
    }

    function test_noDoubleSpend_secondReleaseReverts() public {
        _lock(100);
        vm.prank(validator);
        escrow.release(JOB);
        vm.prank(validator);
        vm.expectRevert(Escrow.NotLocked.selector); // state guard blocks a second payout (reentrancy-safe via CEI)
        escrow.release(JOB);
        assertEq(usdc.balanceOf(payee), 100); // paid exactly once
    }

    function testFuzz_lockReleaseConservesFunds(uint96 amt) public {
        vm.assume(amt > 0 && amt <= 1000);
        vm.prank(buyer);
        escrow.lock(JOB, payee, validator, amt);
        vm.prank(validator);
        escrow.release(JOB);
        assertEq(usdc.balanceOf(payee), amt);
        assertEq(usdc.balanceOf(buyer), uint256(1000) - amt);
        assertEq(usdc.balanceOf(address(escrow)), 0); // nothing stuck in escrow
    }
}
