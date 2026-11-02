// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Agro {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

/// @title AgroCreditVault — crédito agrícola com colateral tokenizado e oráculo
/// @notice Referência endurecida do crédito agro do core: colateral em escrow, LTV na abertura,
///         juros fixos, quitação com liberação do colateral e liquidação permissionless acima
///         do limiar. Preço do oráculo exige resposta positiva, decimais plausíveis e staleness.
/// @dev Não compilado/auditado. Em produção, usar agregadores com circuit breaker, limite por
///      safra e revisão jurídica da garantia (alienação fiduciária / CPR tokenizada).
contract AgroCreditVault {
    struct Loan {
        address borrower;
        uint256 collateralAmount;
        uint256 principal;
        uint256 outstanding;
        uint256 dueAt;
        uint256 ltvBps;
        uint256 liquidationLtvBps;
        bool active;
    }

    address public admin;
    address public stableToken;
    address public collateralToken;
    address public oracle;
    uint256 public maxStaleness = 1 hours;
    bool public paused;
    uint256 private _lock = 1;
    uint256 public nextLoanId = 1;

    mapping(uint256 => Loan) public loans;

    event LoanOpened(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 collateralAmount,
        uint256 principal,
        uint256 outstanding,
        uint256 ltvBps
    );
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 amount, uint256 remaining);
    event LoanLiquidated(
        uint256 indexed loanId,
        address indexed liquidator,
        uint256 debt,
        uint256 collateralAmount,
        uint256 collateralValue
    );
    event LiquidityDeposited(address indexed from, uint256 amount);
    event LiquidityWithdrawn(address indexed to, uint256 amount);
    event OracleChanged(address indexed oracle);
    event MaxStalenessChanged(uint256 seconds_);
    event PausedSet(bool value);

    error NotAdmin();
    error IsPaused();
    error Reentrancy();
    error ZeroAddress();
    error ZeroAmount();
    error LoanNotActive();
    error NotBorrower();
    error ExceedsLtv();
    error NotLiquidatable();
    error OracleInvalid();
    error OracleStale();
    error InsufficientLiquidity();
    error TransferFailed();
    error UnsupportedDecimals();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenActive() {
        if (paused) revert IsPaused();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address admin_, address stableToken_, address collateralToken_, address oracle_) {
        if (admin_ == address(0) || stableToken_ == address(0) || collateralToken_ == address(0) || oracle_ == address(0)) {
            revert ZeroAddress();
        }
        admin = admin_;
        stableToken = stableToken_;
        collateralToken = collateralToken_;
        oracle = oracle_;
        emit OracleChanged(oracle_);
        emit MaxStalenessChanged(maxStaleness);
    }

    function setOracle(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        oracle = next;
        emit OracleChanged(next);
    }

    function setMaxStaleness(uint256 seconds_) external onlyAdmin {
        if (seconds_ == 0 || seconds_ > 1 days) revert OracleInvalid();
        maxStaleness = seconds_;
        emit MaxStalenessChanged(seconds_);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    function depositLiquidity(uint256 amount) external nonReentrant whenActive {
        if (amount == 0) revert ZeroAmount();
        _safeTransferFrom(stableToken, msg.sender, address(this), amount);
        emit LiquidityDeposited(msg.sender, amount);
    }

    function withdrawLiquidity(uint256 amount) external onlyAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (IERC20Agro(stableToken).balanceOf(address(this)) < amount) revert InsufficientLiquidity();
        _safeTransfer(stableToken, msg.sender, amount);
        emit LiquidityWithdrawn(msg.sender, amount);
    }

    /// @notice Abre empréstimo com colateral em escrow e desembolso do pool.
    function open(
        uint256 collateralAmount,
        uint256 principal,
        uint256 interestBps,
        uint256 ltvBps,
        uint256 liquidationLtvBps,
        uint256 durationSeconds
    ) external nonReentrant whenActive returns (uint256 loanId) {
        if (collateralAmount == 0 || principal == 0) revert ZeroAmount();
        if (ltvBps == 0 || ltvBps > 9_000) revert ExceedsLtv();
        if (liquidationLtvBps < ltvBps || liquidationLtvBps > 10_000) revert ExceedsLtv();
        if (interestBps > 20_000) revert OracleInvalid();
        if (durationSeconds < 1 days || durationSeconds > 720 days) revert OracleInvalid();
        if (IERC20Agro(stableToken).balanceOf(address(this)) < principal) revert InsufficientLiquidity();

        uint256 collateralValue = _collateralValue(collateralAmount);
        uint256 maxPrincipal = (collateralValue * ltvBps) / 10_000;
        if (principal > maxPrincipal) revert ExceedsLtv();

        uint256 interest = (principal * interestBps) / 10_000;
        uint256 outstanding = principal + interest;

        _safeTransferFrom(collateralToken, msg.sender, address(this), collateralAmount);
        _safeTransfer(stableToken, msg.sender, principal);

        loanId = nextLoanId++;
        loans[loanId] = Loan({
            borrower: msg.sender,
            collateralAmount: collateralAmount,
            principal: principal,
            outstanding: outstanding,
            dueAt: block.timestamp + durationSeconds,
            ltvBps: ltvBps,
            liquidationLtvBps: liquidationLtvBps,
            active: true
        });

        emit LoanOpened(loanId, msg.sender, collateralAmount, principal, outstanding, ltvBps);
    }

    function repay(uint256 loanId, uint256 amount) external nonReentrant whenActive {
        Loan storage loan = loans[loanId];
        if (!loan.active) revert LoanNotActive();
        if (loan.borrower != msg.sender) revert NotBorrower();
        if (amount == 0) revert ZeroAmount();
        if (amount > loan.outstanding) revert ZeroAmount();

        uint256 remaining = loan.outstanding - amount;
        loan.outstanding = remaining;
        _safeTransferFrom(stableToken, msg.sender, address(this), amount);

        if (remaining == 0) {
            loan.active = false;
            _safeTransfer(collateralToken, msg.sender, loan.collateralAmount);
        }
        emit LoanRepaid(loanId, msg.sender, amount, remaining);
    }

    /// @notice Qualquer conta pode liquidar quando o LTV atinge o limiar; o liquidante assume a dívida
    ///         e recebe todo o colateral em escrow.
    function liquidate(uint256 loanId) external nonReentrant whenActive {
        Loan storage loan = loans[loanId];
        if (!loan.active) revert LoanNotActive();

        uint256 collateralValue = _collateralValue(loan.collateralAmount);
        if (collateralValue == 0) revert OracleInvalid();
        uint256 currentLtv = (loan.outstanding * 10_000) / collateralValue;
        if (currentLtv < loan.liquidationLtvBps) revert NotLiquidatable();

        uint256 debt = loan.outstanding;
        loan.outstanding = 0;
        loan.active = false;

        _safeTransferFrom(stableToken, msg.sender, address(this), debt);
        _safeTransfer(collateralToken, msg.sender, loan.collateralAmount);

        emit LoanLiquidated(loanId, msg.sender, debt, loan.collateralAmount, collateralValue);
    }

    function currentLtvBps(uint256 loanId) external view returns (uint256) {
        Loan memory loan = loans[loanId];
        if (!loan.active) return 0;
        uint256 collateralValue = _collateralValue(loan.collateralAmount);
        if (collateralValue == 0) return type(uint256).max;
        return (loan.outstanding * 10_000) / collateralValue;
    }

    function _collateralValue(uint256 collateralAmount) internal view returns (uint256) {
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = IAggregatorV3(oracle).latestRoundData();
        if (answer <= 0 || roundId == 0 || answeredInRound < roundId) revert OracleInvalid();
        if (updatedAt == 0 || block.timestamp - updatedAt > maxStaleness) revert OracleStale();
        uint8 oracleDecimals = IAggregatorV3(oracle).decimals();
        if (oracleDecimals > 18) revert UnsupportedDecimals();
        uint8 collateralDecimals = IERC20Agro(collateralToken).decimals();
        uint8 stableDecimals = IERC20Agro(stableToken).decimals();
        if (collateralDecimals > 36 || stableDecimals > 36) revert UnsupportedDecimals();

        uint256 numerator = collateralAmount * uint256(answer);
        uint256 denominator = 10 ** oracleDecimals;
        if (stableDecimals >= collateralDecimals) {
            numerator *= 10 ** (stableDecimals - collateralDecimals);
        } else {
            denominator *= 10 ** (collateralDecimals - stableDecimals);
        }
        return numerator / denominator;
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Agro.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Agro.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
