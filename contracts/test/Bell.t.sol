// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";

import {BellMarket} from "../src/BellMarket.sol";
import {MirrorFeedHub} from "../src/testnet/MirrorFeedHub.sol";
import {MirrorOracleRegistry} from "../src/testnet/MirrorOracleRegistry.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";

contract BellTest is Test {
    uint256 constant START = 1_800_000_000; // a Friday-ish timestamp; only relative times matter
    uint256 constant RAY = 1e27;

    MirrorFeedHub hub;
    MirrorOracleRegistry registry;
    BellMarket market;
    IB20 usd;
    IB20 aapl;
    IB20 tsla;
    uint256 aaplFeed;
    uint256 tslaFeed;
    uint80 round = 1;

    address lender = makeAddr("lender");
    address alice = makeAddr("alice");
    address liquidator = makeAddr("liquidator");

    function setUp() public {
        vm.warp(START);
        hub = new MirrorFeedHub(address(this));
        registry = new MirrorOracleRegistry(address(this));
        usd = IB20(
            StdPrecompiles.B20_FACTORY.createB20(
                IB20Factory.B20Variant.STABLECOIN,
                keccak256("bell-tusd"),
                B20FactoryLib.encodeStablecoinCreateParams("Test USD", "tUSD", address(this), "USD"),
                new bytes[](0)
            )
        );
        usd.grantRole(B20Constants.MINT_ROLE, address(this));
        (aapl, aaplFeed) = _stock("AAPL", 200e8);
        (tsla, tslaFeed) = _stock("TSLA", 400e8);

        market = new BellMarket(usd, IOracleRegistry(address(registry)), 0.02e27, 0.2e27);
        address aaplAdapter = hub.feed(aaplFeed).adapter;
        market.listCollateral(address(aapl), AggregatorV3Interface(aaplAdapter), 5000, 6500, 500, 26 hours);
        market.listCollateral(address(tsla), AggregatorV3Interface(hub.feed(tslaFeed).adapter), 4000, 5500, 750, 26 hours);

        usd.mint(lender, 100_000e6);
        vm.startPrank(lender);
        usd.approve(address(market), type(uint256).max);
        market.supply(100_000e6);
        vm.stopPrank();

        aapl.mint(alice, 100e8);
        tsla.mint(alice, 50e8);
        vm.startPrank(alice);
        aapl.approve(address(market), type(uint256).max);
        tsla.approve(address(market), type(uint256).max);
        usd.approve(address(market), type(uint256).max);
        market.depositCollateral(address(aapl), 100e8); // $20,000 at $200
        vm.stopPrank();

        usd.mint(liquidator, 50_000e6);
        vm.prank(liquidator);
        usd.approve(address(market), type(uint256).max);
    }

    function _stock(string memory t, int256 px) internal returns (IB20 token, uint256 feedId) {
        token = IB20(
            StdPrecompiles.B20_FACTORY.createB20(
                IB20Factory.B20Variant.ASSET,
                keccak256(bytes(string.concat("bell-", t))),
                B20FactoryLib.encodeAssetCreateParams(t, string.concat("t", t, "c"), address(this), 8),
                new bytes[](0)
            )
        );
        token.grantRole(B20Constants.MINT_ROLE, address(this));
        (feedId,) = hub.addFeed(address(0), 8, t);
        _print(feedId, px);
    }

    /// @dev Publishes a new feed round at the current time.
    function _print(uint256 feedId, int256 px) internal {
        uint256[] memory ids = new uint256[](1);
        uint80[] memory rounds = new uint80[](1);
        int256[] memory answers = new int256[](1);
        uint64[] memory ts = new uint64[](1);
        ids[0] = feedId;
        rounds[0] = ++round;
        answers[0] = px;
        ts[0] = uint64(block.timestamp);
        hub.relay(ids, rounds, answers, ts, ts);
        // The keeper pokes the market after every relay, so it sees every print.
        if (address(market) != address(0)) {
            if (feedId == aaplFeed) market.poke(address(aapl));
            else if (feedId == tslaFeed) market.poke(address(tsla));
        }
    }

    function _pause(IB20 token, bool paused) internal {
        address[] memory tokens = new address[](1);
        uint256[] memory mults = new uint256[](1);
        bool[] memory flags = new bool[](1);
        tokens[0] = address(token);
        mults[0] = 1e18;
        flags[0] = paused;
        registry.mirror(tokens, mults, flags);
    }

    function test_borrowAndAccrue() public {
        vm.prank(alice);
        market.borrow(8_000e6);
        assertEq(usd.balanceOf(alice), 8_000e6);
        assertEq(market.debtOf(alice), 8_000e6);
        vm.warp(block.timestamp + 365 days);
        // utilization 8% -> 2% + 20% x 8% = 3.6% a year
        assertApproxEqRel(market.debtOf(alice), 8_288e6, 0.001e18);
        assertApproxEqRel(market.assetsOf(lender), 100_288e6, 0.001e18);
        vm.prank(alice);
        usd.approve(address(market), type(uint256).max);
        usd.mint(alice, 1_000e6);
        vm.prank(alice);
        market.repay(type(uint256).max, alice);
        assertEq(market.debtOf(alice), 0);
        assertEq(market.totalScaledDebt(), 0);
    }

    function test_borrowPowerUsesLowerOfTwoPrints() public {
        _print(aaplFeed, 220e8); // up 10%: power still uses $200
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BellMarket.InsufficientBorrowPower.selector, 10_500e6, 10_000e6));
        market.borrow(10_500e6);
        _print(aaplFeed, 220e8); // a second print at $220 confirms the move
        vm.prank(alice);
        market.borrow(10_500e6);
        assertEq(market.borrowPowerOf(alice), 11_000e6);
    }

    function test_stalePriceGivesNoBorrowPower() public {
        vm.warp(block.timestamp + 27 hours);
        assertEq(market.borrowPowerOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BellMarket.InsufficientBorrowPower.selector, 1_000e6, 0));
        market.borrow(1_000e6);
    }

    function test_corporateActionPauseGivesNoBorrowPower() public {
        _pause(aapl, true);
        assertEq(market.borrowPowerOf(alice), 0);
        _pause(aapl, false);
        assertEq(market.borrowPowerOf(alice), 10_000e6);
    }

    function _borrowMax() internal {
        vm.prank(alice);
        market.borrow(10_000e6);
    }

    function test_openingGapNeedsASecondPrint() public {
        _borrowMax();
        // Friday close $200, then the market reopens 60h later 25% lower.
        vm.warp(block.timestamp + 60 hours);
        _print(aaplFeed, 150e8);
        // Liquidation values collateral at the higher print ($200): health 1.3, nobody can be liquidated yet.
        assertGt(market.healthFactorOf(alice), 1e18);
        vm.prank(liquidator);
        vm.expectPartialRevert(BellMarket.PositionHealthy.selector);
        market.liquidate(alice, address(aapl), 1_000e6);

        // Twenty minutes later a second print confirms the drop.
        vm.warp(block.timestamp + 20 minutes);
        _print(aaplFeed, 148e8);
        assertLt(market.healthFactorOf(alice), 1e18);
        uint256 debt = market.debtOf(alice);
        vm.prank(liquidator);
        uint256 seized = market.liquidate(alice, address(aapl), debt / 2);
        // seized = repay x 1.05 at the higher of the two prints ($150)
        assertApproxEqAbs(seized, (debt / 2) * 105 / 100 * 1e8 / 150e6, 1);
        assertEq(aapl.balanceOf(liquidator), seized);
        assertApproxEqAbs(market.debtOf(alice), debt - debt / 2, 2);
    }

    function test_noLiquidationDuringCorporateAction() public {
        _borrowMax();
        _print(aaplFeed, 150e8);
        _print(aaplFeed, 150e8);
        assertLt(market.healthFactorOf(alice), 1e18);
        _pause(aapl, true);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(BellMarket.CorporateActionPause.selector, address(aapl)));
        market.liquidate(alice, address(aapl), 1_000e6);
    }

    function test_noLiquidationOnStalePrice() public {
        _borrowMax();
        _print(aaplFeed, 150e8);
        _print(aaplFeed, 150e8);
        vm.warp(block.timestamp + 27 hours);
        vm.prank(liquidator);
        vm.expectPartialRevert(BellMarket.PriceStale.selector);
        market.liquidate(alice, address(aapl), 1_000e6);
    }

    function test_closeFactor() public {
        _borrowMax();
        _print(aaplFeed, 140e8);
        _print(aaplFeed, 140e8);
        uint256 debt = market.debtOf(alice);
        vm.prank(liquidator);
        vm.expectPartialRevert(BellMarket.ExceedsCloseFactor.selector);
        market.liquidate(alice, address(aapl), debt / 2 + 1e6);
    }

    function test_frozenCollateralCountsForHealthNotPower() public {
        vm.prank(alice);
        market.depositCollateral(address(tsla), 50e8); // $20,000 at $400
        assertEq(market.borrowPowerOf(alice), 18_000e6); // 10k AAPL + 8k TSLA
        _pause(tsla, true);
        assertEq(market.borrowPowerOf(alice), 10_000e6);
        vm.prank(alice);
        market.borrow(10_000e6);
        // health: AAPL 20k x 65% + TSLA 20k x 55% = 24k vs 10k debt
        assertEq(market.healthFactorOf(alice), 2.4e18);
    }

    function test_withdrawCollateralKeepsPower() public {
        vm.prank(alice);
        market.borrow(5_000e6);
        vm.prank(alice);
        vm.expectPartialRevert(BellMarket.InsufficientBorrowPower.selector);
        market.withdrawCollateral(address(aapl), 60e8);
        vm.prank(alice);
        market.withdrawCollateral(address(aapl), 40e8);
        assertEq(aapl.balanceOf(alice), 40e8);
    }

    function test_lenderCannotWithdrawBorrowedCash() public {
        vm.prank(alice);
        market.borrow(10_000e6);
        uint256 shares = market.sharesOf(lender);
        vm.prank(lender);
        vm.expectPartialRevert(BellMarket.InsufficientLiquidity.selector);
        market.withdraw(shares);
        vm.prank(lender);
        market.withdraw(shares / 2);
    }

    function test_listingRejectsUnsafeParams() public {
        AggregatorV3Interface feed = AggregatorV3Interface(hub.feed(aaplFeed).adapter);
        vm.expectRevert(BellMarket.BadConfig.selector);
        market.listCollateral(address(aapl), feed, 9000, 9600, 500, 1 days);
        vm.prank(alice);
        vm.expectRevert(BellMarket.NotOwner.selector);
        market.listCollateral(address(aapl), feed, 5000, 6500, 500, 1 days);
    }

    function testFuzz_singlePrintNeverLiquidates(uint256 dropBps) public {
        dropBps = bound(dropBps, 1, 9_000);
        _borrowMax();
        vm.warp(block.timestamp + 60 hours);
        _print(aaplFeed, int256(200e8 * (10_000 - dropBps) / 10_000));
        assertGe(market.healthFactorOf(alice), 1e18);
    }
}
