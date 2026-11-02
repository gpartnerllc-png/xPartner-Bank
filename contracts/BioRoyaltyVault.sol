// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BioRoyaltyVault — consentimento verificável e royalties de bioativos
/// @notice Espelha o fluxo de src/modules/tokenization.ts: o bioativo nasce PENDING com
///         hashes de consentimento e dataset; só a DAO (governor) o admite; cada licença
///         paga separa royalty ao titular do dado e margem à tesouraria.
/// @dev Não armazena dado biológico, identidade ou genoma — apenas compromissos SHA-256.
///      Royalty máximo de 30%, consentimento imutável após o registro e revogação imediata.
///      Pagamentos usam pull pattern para eliminar reentrância na distribuição.
contract BioRoyaltyVault {
    enum Status {
        NONE,
        PENDING,
        ADMITTED,
        REVOKED
    }

    struct Source {
        bytes32 consentHash;
        bytes32 datasetHash;
        address payable beneficiary;
        uint16 royaltyBps;
        Status status;
        uint64 registeredAt;
        uint64 admittedAt;
    }

    uint16 public constant MAX_ROYALTY_BPS = 3000;

    address public admin;
    address public governor;

    mapping(bytes32 => Source) public sources;
    mapping(address => uint256) public pendingRoyalties;
    uint256 public pendingTreasury;

    uint256 private _lock = 1;

    event SourceRegistered(
        bytes32 indexed bioId,
        address indexed beneficiary,
        bytes32 consentHash,
        bytes32 datasetHash,
        uint16 royaltyBps
    );
    event SourceAdmitted(bytes32 indexed bioId, uint256 indexed proposalId);
    event SourceRevoked(bytes32 indexed bioId, string reason);
    event LicensePaid(
        bytes32 indexed bioId,
        address indexed payer,
        uint256 gross,
        uint256 royalty,
        uint256 platformFee
    );
    event RoyaltyWithdrawn(address indexed beneficiary, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event GovernorChanged(address indexed governor);
    event AdminChanged(address indexed admin);

    error NotAdmin();
    error NotGovernor();
    error InvalidSource();
    error InvalidState();
    error InvalidRoyalty();
    error InvalidPayment();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address governor_) {
        admin = msg.sender;
        governor = governor_;
        emit AdminChanged(msg.sender);
        emit GovernorChanged(governor_);
    }

    function setGovernor(address next) external onlyAdmin {
        governor = next;
        emit GovernorChanged(next);
    }

    function transferAdmin(address next) external onlyAdmin {
        admin = next;
        emit AdminChanged(next);
    }

    /// @notice Registra a fonte com consentimento e dataset já reduzidos a hash.
    /// @dev O consentimento é imutável: corrigi-lo exige novo registro e nova admissão.
    function register(
        bytes32 bioId,
        bytes32 consentHash,
        bytes32 datasetHash,
        address payable beneficiary,
        uint16 royaltyBps
    ) external onlyAdmin {
        if (bioId == bytes32(0) || consentHash == bytes32(0) || datasetHash == bytes32(0)) {
            revert InvalidSource();
        }
        if (beneficiary == address(0)) revert InvalidSource();
        if (sources[bioId].status != Status.NONE) revert InvalidState();
        if (royaltyBps > MAX_ROYALTY_BPS) revert InvalidRoyalty();

        sources[bioId] = Source({
            consentHash: consentHash,
            datasetHash: datasetHash,
            beneficiary: beneficiary,
            royaltyBps: royaltyBps,
            status: Status.PENDING,
            registeredAt: uint64(block.timestamp),
            admittedAt: 0
        });
        emit SourceRegistered(bioId, beneficiary, consentHash, datasetHash, royaltyBps);
    }

    /// @notice Chamado apenas pelo governor após aprovação de proposta ADMIT_BIO_SOURCE.
    function admit(bytes32 bioId, uint256 proposalId) external onlyGovernor {
        Source storage source = sources[bioId];
        if (source.status != Status.PENDING) revert InvalidState();
        source.status = Status.ADMITTED;
        source.admittedAt = uint64(block.timestamp);
        emit SourceAdmitted(bioId, proposalId);
    }

    /// @notice Revogação imediata: bloqueia novas licenças e preserva o que já foi pago.
    function revoke(bytes32 bioId, string calldata reason) external onlyGovernor {
        Source storage source = sources[bioId];
        if (source.status != Status.ADMITTED) revert InvalidState();
        source.status = Status.REVOKED;
        emit SourceRevoked(bioId, reason);
    }

    /// @notice Licencia o dataset admitido e divide o valor entre royalty e tesouraria.
    function payLicense(bytes32 bioId, uint256 gross) external payable {
        Source storage source = sources[bioId];
        if (source.status != Status.ADMITTED) revert InvalidState();
        if (gross == 0 || msg.value != gross) revert InvalidPayment();

        uint256 royalty = (gross * source.royaltyBps) / 10_000;
        uint256 platformFee = gross - royalty;

        if (royalty > 0) pendingRoyalties[source.beneficiary] += royalty;
        if (platformFee > 0) pendingTreasury += platformFee;

        emit LicensePaid(bioId, msg.sender, gross, royalty, platformFee);
    }

    function withdrawRoyalty() external nonReentrant {
        uint256 amount = pendingRoyalties[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingRoyalties[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit RoyaltyWithdrawn(msg.sender, amount);
    }

    function withdrawTreasury(address payable to) external onlyAdmin nonReentrant {
        uint256 amount = pendingTreasury;
        if (amount == 0) revert NothingToWithdraw();
        if (to == address(0)) revert InvalidPayment();
        pendingTreasury = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit TreasuryWithdrawn(to, amount);
    }
}
