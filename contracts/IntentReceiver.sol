// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Destination {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Struct compatível com `Client.Any2EVMMessage` do Chainlink CCIP.
struct Any2EVMMessage {
    bytes32 messageId;
    uint64 sourceChainSelector;
    bytes sender;
    bytes data;
}

/// @title IntentReceiver — perna de destino de intents cross-chain via CCIP
/// @notice Recebe mensagens apenas do router CCIP configurado, valida a lane (chain selector +
///         sender) e libera liquidez de destino pré-financiada pelo solver para o beneficiário.
/// @dev Referência executável, não auditada. Em produção, herdar de `CCIPReceiver` oficial,
///      importar `Client` do SDK, configurar o router por chain selector e monitorar mensagens
///      falhas (manual execution). O `paused` faz a mensagem reverter no `ccipReceive`, o que
///      exige reexecução manual — nunca descarte uma mensagem sem registrar o motivo.
contract IntentReceiver {
    address public immutable router;
    address public immutable destinationToken;
    address public admin;
    bool public paused;
    uint256 private _lock = 1;

    mapping(uint64 => mapping(bytes32 => bool)) public allowedLanes;
    mapping(address => uint256) public solverLiquidity;
    mapping(bytes32 => bool) public processedMessages;
    mapping(uint256 => bytes32) public filledIntents;

    event LaneConfigured(uint64 indexed sourceChainSelector, bytes32 indexed senderHash, bool allowed);
    event LiquidityDeposited(address indexed solver, uint256 amount);
    event LiquidityWithdrawn(address indexed solver, uint256 amount);
    event IntentFilled(
        bytes32 indexed messageId,
        uint256 indexed intentId,
        address indexed solver,
        address recipient,
        uint256 amountUnits,
        bytes32 intentDigest
    );
    event PausedSet(bool value);
    event AdminChanged(address indexed admin);

    error NotRouter();
    error NotAdmin();
    error IsPaused();
    error Reentrancy();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroMessageId();
    error LaneNotAllowed();
    error MessageReplayed();
    error IntentAlreadyFilled();
    error InvalidPayload();
    error InsufficientLiquidity();
    error TransferFailed();

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

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

    constructor(address admin_, address router_, address destinationToken_) {
        if (admin_ == address(0) || router_ == address(0) || destinationToken_ == address(0)) revert ZeroAddress();
        admin = admin_;
        router = router_;
        destinationToken = destinationToken_;
    }

    // ── Administração ────────────────────────────────────────────────────────

    function setLane(uint64 sourceChainSelector, bytes calldata sender, bool allowed) external onlyAdmin {
        if (sourceChainSelector == 0 || sender.length == 0) revert InvalidPayload();
        bytes32 senderHash = keccak256(sender);
        allowedLanes[sourceChainSelector][senderHash] = allowed;
        emit LaneConfigured(sourceChainSelector, senderHash, allowed);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    function setAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
        emit AdminChanged(next);
    }

    // ── Liquidez do solver ───────────────────────────────────────────────────

    function depositLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        solverLiquidity[msg.sender] += amount;
        _safeTransferFrom(destinationToken, msg.sender, address(this), amount);
        emit LiquidityDeposited(msg.sender, amount);
    }

    function withdrawLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (solverLiquidity[msg.sender] < amount) revert InsufficientLiquidity();
        solverLiquidity[msg.sender] -= amount;
        _safeTransfer(destinationToken, msg.sender, amount);
        emit LiquidityWithdrawn(msg.sender, amount);
    }

    // ── CCIP ─────────────────────────────────────────────────────────────────

    /// @notice Chamado pelo router CCIP após consenso/finality da lane.
    /// @param message.data ABI: (uint256 intentId, address solver, address recipient, uint256 amountUnits, bytes32 intentDigest)
    function ccipReceive(Any2EVMMessage calldata message) external onlyRouter whenActive nonReentrant {
        if (message.messageId == bytes32(0)) revert ZeroMessageId();
        if (!allowedLanes[message.sourceChainSelector][keccak256(message.sender)]) revert LaneNotAllowed();
        if (processedMessages[message.messageId]) revert MessageReplayed();

        (uint256 intentId, address solver, address recipient, uint256 amountUnits, bytes32 intentDigest) = abi
            .decode(message.data, (uint256, address, address, uint256, bytes32));
        if (intentId == 0 || solver == address(0) || recipient == address(0) || amountUnits == 0 || intentDigest == bytes32(0)) {
            revert InvalidPayload();
        }
        if (filledIntents[intentId] != bytes32(0)) revert IntentAlreadyFilled();
        if (solverLiquidity[solver] < amountUnits) revert InsufficientLiquidity();

        processedMessages[message.messageId] = true;
        filledIntents[intentId] = message.messageId;
        solverLiquidity[solver] -= amountUnits;

        _safeTransfer(destinationToken, recipient, amountUnits);

        emit IntentFilled(message.messageId, intentId, solver, recipient, amountUnits, intentDigest);
    }

    function laneAllows(uint64 sourceChainSelector, bytes calldata sender) external view returns (bool) {
        return allowedLanes[sourceChainSelector][keccak256(sender)];
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Destination.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Destination.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
