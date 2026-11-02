// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Paymaster {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title XPartnerPaymaster — patrocínio de UserOps com orçamento e anti-replay
/// @notice Referência do paymaster ERC-4337 do core: cada sponsor (lojista) tem orçamento,
///         teto por UserOp e teto global; o hash da UserOp é consumido uma única vez.
///         O EntryPoint chama `validatePaymasterUserOp`; `postOp` reconcilia o custo real.
/// @dev A struct de UserOperation é local para manter o arquivo autocontido. Em produção,
///      importe a interface oficial do EntryPoint v0.7/v0.8 e siga a especificação vigente.
///      Não compilado nem auditado.
contract XPartnerPaymaster {
    struct UserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        uint256 callGasLimit;
        uint256 verificationGasLimit;
        uint256 preVerificationGas;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        bytes paymasterAndData;
        bytes signature;
    }

    struct Budget {
        uint256 cap;
        uint256 spent;
        uint256 perOpMax;
        bool active;
    }

    struct Reservation {
        address sponsor;
        uint256 amount;
    }

    address public admin;
    address public entryPoint;
    address public stableToken;
    bool public paused;
    bool public senderAllowlistEnabled = true;

    mapping(address => Budget) public budgets; // sponsor => orçamento
    mapping(address => address) public sponsorOf; // sender => sponsor (lojista)
    mapping(address => bool) public senderAllowed;
    mapping(bytes32 => bool) public opConsumed;
    mapping(bytes32 => Reservation) public reservations;

    event BudgetConfigured(address indexed sponsor, uint256 cap, uint256 perOpMax, bool active);
    event SponsorAssigned(address indexed sender, address indexed sponsor);
    event SenderAllowlisted(address indexed sender, bool allowed);
    event UserOpSponsored(bytes32 indexed userOpHash, address indexed sender, address indexed sponsor, uint256 reserved);
    event UserOpSettled(bytes32 indexed userOpHash, uint256 reserved, uint256 actualCost);
    event Deposited(address indexed sponsor, uint256 amount);
    event Withdrawn(address indexed sponsor, uint256 amount);
    event EntryPointChanged(address indexed entryPoint);
    event PausedSet(bool value);

    error NotAdmin();
    error NotEntryPoint();
    error IsPaused();
    error ZeroAddress();
    error ZeroAmount();
    error UnknownSponsor();
    error SenderNotAllowed();
    error BudgetInactive();
    error OpLimitExceeded();
    error CapExceeded();
    error Replay();
    error UnknownOp();
    error TransferFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    constructor(address admin_, address entryPoint_, address stableToken_) {
        if (admin_ == address(0) || entryPoint_ == address(0) || stableToken_ == address(0)) revert ZeroAddress();
        admin = admin_;
        entryPoint = entryPoint_;
        stableToken = stableToken_;
        emit EntryPointChanged(entryPoint_);
    }

    function setEntryPoint(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        entryPoint = next;
        emit EntryPointChanged(next);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    function setSenderAllowlistEnabled(bool value) external onlyAdmin {
        senderAllowlistEnabled = value;
    }

    function allowSender(address sender, bool allowed) external onlyAdmin {
        if (sender == address(0)) revert ZeroAddress();
        senderAllowed[sender] = allowed;
        emit SenderAllowlisted(sender, allowed);
    }

    function assignSponsor(address sender, address sponsor) external onlyAdmin {
        if (sender == address(0) || sponsor == address(0)) revert ZeroAddress();
        sponsorOf[sender] = sponsor;
        emit SponsorAssigned(sender, sponsor);
    }

    function configureBudget(address sponsor, uint256 cap, uint256 perOpMax, bool active) external onlyAdmin {
        if (sponsor == address(0)) revert ZeroAddress();
        if (perOpMax == 0 || cap == 0 || perOpMax > cap) revert OpLimitExceeded();
        budgets[sponsor] = Budget({cap: cap, spent: budgets[sponsor].spent, perOpMax: perOpMax, active: active});
        emit BudgetConfigured(sponsor, cap, perOpMax, active);
    }

    function deposit(address sponsor, uint256 amount) external onlyAdmin {
        if (amount == 0) revert ZeroAmount();
        _safeTransferFrom(stableToken, sponsor, address(this), amount);
        emit Deposited(sponsor, amount);
    }

    function withdraw(address sponsor, uint256 amount) external onlyAdmin {
        if (amount == 0) revert ZeroAmount();
        _safeTransfer(stableToken, sponsor, amount);
        emit Withdrawn(sponsor, amount);
    }

    /// @notice Chamado pelo EntryPoint antes da execução. Reserva o custo máximo no orçamento.
    function validatePaymasterUserOp(UserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        if (paused) revert IsPaused();
        if (opConsumed[userOpHash]) revert Replay();
        if (senderAllowlistEnabled && !senderAllowed[userOp.sender]) revert SenderNotAllowed();

        address sponsor = sponsorOf[userOp.sender];
        if (sponsor == address(0)) revert UnknownSponsor();
        Budget storage budget = budgets[sponsor];
        if (!budget.active) revert BudgetInactive();
        if (maxCost == 0 || maxCost > budget.perOpMax) revert OpLimitExceeded();
        if (budget.spent + maxCost > budget.cap) revert CapExceeded();

        opConsumed[userOpHash] = true;
        budget.spent += maxCost;
        reservations[userOpHash] = Reservation({sponsor: sponsor, amount: maxCost});

        emit UserOpSponsored(userOpHash, userOp.sender, sponsor, maxCost);
        return (abi.encode(sponsor, maxCost), 0);
    }

    /// @notice Chamado pelo EntryPoint após a execução para reconciliar reserva e custo real.
    function postOp(bytes32 userOpHash, uint256 actualGasCost) external onlyEntryPoint {
        Reservation memory reservation = reservations[userOpHash];
        if (reservation.sponsor == address(0)) revert UnknownOp();
        delete reservations[userOpHash];

        uint256 reserved = reservation.amount;
        Budget storage budget = budgets[reservation.sponsor];
        if (actualGasCost >= reserved) {
            budget.spent += actualGasCost - reserved;
        } else {
            budget.spent -= reserved - actualGasCost;
        }
        emit UserOpSettled(userOpHash, reserved, actualGasCost);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Paymaster.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Paymaster.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
