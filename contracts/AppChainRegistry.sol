// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AppChainRegistry — registro de appchains, subnets e L2 do xPartner
/// @notice Catálogo on-chain das redes homologadas, com chainId único, contratos de
///         interoperabilidade, governança, finalidade e pausa. Espelha `web3_networks` do core.
/// @dev Não compilado/auditado. Em produção, a escrita deve ficar atrás de multisig/timelock
///      e a leitura deve ser consumida por validadores de ponte com quórum independente.
contract AppChainRegistry {
    struct Network {
        string name;
        uint256 chainId;
        bytes32 kind; // APPCHAIN, SUBNET, L2, L1
        string rpcUrl;
        string explorerUrl;
        address bridgeContract;
        address tokenContract;
        address dvpContract;
        address paymasterContract;
        address governance;
        uint256 finalitySeconds;
        bool active;
    }

    address public admin;
    bool public paused;
    uint256 public networkCount;

    mapping(uint256 => Network) private _networks; // chainId => rede
    mapping(uint256 => bool) public registered;

    event NetworkRegistered(uint256 indexed chainId, string name, bytes32 kind, address indexed governance);
    event NetworkUpdated(uint256 indexed chainId, bool active, uint256 finalitySeconds);
    event AdminChanged(address indexed admin);
    event PausedSet(bool value);

    error NotAdmin();
    error IsPaused();
    error ZeroAddress();
    error AlreadyRegistered();
    error UnknownNetwork();
    error InvalidChainId();
    error InvalidKind();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenActive() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminChanged(admin_);
    }

    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
        emit AdminChanged(next);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    function register(
        string calldata name,
        uint256 chainId,
        bytes32 kind,
        string calldata rpcUrl,
        string calldata explorerUrl,
        address bridgeContract,
        address tokenContract,
        address dvpContract,
        address paymasterContract,
        address governance,
        uint256 finalitySeconds
    ) external onlyAdmin whenActive {
        if (chainId == 0) revert InvalidChainId();
        if (registered[chainId]) revert AlreadyRegistered();
        if (governance == address(0)) revert ZeroAddress();
        if (!_validKind(kind)) revert InvalidKind();
        if (finalitySeconds == 0 || finalitySeconds > 1 hours) revert InvalidKind();

        _networks[chainId] = Network({
            name: name,
            chainId: chainId,
            kind: kind,
            rpcUrl: rpcUrl,
            explorerUrl: explorerUrl,
            bridgeContract: bridgeContract,
            tokenContract: tokenContract,
            dvpContract: dvpContract,
            paymasterContract: paymasterContract,
            governance: governance,
            finalitySeconds: finalitySeconds,
            active: true
        });
        registered[chainId] = true;
        networkCount += 1;

        emit NetworkRegistered(chainId, name, kind, governance);
    }

    function setActive(uint256 chainId, bool active) external onlyAdmin {
        if (!registered[chainId]) revert UnknownNetwork();
        _networks[chainId].active = active;
        emit NetworkUpdated(chainId, active, _networks[chainId].finalitySeconds);
    }

    function setFinality(uint256 chainId, uint256 finalitySeconds) external onlyAdmin {
        if (!registered[chainId]) revert UnknownNetwork();
        if (finalitySeconds == 0 || finalitySeconds > 1 hours) revert InvalidKind();
        _networks[chainId].finalitySeconds = finalitySeconds;
        emit NetworkUpdated(chainId, _networks[chainId].active, finalitySeconds);
    }

    function network(uint256 chainId) external view returns (Network memory) {
        if (!registered[chainId]) revert UnknownNetwork();
        return _networks[chainId];
    }

    function isActive(uint256 chainId) external view returns (bool) {
        return registered[chainId] && _networks[chainId].active;
    }

    function _validKind(bytes32 kind) internal pure returns (bool) {
        return kind == keccak256("APPCHAIN") || kind == keccak256("SUBNET") || kind == keccak256("L2")
            || kind == keccak256("L1");
    }
}
