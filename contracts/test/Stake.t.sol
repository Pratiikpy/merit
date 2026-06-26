// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Stake} from "../src/Stake.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract StakeTest is Test {
    Stake stk;
    MockUSDC usdc;
    address source = makeAddr("source");
    address slasher = makeAddr("slasher");
    address treasury = makeAddr("treasury");
    uint256 constant COOLDOWN = 1 days;

    function setUp() public {
        usdc = new MockUSDC();
        stk = new Stake(address(usdc), slasher, treasury, COOLDOWN);
        usdc.mint(source, 1000);
        vm.prank(source);
        usdc.approve(address(stk), type(uint256).max);
    }

    function _stake(uint256 amt) internal {
        vm.prank(source);
        stk.stake(amt);
    }

    function test_stake_movesFundsAndRecords() public {
        _stake(500);
        assertEq(stk.stakeOf(source), 500);
        assertEq(stk.totalStaked(), 500);
        assertEq(usdc.balanceOf(address(stk)), 500);
    }

    function test_onlySlasher_canSlash() public {
        _stake(500);
        vm.prank(source);
        vm.expectRevert(Stake.NotSlasher.selector);
        stk.slash(source, 100, "nope");
    }

    function test_slash_movesToTreasury_cappedAtStake() public {
        _stake(500);
        vm.prank(slasher);
        stk.slash(source, 200, "false citation");
        assertEq(stk.stakeOf(source), 300);
        assertEq(usdc.balanceOf(treasury), 200);
        assertEq(stk.totalSlashed(), 200);
        // slashing more than remains is capped
        vm.prank(slasher);
        stk.slash(source, 9999, "again");
        assertEq(stk.stakeOf(source), 0);
        assertEq(usdc.balanceOf(treasury), 500); // never more than was staked
    }

    function test_withdraw_requiresCooldown() public {
        _stake(500);
        vm.prank(source);
        vm.expectRevert(Stake.StillLocked.selector); // no requestWithdraw yet
        stk.withdraw();

        vm.prank(source);
        stk.requestWithdraw();
        vm.prank(source);
        vm.expectRevert(Stake.StillLocked.selector); // cooldown not elapsed
        stk.withdraw();

        vm.warp(block.timestamp + COOLDOWN + 1);
        vm.prank(source);
        stk.withdraw();
        assertEq(stk.stakeOf(source), 0);
        assertEq(usdc.balanceOf(source), 1000); // got it all back
    }

    function test_slashWhileWithdrawing_stillWorks() public {
        _stake(500);
        vm.prank(source);
        stk.requestWithdraw();
        // slasher can still slash during the cooldown — the point of the delay
        vm.prank(slasher);
        stk.slash(source, 500, "caught before withdraw");
        assertEq(stk.stakeOf(source), 0);
        assertEq(usdc.balanceOf(treasury), 500);
    }

    function test_staking_cancelsPendingWithdrawal() public {
        _stake(300);
        vm.prank(source);
        stk.requestWithdraw();
        _stake(200); // top up resets the cooldown
        (, uint256 unlockAt) = stk.stakes(source);
        assertEq(unlockAt, 0);
    }

    function testFuzz_stakeSlashWithdrawConserves(uint96 amt, uint96 slashReq) public {
        vm.assume(amt > 0 && amt <= 1000);
        _stake(amt);
        vm.prank(slasher);
        stk.slash(source, slashReq, "fuzz");
        uint256 slashed = slashReq > amt ? amt : slashReq;
        assertEq(usdc.balanceOf(treasury), slashed);
        uint256 remaining = uint256(amt) - slashed;
        assertEq(stk.stakeOf(source), remaining);
        // withdraw the remainder, if any (requestWithdraw rightly reverts on a fully-slashed zero stake)
        if (remaining > 0) {
            vm.prank(source);
            stk.requestWithdraw();
            vm.warp(block.timestamp + COOLDOWN + 1);
            vm.prank(source);
            stk.withdraw();
        }
        assertEq(usdc.balanceOf(address(stk)), 0); // nothing stuck
        assertEq(usdc.balanceOf(source) + usdc.balanceOf(treasury), 1000); // funds conserved
    }
}
