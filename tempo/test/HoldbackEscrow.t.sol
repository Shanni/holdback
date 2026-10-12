// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldbackEscrow} from "../src/HoldbackEscrow.sol";

/// 6-decimal ERC-20 standing in for a TIP-20 stablecoin.
contract MockUSD {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract HoldbackEscrowTest is Test {
    HoldbackEscrow escrow;
    MockUSD usd;

    address buyer = makeAddr("buyer");
    address merchant = makeAddr("merchant");
    address stranger = makeAddr("stranger");

    bytes32 constant ID = keccak256("bid-1");
    uint256 constant HOLD = 100e6;
    uint64 expiry;

    function setUp() public {
        escrow = new HoldbackEscrow();
        usd = new MockUSD();
        usd.mint(buyer, 1_000e6);
        vm.prank(buyer);
        usd.approve(address(escrow), type(uint256).max);
        expiry = uint64(block.timestamp + 1 days);
    }

    function _authorize(bool canReclaim) internal {
        vm.prank(buyer);
        escrow.authorize(ID, merchant, address(usd), HOLD, expiry, canReclaim);
    }

    function test_authorize_pullsFunds() public {
        vm.expectEmit(address(escrow));
        emit HoldbackEscrow.Authorized(ID, buyer, merchant, address(usd), HOLD, expiry, false);
        _authorize(false);
        assertEq(usd.balanceOf(address(escrow)), HOLD);
        assertEq(usd.balanceOf(buyer), 900e6);
        (address payer,, HoldbackEscrow.Status status,, address receiver, uint96 amount, address token) =
            escrow.payments(ID);
        assertEq(payer, buyer);
        assertEq(receiver, merchant);
        assertEq(token, address(usd));
        assertEq(amount, HOLD);
        assertEq(uint8(status), uint8(HoldbackEscrow.Status.Authorized));
    }

    function test_authorize_rejectsDuplicateId() public {
        _authorize(false);
        vm.prank(buyer);
        vm.expectRevert(HoldbackEscrow.PaymentExists.selector);
        escrow.authorize(ID, merchant, address(usd), HOLD, expiry, false);
    }

    function test_authorize_rejectsBadParams() public {
        vm.startPrank(buyer);
        vm.expectRevert(HoldbackEscrow.InvalidPayment.selector);
        escrow.authorize(ID, merchant, address(usd), 0, expiry, false);
        vm.expectRevert(HoldbackEscrow.InvalidPayment.selector);
        escrow.authorize(ID, merchant, address(usd), HOLD, uint64(block.timestamp), false);
        vm.expectRevert(HoldbackEscrow.InvalidPayment.selector);
        escrow.authorize(ID, address(0), address(usd), HOLD, expiry, false);
        vm.stopPrank();
    }

    function test_capturePartial_refundsRemainder() public {
        _authorize(false);
        vm.expectEmit(address(escrow));
        emit HoldbackEscrow.Captured(ID, 96e6, 4e6);
        vm.prank(merchant);
        escrow.capture(ID, 96e6);
        assertEq(usd.balanceOf(merchant), 96e6);
        assertEq(usd.balanceOf(buyer), 904e6);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    function test_captureFull() public {
        _authorize(false);
        vm.prank(merchant);
        escrow.capture(ID, HOLD);
        assertEq(usd.balanceOf(merchant), HOLD);
        assertEq(usd.balanceOf(buyer), 900e6);
    }

    function test_capture_tooLargeOrZero() public {
        _authorize(false);
        vm.startPrank(merchant);
        vm.expectRevert(HoldbackEscrow.CaptureTooLarge.selector);
        escrow.capture(ID, HOLD + 1);
        vm.expectRevert(HoldbackEscrow.CaptureTooLarge.selector);
        escrow.capture(ID, 0);
        vm.stopPrank();
    }

    function test_capture_unauthorized() public {
        _authorize(false);
        vm.prank(stranger);
        vm.expectRevert(HoldbackEscrow.Unauthorized.selector);
        escrow.capture(ID, 96e6);
        vm.prank(buyer);
        vm.expectRevert(HoldbackEscrow.Unauthorized.selector);
        escrow.capture(ID, 96e6);
    }

    function test_capture_afterExpiryReverts() public {
        _authorize(false);
        vm.warp(expiry);
        vm.prank(merchant);
        vm.expectRevert(HoldbackEscrow.AuthorizationExpired.selector);
        escrow.capture(ID, 96e6);
    }

    function test_void_refundsAll() public {
        _authorize(false);
        vm.expectEmit(address(escrow));
        emit HoldbackEscrow.Voided(ID, HOLD);
        vm.prank(merchant);
        escrow.void(ID);
        assertEq(usd.balanceOf(buyer), 1_000e6);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    function test_void_onlyReceiver() public {
        _authorize(false);
        vm.prank(buyer);
        vm.expectRevert(HoldbackEscrow.Unauthorized.selector);
        escrow.void(ID);
    }

    function test_reclaimBeforeExpiry_allowed() public {
        _authorize(true);
        vm.expectEmit(address(escrow));
        emit HoldbackEscrow.Reclaimed(ID, HOLD);
        vm.prank(buyer);
        escrow.reclaim(ID);
        assertEq(usd.balanceOf(buyer), 1_000e6);
    }

    function test_reclaimBeforeExpiry_notAllowed() public {
        _authorize(false);
        vm.prank(buyer);
        vm.expectRevert(HoldbackEscrow.ReclaimNotAllowed.selector);
        escrow.reclaim(ID);
    }

    function test_reclaimAfterExpiry_alwaysAllowed() public {
        _authorize(false);
        vm.warp(expiry);
        vm.prank(buyer);
        escrow.reclaim(ID);
        assertEq(usd.balanceOf(buyer), 1_000e6);
    }

    function test_reclaim_onlyPayer() public {
        _authorize(true);
        vm.prank(merchant);
        vm.expectRevert(HoldbackEscrow.Unauthorized.selector);
        escrow.reclaim(ID);
    }

    function test_doubleSettle_reverts() public {
        _authorize(true);
        vm.prank(merchant);
        escrow.capture(ID, 96e6);

        vm.prank(merchant);
        vm.expectRevert(HoldbackEscrow.NotAuthorized.selector);
        escrow.capture(ID, 1);
        vm.prank(merchant);
        vm.expectRevert(HoldbackEscrow.NotAuthorized.selector);
        escrow.void(ID);
        vm.warp(expiry);
        vm.prank(buyer);
        vm.expectRevert(HoldbackEscrow.NotAuthorized.selector);
        escrow.reclaim(ID);
        assertEq(usd.balanceOf(merchant), 96e6);
        assertEq(usd.balanceOf(buyer), 904e6);
    }

    function test_voidThenReclaim_reverts() public {
        _authorize(true);
        vm.prank(merchant);
        escrow.void(ID);
        vm.prank(buyer);
        vm.expectRevert(HoldbackEscrow.NotAuthorized.selector);
        escrow.reclaim(ID);
    }

    function test_unknownPayment_reverts() public {
        vm.prank(merchant);
        vm.expectRevert(HoldbackEscrow.NotAuthorized.selector);
        escrow.capture(keccak256("nope"), 1);
    }

    function testFuzz_capture_conservesFunds(uint256 captureAmount) public {
        captureAmount = bound(captureAmount, 1, HOLD);
        _authorize(false);
        vm.prank(merchant);
        escrow.capture(ID, captureAmount);
        assertEq(usd.balanceOf(merchant) + usd.balanceOf(buyer), 1_000e6);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }
}
