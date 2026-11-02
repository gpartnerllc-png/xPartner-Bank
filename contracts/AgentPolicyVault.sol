// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Agent {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title AgentPolicyVault — session keys de agente com allowlist, teto e expiração
/// @notice Referência do guardrail de agente autônomo do core: o lojista deposita saldo,
///         cria uma chave de sessão com alvos/seletores permitidos, teto de gasto e validade.
///         A chave só executa chamadas dentro da allowlist e nunca move mais que o teto.
/// @dev Não compilado/auditado. A chave de sessão deve ser gerada e custodiada pelo agente,
///      nunca pela tesouraria. Em produção, adicione limites por período e revogação em lote.
contract AgentPolicyVault {
    struct Session {
        bool active;
        uint256 expiresAt;
        uint256 spendCap;
        uint256 spent;
        uint256 nonce;
    }

    address public owner;
    address public stableToken;
    bool public paused;
    uint256 private _lock = 1;

    mapping(address => Session) public sessions;
    mapping(address => mapping(address => bool)) public allowedTarget;
    mapping(address => mapping(bytes4 => bool)) public allowedSelector;

    event SessionGranted(address indexed sessionKey, uint256 expiresAt, uint256 spendCap);
    event SessionRevoked(address indexed sessionKey);
    event TargetAllowed(address indexed sessionKey, address indexed target, bool allowed);
    event SelectorAllowed(address indexed sessionKey, bytes4 selector, bool allowed);
    event SessionExecuted(address indexed sessionKey, address indexed target, bytes4 selector, uint256 spendAmount);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event PausedSet(bool value);

    error NotOwner();
    error IsPaused();
    error Reentrancy();
    error ZeroAddress();
    error ZeroAmount();
    error SessionInactive();
    error SessionExpired();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error SpendCapExceeded();
    error CallFailed();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address owner_, address stableToken_) {
        if (owner_ == address(0) || stableToken_ == address(0)) revert ZeroAddress();
        owner = owner_;
        stableToken = stableToken_;
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function fund(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _safeTransfer(owner, amount);
        emit Withdrawn(owner, amount);
    }

    function grantSession(address sessionKey, uint256 expiresAt, uint256 spendCap) external onlyOwner {
        if (sessionKey == address(0)) revert ZeroAddress();
        if (expiresAt <= block.timestamp) revert SessionExpired();
        if (spendCap == 0) revert ZeroAmount();
        sessions[sessionKey] = Session({active: true, expiresAt: expiresAt, spendCap: spendCap, spent: 0, nonce: 0});
        emit SessionGranted(sessionKey, expiresAt, spendCap);
    }

    function revokeSession(address sessionKey) external onlyOwner {
        sessions[sessionKey].active = false;
        emit SessionRevoked(sessionKey);
    }

    function allowTarget(address sessionKey, address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedTarget[sessionKey][target] = allowed;
        emit TargetAllowed(sessionKey, target, allowed);
    }

    function allowSelector(address sessionKey, bytes4 selector, bool allowed) external onlyOwner {
        allowedSelector[sessionKey][selector] = allowed;
        emit SelectorAllowed(sessionKey, selector, allowed);
    }

    /// @notice Executa uma chamada da chave de sessão, transferindo no máximo `spendAmount` do saldo.
    ///         O alvo e o seletor precisam estar na allowlist; o teto é consumido antes da chamada.
    function execute(address sessionKey, address target, uint256 spendAmount, bytes calldata data)
        external
        nonReentrant
        returns (bytes memory result)
    {
        if (paused) revert IsPaused();
        Session storage session = sessions[sessionKey];
        if (!session.active) revert SessionInactive();
        if (block.timestamp >= session.expiresAt) revert SessionExpired();
        if (target == address(0)) revert ZeroAddress();
        if (!allowedTarget[sessionKey][target]) revert TargetNotAllowed();
        if (data.length < 4) revert CallFailed();

        bytes4 selector;
        assembly {
            selector := calldataload(data.offset)
        }
        if (!allowedSelector[sessionKey][selector]) revert SelectorNotAllowed();
        if (session.spent + spendAmount > session.spendCap) revert SpendCapExceeded();

        // Efeito antes da interação (checks-effects-interactions).
        session.spent += spendAmount;
        session.nonce += 1;

        if (spendAmount > 0) {
            _safeTransfer(target, spendAmount);
        }
        (bool ok, bytes memory callResult) = target.call(data);
        if (!ok) revert CallFailed();
        result = callResult;

        emit SessionExecuted(sessionKey, target, selector, spendAmount);
    }

    function remaining(address sessionKey) external view returns (uint256) {
        Session memory session = sessions[sessionKey];
        if (!session.active || block.timestamp >= session.expiresAt) return 0;
        return session.spendCap - session.spent;
    }

    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = stableToken.call(abi.encodeWithSelector(IERC20Agent.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            stableToken.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
