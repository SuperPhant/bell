// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IB20} from "base-std/interfaces/IB20.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IOracleRegistry} from "./interfaces/IOracleRegistry.sol";

/// @title BellMarket
/// @notice Borrow USD against Coinbase tokenized stocks on Base, with liquidations that respect the closing bell.
///
///         Stocks are not crypto: their Chainlink feeds stop over nights, weekends and holidays, freeze during
///         corporate actions (when Coinbase's oracle registry flags the token as paused), and gap at the open.
///         A crypto-style lending market liquidates people on exactly those prints. Bell does not:
///
///         - Two-print pricing. The market remembers the last two feed rounds it has seen for every stock.
///           Borrowing power uses the lower of the two; liquidations use the higher. A single print, such as a
///           Monday opening gap, can never liquidate anyone; the next print has to confirm it.
///         - Frozen means frozen. If a price is older than the stock's `maxPriceAge` or the registry flags a
///           corporate action, the stock gives zero borrowing power and cannot be seized. It still counts toward
///           the borrower's health at its higher print, so a freeze cannot trigger a liquidation either.
///         - Total-return prices. Feeds report price x B20 multiplier, so raw token balances are valued directly and
///           splits or reinvested dividends never move a position's value.
contract BellMarket {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    uint256 public constant CLOSE_FACTOR_BPS = 5_000;
    uint256 public constant MAX_COLLATERALS = 16;
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    struct CollateralConfig {
        AggregatorV3Interface feed;
        uint16 ltvBps;
        uint16 liquidationThresholdBps;
        uint16 liquidationBonusBps;
        uint32 maxPriceAge;
        bool enabled;
    }

    struct Observation {
        uint80 lastRound;
        uint80 prevRound;
        int256 lastAnswer;
        int256 prevAnswer;
    }

    struct PriceView {
        uint256 latest;
        uint256 low;
        uint256 high;
        uint256 updatedAt;
        uint8 decimals;
        bool confirmed;
        bool stale;
        bool paused;
    }

    struct CollateralPosition {
        address token;
        uint256 balance;
        uint256 valueLow;
        uint256 valueHigh;
        bool live;
    }

    IB20 public immutable asset;
    uint8 public immutable assetDecimals;
    IOracleRegistry public immutable registry;
    address public owner;

    uint256 public baseRatePerYearRay;
    uint256 public slopeRatePerYearRay;

    uint256 public totalShares;
    mapping(address account => uint256) public sharesOf;

    uint256 public borrowIndex;
    uint64 public lastAccrual;
    uint256 public totalScaledDebt;
    mapping(address account => uint256) public scaledDebtOf;

    mapping(address token => CollateralConfig) public configOf;
    address[] internal _collaterals;
    mapping(address token => Observation) public observationOf;
    mapping(address account => mapping(address token => uint256)) public collateralOf;

    bool internal _locked;

    event Supplied(address indexed account, uint256 assets, uint256 shares);
    event Withdrawn(address indexed account, uint256 assets, uint256 shares);
    event CollateralDeposited(address indexed account, address indexed token, uint256 amount);
    event CollateralWithdrawn(address indexed account, address indexed token, uint256 amount);
    event Borrowed(address indexed account, uint256 amount, uint256 debtAfter);
    event Repaid(address indexed payer, address indexed account, uint256 amount, uint256 debtAfter);
    event Liquidated(
        address indexed liquidator,
        address indexed account,
        address indexed token,
        uint256 repaid,
        uint256 seized,
        uint256 price,
        uint256 healthFactorBefore
    );
    event Observed(address indexed token, uint80 roundId, int256 answer);
    event CollateralListed(address indexed token, address feed, uint16 ltvBps, uint16 thresholdBps, uint16 bonusBps, uint32 maxAge);
    event RatesSet(uint256 baseRatePerYearRay, uint256 slopeRatePerYearRay);

    error NotOwner();
    error Reentrancy();
    error ZeroAmount();
    error NotListed(address token);
    error BadConfig();
    error TooManyCollaterals();
    error BadPrice(address token);
    error InsufficientLiquidity(uint256 available, uint256 requested);
    error InsufficientBorrowPower(uint256 debtAfter, uint256 borrowPower);
    error InsufficientCollateral(uint256 balance, uint256 requested);
    error PriceStale(address token, uint256 updatedAt, uint256 maxAge);
    error CorporateActionPause(address token);
    error PositionHealthy(uint256 healthFactor);
    error ExceedsCloseFactor(uint256 repay, uint256 maxRepay);
    error NothingToSeize();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(IB20 asset_, IOracleRegistry registry_, uint256 baseRatePerYearRay_, uint256 slopeRatePerYearRay_) {
        asset = asset_;
        assetDecimals = asset_.decimals();
        registry = registry_;
        owner = msg.sender;
        borrowIndex = RAY;
        lastAccrual = uint64(block.timestamp);
        _setRates(baseRatePerYearRay_, slopeRatePerYearRay_);
    }

    /*//////////////////////////////////////////////////////////////
                                ADMIN
    //////////////////////////////////////////////////////////////*/

    function listCollateral(
        address token,
        AggregatorV3Interface feed,
        uint16 ltvBps,
        uint16 liquidationThresholdBps,
        uint16 liquidationBonusBps,
        uint32 maxPriceAge
    ) external onlyOwner {
        // ltv < threshold, and seizing threshold x (1 + bonus) of the debt must stay below 100% of the collateral.
        if (
            ltvBps == 0 || ltvBps >= liquidationThresholdBps || liquidationBonusBps > 2_000 || maxPriceAge == 0
                || uint256(liquidationThresholdBps) * (BPS + liquidationBonusBps) >= BPS * BPS
        ) revert BadConfig();
        if (!configOf[token].enabled && address(configOf[token].feed) == address(0)) {
            if (_collaterals.length >= MAX_COLLATERALS) revert TooManyCollaterals();
            _collaterals.push(token);
        }
        configOf[token] = CollateralConfig(feed, ltvBps, liquidationThresholdBps, liquidationBonusBps, maxPriceAge, true);
        _poke(token);
        emit CollateralListed(token, address(feed), ltvBps, liquidationThresholdBps, liquidationBonusBps, maxPriceAge);
    }

    function setRates(uint256 baseRatePerYearRay_, uint256 slopeRatePerYearRay_) external onlyOwner {
        _accrue();
        _setRates(baseRatePerYearRay_, slopeRatePerYearRay_);
    }

    function transferOwnership(address owner_) external onlyOwner {
        owner = owner_;
    }

    /*//////////////////////////////////////////////////////////////
                                LENDERS
    //////////////////////////////////////////////////////////////*/

    function supply(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        _accrue();
        shares = assets * (totalShares + VIRTUAL_SHARES) / (totalAssets() + VIRTUAL_ASSETS);
        asset.transferFrom(msg.sender, address(this), assets);
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Supplied(msg.sender, assets, shares);
    }

    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        _accrue();
        assets = shares * (totalAssets() + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
        uint256 cash = asset.balanceOf(address(this));
        if (assets > cash) revert InsufficientLiquidity(cash, assets);
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        asset.transfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /*//////////////////////////////////////////////////////////////
                               BORROWERS
    //////////////////////////////////////////////////////////////*/

    function depositCollateral(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!configOf[token].enabled) revert NotListed(token);
        _poke(token);
        IB20(token).transferFrom(msg.sender, address(this), amount);
        collateralOf[msg.sender][token] += amount;
        emit CollateralDeposited(msg.sender, token, amount);
    }

    function withdrawCollateral(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = collateralOf[msg.sender][token];
        if (amount > bal) revert InsufficientCollateral(bal, amount);
        _accrue();
        _pokeAll();
        collateralOf[msg.sender][token] = bal - amount;
        uint256 debt = debtOf(msg.sender);
        if (debt != 0) {
            uint256 power = borrowPowerOf(msg.sender);
            if (debt > power) revert InsufficientBorrowPower(debt, power);
        }
        IB20(token).transfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, token, amount);
    }

    function borrow(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        _pokeAll();
        uint256 cash = asset.balanceOf(address(this));
        if (amount > cash) revert InsufficientLiquidity(cash, amount);
        uint256 debtAfter = debtOf(msg.sender) + amount;
        uint256 power = borrowPowerOf(msg.sender);
        if (debtAfter > power) revert InsufficientBorrowPower(debtAfter, power);
        uint256 scaled = _divUp(amount * RAY, borrowIndex);
        scaledDebtOf[msg.sender] += scaled;
        totalScaledDebt += scaled;
        asset.transfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount, debtAfter);
    }

    function repay(uint256 amount, address account) external nonReentrant returns (uint256 paid) {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        paid = _reduceDebt(account, amount);
        asset.transferFrom(msg.sender, address(this), paid);
        emit Repaid(msg.sender, account, paid, debtOf(account));
    }

    /*//////////////////////////////////////////////////////////////
                              LIQUIDATORS
    //////////////////////////////////////////////////////////////*/

    /// @notice Repays up to half of an unhealthy account's debt and seizes `token` worth the repayment plus the
    ///         bonus, priced at the higher of the stock's last two prints. Reverts while the stock's price is stale
    ///         or under a corporate-action pause.
    function liquidate(address account, address token, uint256 repayAmount)
        external
        nonReentrant
        returns (uint256 seized)
    {
        if (repayAmount == 0) revert ZeroAmount();
        CollateralConfig memory c = configOf[token];
        if (!c.enabled) revert NotListed(token);
        _accrue();
        _pokeAll();

        PriceView memory p = priceOf(token);
        if (p.paused) revert CorporateActionPause(token);
        if (p.stale) revert PriceStale(token, p.updatedAt, c.maxPriceAge);

        uint256 hf = healthFactorOf(account);
        if (hf >= WAD) revert PositionHealthy(hf);

        uint256 debt = debtOf(account);
        uint256 maxRepay = debt * CLOSE_FACTOR_BPS / BPS;
        if (debt < 10 ** assetDecimals) maxRepay = debt;
        if (repayAmount > maxRepay) revert ExceedsCloseFactor(repayAmount, maxRepay);

        uint256 bal = collateralOf[account][token];
        if (bal == 0) revert NothingToSeize();
        seized = _unitsFor(token, repayAmount * (BPS + c.liquidationBonusBps) / BPS, p.high, p.decimals);
        if (seized > bal) {
            seized = bal;
            repayAmount = _valueOf(token, bal, p.high, p.decimals) * BPS / (BPS + c.liquidationBonusBps);
        }

        uint256 paid = _reduceDebt(account, repayAmount);
        asset.transferFrom(msg.sender, address(this), paid);
        collateralOf[account][token] = bal - seized;
        IB20(token).transfer(msg.sender, seized);
        emit Liquidated(msg.sender, account, token, paid, seized, p.high, hf);
    }

    /// @notice Records the latest feed round for `token`; anyone may call. Every state-changing entry point pokes
    ///         the stocks it touches, so the market always knows the last two prints.
    function poke(address token) external {
        if (!configOf[token].enabled) revert NotListed(token);
        _poke(token);
    }

    /// @notice Records the latest round of every listed stock (what the keeper calls after each price relay).
    function pokeAll() external {
        _pokeAll();
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function collaterals() external view returns (address[] memory) {
        return _collaterals;
    }

    function priceOf(address token) public view returns (PriceView memory p) {
        CollateralConfig memory c = configOf[token];
        if (address(c.feed) == address(0)) revert NotListed(token);
        (uint80 rid, int256 answer,, uint256 updatedAt,) = c.feed.latestRoundData();
        if (answer <= 0) revert BadPrice(token);
        Observation memory o = observationOf[token];
        int256 prev = answer;
        if (rid == o.lastRound) {
            if (o.prevRound != 0 && o.prevAnswer > 0) {
                prev = o.prevAnswer;
                p.confirmed = true;
            }
        } else if (o.lastRound != 0 && o.lastAnswer > 0) {
            prev = o.lastAnswer;
            p.confirmed = true;
        }
        p.latest = uint256(answer);
        p.low = uint256(answer < prev ? answer : prev);
        p.high = uint256(answer > prev ? answer : prev);
        p.updatedAt = updatedAt;
        p.decimals = c.feed.decimals();
        p.stale = block.timestamp > updatedAt + c.maxPriceAge;
        try registry.getOracleParams(token) returns (uint256, bool paused) {
            p.paused = paused;
        } catch {
            p.paused = true;
        }
    }

    function debtOf(address account) public view returns (uint256) {
        return _divUp(scaledDebtOf[account] * _currentIndex(), RAY);
    }

    /// @notice USD the account may owe in total: live collateral at its lower print times its LTV.
    function borrowPowerOf(address account) public view returns (uint256 power) {
        for (uint256 i; i < _collaterals.length; ++i) {
            address token = _collaterals[i];
            uint256 bal = collateralOf[account][token];
            if (bal == 0) continue;
            PriceView memory p = priceOf(token);
            if (p.stale || p.paused) continue;
            power += _valueOf(token, bal, p.low, p.decimals) * configOf[token].ltvBps / BPS;
        }
    }

    /// @notice Collateral at its higher print times the liquidation threshold, over debt (WAD). Below 1e18 the
    ///         account can be liquidated, but only through stocks whose price is live.
    function healthFactorOf(address account) public view returns (uint256) {
        uint256 debt = debtOf(account);
        if (debt == 0) return type(uint256).max;
        uint256 v;
        for (uint256 i; i < _collaterals.length; ++i) {
            address token = _collaterals[i];
            uint256 bal = collateralOf[account][token];
            if (bal == 0) continue;
            PriceView memory p = priceOf(token);
            v += _valueOf(token, bal, p.high, p.decimals) * configOf[token].liquidationThresholdBps / BPS;
        }
        return v * WAD / debt;
    }

    function positionOf(address account)
        external
        view
        returns (uint256 debt, uint256 borrowPower, uint256 healthFactor, CollateralPosition[] memory positions)
    {
        debt = debtOf(account);
        borrowPower = borrowPowerOf(account);
        healthFactor = healthFactorOf(account);
        positions = new CollateralPosition[](_collaterals.length);
        for (uint256 i; i < _collaterals.length; ++i) {
            address token = _collaterals[i];
            uint256 bal = collateralOf[account][token];
            CollateralPosition memory cp;
            cp.token = token;
            cp.balance = bal;
            PriceView memory p = priceOf(token);
            cp.live = !p.stale && !p.paused;
            if (bal != 0) {
                cp.valueLow = _valueOf(token, bal, p.low, p.decimals);
                cp.valueHigh = _valueOf(token, bal, p.high, p.decimals);
            }
            positions[i] = cp;
        }
    }

    function totalDebt() public view returns (uint256) {
        return totalScaledDebt * _currentIndex() / RAY;
    }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this)) + totalDebt();
    }

    function utilizationBps() public view returns (uint256) {
        return _utilizationAt(_currentIndex());
    }

    function borrowRatePerYearRay() public view returns (uint256) {
        return _rateAt(_currentIndex());
    }

    function supplyRatePerYearRay() external view returns (uint256) {
        uint256 idx = _currentIndex();
        return _rateAt(idx) * _utilizationAt(idx) / BPS;
    }

    function assetsOf(address account) external view returns (uint256) {
        return sharesOf[account] * (totalAssets() + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _setRates(uint256 base, uint256 slope) internal {
        if (base > RAY || slope > 5 * RAY) revert BadConfig();
        baseRatePerYearRay = base;
        slopeRatePerYearRay = slope;
        emit RatesSet(base, slope);
    }

    function _utilizationAt(uint256 index) internal view returns (uint256) {
        uint256 debt = totalScaledDebt * index / RAY;
        uint256 total = asset.balanceOf(address(this)) + debt;
        return total == 0 ? 0 : debt * BPS / total;
    }

    function _rateAt(uint256 index) internal view returns (uint256) {
        return baseRatePerYearRay + slopeRatePerYearRay * _utilizationAt(index) / BPS;
    }

    /// @dev Interest since the last accrual is charged at the rate implied by utilization at that accrual.
    function _currentIndex() internal view returns (uint256) {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0 || totalScaledDebt == 0) return borrowIndex;
        return borrowIndex + borrowIndex * _rateAt(borrowIndex) * dt / (YEAR * RAY);
    }

    function _accrue() internal {
        borrowIndex = _currentIndex();
        lastAccrual = uint64(block.timestamp);
    }

    function _reduceDebt(address account, uint256 amount) internal returns (uint256 paid) {
        uint256 debt = debtOf(account);
        paid = amount > debt ? debt : amount;
        uint256 scaled = paid == debt ? scaledDebtOf[account] : paid * RAY / borrowIndex;
        scaledDebtOf[account] -= scaled;
        totalScaledDebt -= scaled;
    }

    function _poke(address token) internal {
        (uint80 rid, int256 answer,,,) = configOf[token].feed.latestRoundData();
        Observation storage o = observationOf[token];
        if (rid == o.lastRound || answer <= 0) return;
        o.prevRound = o.lastRound;
        o.prevAnswer = o.lastAnswer;
        o.lastRound = rid;
        o.lastAnswer = answer;
        emit Observed(token, rid, answer);
    }

    function _pokeAll() internal {
        for (uint256 i; i < _collaterals.length; ++i) {
            if (configOf[_collaterals[i]].enabled) _poke(_collaterals[i]);
        }
    }

    function _valueOf(address token, uint256 raw, uint256 price, uint8 feedDecimals) internal view returns (uint256) {
        return raw * price * 10 ** assetDecimals / 10 ** (uint256(IB20(token).decimals()) + feedDecimals);
    }

    function _unitsFor(address token, uint256 value, uint256 price, uint8 feedDecimals) internal view returns (uint256) {
        return value * 10 ** (uint256(IB20(token).decimals()) + feedDecimals) / (price * 10 ** assetDecimals);
    }

    function _divUp(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
