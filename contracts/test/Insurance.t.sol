// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Insurance} from "../src/Insurance.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract InsuranceTest is Test {
    Insurance ins;
    MockUSDC usdc;
    address underwriter = makeAddr("underwriter");
    address buyer = makeAddr("buyer");
    address arbiter = makeAddr("arbiter");
    bytes32 constant POLICY = keccak256("policy-1");

    function setUp() public {
        usdc = new MockUSDC();
        ins = new Insurance(address(usdc), arbiter);
        usdc.mint(underwriter, 1000);
        usdc.mint(buyer, 1000);
        vm.prank(underwriter);
        usdc.approve(address(ins), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(ins), type(uint256).max);
    }

    function _deposit(uint256 amt) internal {
        vm.prank(underwriter);
        ins.deposit(amt);
    }

    function _bind(uint256 premium, uint256 coverage) internal {
        vm.prank(buyer);
        ins.bind(POLICY, underwriter, premium, coverage);
    }

    function test_bind_reservesCoverage_collectsPremium() public {
        _deposit(500);
        _bind(20, 300);
        assertEq(ins.reservedOf(underwriter), 300);
        assertEq(ins.poolOf(underwriter), 220); // 500 - 300 reserved + 20 premium
        assertEq(usdc.balanceOf(buyer), 980); // paid the premium
    }

    function test_bind_revertsIfPoolTooSmall() public {
        _deposit(100);
        vm.prank(buyer);
        vm.expectRevert(Insurance.InsufficientPool.selector);
        ins.bind(POLICY, underwriter, 20, 300);
    }

    function test_validClaim_paysBuyer() public {
        _deposit(500);
        _bind(20, 300);
        vm.prank(arbiter);
        ins.resolve(POLICY, true);
        assertEq(usdc.balanceOf(buyer), 980 + 300); // premium out, coverage in
        assertEq(ins.reservedOf(underwriter), 0);
        assertEq(ins.poolOf(underwriter), 220); // premium kept; coverage paid out
    }

    function test_invalidClaim_releasesReservation() public {
        _deposit(500);
        _bind(20, 300);
        vm.prank(arbiter);
        ins.resolve(POLICY, false);
        assertEq(ins.reservedOf(underwriter), 0);
        assertEq(ins.poolOf(underwriter), 520); // 220 + 300 reservation released; keeps the premium
    }

    function test_onlyArbiter_resolves() public {
        _deposit(500);
        _bind(20, 300);
        vm.prank(buyer);
        vm.expectRevert(Insurance.NotArbiter.selector);
        ins.resolve(POLICY, true);
    }

    function test_cannotWithdrawReserved() public {
        _deposit(500);
        _bind(0, 300); // 200 free, 300 reserved
        vm.prank(underwriter);
        vm.expectRevert(Insurance.InsufficientPool.selector);
        ins.withdraw(250); // only 200 is free
        vm.prank(underwriter);
        ins.withdraw(200); // the free part is withdrawable
        assertEq(ins.poolOf(underwriter), 0);
    }

    function testFuzz_solvency(uint96 dep, uint96 prem, uint96 cov, bool valid) public {
        vm.assume(dep > 0 && dep <= 1000 && cov > 0 && cov <= dep && prem <= 1000);
        _deposit(dep);
        _bind(prem, cov);
        vm.prank(arbiter);
        ins.resolve(POLICY, valid);
        // The contract holds exactly the free pool (reserved is 0 after resolve); funds are conserved.
        assertEq(usdc.balanceOf(address(ins)), ins.poolOf(underwriter) + ins.reservedOf(underwriter));
        assertEq(ins.reservedOf(underwriter), 0);
    }
}
