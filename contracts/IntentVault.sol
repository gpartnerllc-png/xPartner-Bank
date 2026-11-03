// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Intent {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title IntentVault — criação e liquidação atômica de intents cross-chain
/// @notice O criador deposita o ativo de origem em escrow e declara o mínimo aceito no destino;
///         um solver com liquidez pré-financiada em moeda de liquidação entrega o valor no
///         destino e recebe o ativo de origem. A taxa do solver é debitada dos proventos do
///         criador, como no core (`CCIP_INTENT_FEE`), e vai para o tesouro.
/// @dev Referência executável, não auditada. A entrega cross-chain real fica no
///      `IntentReceiver` (lado destino, somente router CCIP) e no relayer/CCIP que chama
///      `settleIntent` com o `messageId` entregue. Produção exige router oficial da Chainlink,
///      lane allowlist, limite por ativo, monitoramento de reorg e revisão jurídica.
contract IntentVault {
    struct Intent {
        address creator;
        uint256 sourceAmount;
        uint256 minDestUnits;
        uint256 feeBudget;
        uint256 deadline;
        address solver;
        uint256 destUnits;
        uint256 feeUnits;
        bytes32 messageId;
        uint8 status;
    }

    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_OPEN = 1;
    uint8 public constant STATUS_SETTLED = 2;
    uint8 public constant STATUS_CANCELLED = 3;

    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MIN_DEADLINE = 10 minutes;
    uint256 public constant MAX_DEADLINE = 30 days;

    address public admin;
    address public relayer;
    address public treasury;
    address public immutable sourceToken;
    address public immutable settlementToken;
    bool public paused;
    uint256 private _lock = 1;

    uint256 public nextIntentId = 1;
    uint256 public sequence;
    mapping(uint256 => Intent) public intents;
    mapping(address => uint256) public solverLiquidity;
    mapping(bytes32 => bool) public usedMessages;

    event IntentOpened(
        uint256 indexed intentId,
        address indexed creator,
        uint256 sourceAmount,
        uint256 minDestUnits,
        uint256 feeBudget,
        uint256 deadline
    );
    event IntentSettled(
        uint256 indexed intentId,
        address indexed solver,
        bytes32 indexed messageId,
        uint256 destUnits,
        uint256 feeUnits,
        bytes32 digest,
        uint256 sequence
    );
    event IntentCancelled(uint256 indexed intentId, address indexed creator, uint256 refunded);
    event SolverLiquidityDeposited(address indexed solver, uint256 amount);
    event SolverLiquidityWithdrawn(address indexed solver, uint256 amount);
    event RelayerChanged(address indexed relayer);
    event PausedSet(bool value);

    error NotAdmin();
    error NotRelayer();
    error NotCreator();
    error IsPaused();
    error Reentrancy();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidParameters();
    error IntentNotOpen();
    error IntentExpired();
    error DeadlineNotReached();
    error FeeAboveBudget();
    error MessageReplayed();
    error InsufficientSolverLiquidity();
    error TransferFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
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

    constructor(address admin_, address relayer_, address treasury_, address sourceToken_, address settlementToken_) {
        if (
            admin_ == address(0) ||
            relayer_ == address(0) ||
            treasury_ == address(0) ||
            sourceToken_ == address(0) ||
            settlementToken_ == address(0)
        ) revert ZeroAddress();
        admin = admin_;
        relayer = relayer_;
        treasury = treasury_;
        sourceToken = sourceToken_;
        settlementToken = settlementToken_;
    }

    function setRelayer(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        relayer = next;
        emit RelayerChanged(next);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    // ── Liquidez do solver ───────────────────────────────────────────────────

    /// @notice Pré-financia a moeda de liquidação que será entregue no destino.
    function depositSolverLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        solverLiquidity[msg.sender] += amount;
        _safeTransferFrom(settlementToken, msg.sender, address(this), amount);
        emit SolverLiquidityDeposited(msg.sender, amount);
    }

    function withdrawSolverLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (solverLiquidity[msg.sender] < amount) revert InsufficientSolverLiquidity();
        solverLiquidity[msg.sender] -= amount;
        _safeTransfer(settlementToken, msg.sender, amount);
        emit SolverLiquidityWithdrawn(msg.sender, amount);
    }

    // ── Intents ──────────────────────────────────────────────────────────────

    function createIntent(
        uint256 sourceAmount,
        uint256 minDestUnits,
        uint256 feeBudget,
        uint256 deadlineSeconds
    ) external nonReentrant whenActive returns (uint256 intentId) {
        if (sourceAmount == 0 || minDestUnits == 0) revert ZeroAmount();
        if (deadlineSeconds < MIN_DEADLINE || deadlineSeconds > MAX_DEADLINE) revert InvalidParameters();
        if (feeBudget > (minDestUnits * MAX_FEE_BPS) / 10_000) revert FeeAboveBudget();

        intentId = nextIntentId++;
        intents[intentId] = Intent({
            creator: msg.sender,
            sourceAmount: sourceAmount,
            minDestUnits: minDestUnits,
            feeBudget: feeBudget,
            deadline: block.timestamp + deadlineSeconds,
            solver: address(0),
            destUnits: 0,
            feeUnits: 0,
            messageId: bytes32(0),
            status: STATUS_OPEN
        });

        _safeTransferFrom(sourceToken, msg.sender, address(this), sourceAmount);
        emit IntentOpened(intentId, msg.sender, sourceAmount, minDestUnits, feeBudget, block.timestamp + deadlineSeconds);
    }

    /// @notice Liquida após confirmação da perna de destino (router/relayer CCIP).
    /// @dev Efeitos antes das transferências; `messageId` é único e funciona como anti-replay.
    function settleIntent(
        uint256 intentId,
        address solver,
        uint256 destUnits,
        uint256 feeUnits,
        bytes32 messageId
    ) external onlyRelayer nonReentrant whenActive {
        Intent storage intent = intents[intentId];
        if (intent.status != STATUS_OPEN) revert IntentNotOpen();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (solver == address(0)) revert ZeroAddress();
        if (destUnits < intent.minDestUnits) revert InvalidParameters();
        if (feeUnits > intent.feeBudget || feeUnits >= destUnits) revert FeeAboveBudget();
        if (messageId == bytes32(0) || usedMessages[messageId]) revert MessageReplayed();
        if (solverLiquidity[solver] < destUnits) revert InsufficientSolverLiquidity();

        usedMessages[messageId] = true;
        solverLiquidity[solver] -= destUnits;
        intent.solver = solver;
        intent.destUnits = destUnits;
        intent.feeUnits = feeUnits;
        intent.messageId = messageId;
        intent.status = STATUS_SETTLED;
        sequence += 1;

        bytes32 digest = keccak256(
            abi.encode(
                intentId,
                messageId,
                solver,
                intent.creator,
                intent.sourceAmount,
                destUnits,
                feeUnits,
                sequence
            )
        );

        uint256 payout = destUnits - feeUnits;
        if (payout > 0) _safeTransfer(settlementToken, intent.creator, payout);
        if (feeUnits > 0) _safeTransfer(settlementToken, treasury, feeUnits);
        _safeTransfer(sourceToken, solver, intent.sourceAmount);

        emit IntentSettled(intentId, solver, messageId, destUnits, feeUnits, digest, sequence);
    }

    /// @notice Cancelamento pelo criador antes do prazo; depois do prazo qualquer conta pode
    ///         devolver o escrow ao criador (keeper), sem mover fundos para terceiros.
    function cancelIntent(uint256 intentId) external nonReentrant {
        Intent storage intent = intents[intentId];
        if (intent.status != STATUS_OPEN) revert IntentNotOpen();
        if (block.timestamp <= intent.deadline && msg.sender != intent.creator) revert NotCreator();

        intent.status = STATUS_CANCELLED;
        _safeTransfer(sourceToken, intent.creator, intent.sourceAmount);
        emit IntentCancelled(intentId, intent.creator, intent.sourceAmount);
    }

    function supportsSourceEscrow(uint256 intentId) external view returns (bool) {
        return intents[intentId].status == STATUS_OPEN;
    }

    function isExpired(uint256 intentId) external view returns (bool) {
        Intent memory intent = intents[intentId];
        return intent.status == STATUS_OPEN && block.timestamp > intent.deadline;
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Intent.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Intent.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
