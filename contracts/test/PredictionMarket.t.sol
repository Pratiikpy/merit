// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract PredictionMarketTest is Test {
    PredictionMarket pm;
    MockUSDC usdc;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address oracle = makeAddr("oracle");
    bytes32 constant M = keccak256("market-1");

    function setUp() public {
        usdc = new MockUSDC();
        pm = new PredictionMarket(address(usdc), oracle);
        for (uint256 i; i < 2; i++) {
            address u = i == 0 ? alice : bob;
            usdc.mint(u, 1000);
            vm.prank(u);
            usdc.approve(address(pm), type(uint256).max);
        }
    }

    function _stake(address u, bool yes, uint256 amt) internal {
        vm.prank(u);
        pm.stake(M, yes, amt);
    }

    function test_probability_reflectsPool() public {
        assertEq(pm.yesProbabilityBps(M), 5000); // empty = 50/50
        _stake(alice, true, 300);
        _stake(bob, false, 100);
        assertEq(pm.yesProbabilityBps(M), 7500); // 300 / 400
    }

    function test_winnersSplitWholePool() public {
        _stake(alice, true, 300); // YES
        _stake(bob, false, 100); // NO
        vm.prank(oracle);
        pm.resolve(M, true); // YES wins
        vm.prank(alice);
        pm.redeem(M);
        assertEq(usdc.balanceOf(alice), 700 + 400); // staked 300, won the whole 400 pool
        // bob (loser) gets nothing
        vm.prank(bob);
        vm.expectRevert(PredictionMarket.NothingToRedeem.selector);
        pm.redeem(M);
    }

    function test_proRata_amongWinners() public {
        _stake(alice, true, 300);
        _stake(bob, true, 100);
        address carol = makeAddr("carol");
        usdc.mint(carol, 1000);
        vm.prank(carol);
        usdc.approve(address(pm), type(uint256).max);
        _stake(carol, false, 400); // NO loses
        vm.prank(oracle);
        pm.resolve(M, true);
        uint256 total = 800;
        vm.prank(alice);
        pm.redeem(M);
        vm.prank(bob);
        pm.redeem(M);
        assertEq(usdc.balanceOf(alice), 700 + (300 * total) / 400); // 600
        assertEq(usdc.balanceOf(bob), 900 + (100 * total) / 400); // 200
    }

    function test_onlyOracle_resolves() public {
        _stake(alice, true, 100);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NotOracle.selector);
        pm.resolve(M, true);
    }

    function test_noWinners_refundsEveryone() public {
        _stake(alice, false, 300); // only NO staked
        vm.prank(oracle);
        pm.resolve(M, true); // YES wins but nobody backed YES
        vm.prank(alice);
        pm.redeem(M);
        assertEq(usdc.balanceOf(alice), 1000); // fully refunded
    }

    function test_cannotRedeemTwice() public {
        _stake(alice, true, 100);
        vm.prank(oracle);
        pm.resolve(M, true);
        vm.prank(alice);
        pm.redeem(M);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.AlreadyRedeemed.selector);
        pm.redeem(M);
    }

    function testFuzz_solvency_payoutsNeverExceedPool(uint96 ay, uint96 bn) public {
        vm.assume(ay > 0 && ay <= 1000 && bn > 0 && bn <= 1000);
        _stake(alice, true, ay);
        _stake(bob, false, bn);
        vm.prank(oracle);
        pm.resolve(M, true); // YES wins → alice redeems the whole pool
        vm.prank(alice);
        pm.redeem(M);
        // alice (sole YES staker) takes the entire pool; nothing over-paid, only rounding dust may remain.
        assertLe(usdc.balanceOf(address(pm)), 1); // ≤ 1 unit of dust
        assertEq(usdc.balanceOf(alice), uint256(1000) - ay + uint256(ay) + bn);
    }
}
