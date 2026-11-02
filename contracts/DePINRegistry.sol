// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DePINRegistry — Proof of Physical Work
/// @notice Registro on-chain de dispositivos físicos e das provas de trabalho que geram
///         recompensa no ledger interno (2 centavos por unidade, como no core).
/// @dev O contrato é atestação, não custódia: não recebe nem paga ETH. A liquidação ocorre
///      no xPartner Bank via DEPIN_REWARD_EXPENSE -> MERCHANT_AVAILABLE. Em produção, o
///      proofHash deve vir de assinatura de hardware/TEE ou atestação do fabricante.
contract DePINRegistry {
    enum Status {
        NONE,
        ACTIVE,
        SLASHED,
        RETIRED
    }

    struct Device {
        address owner;
        bytes32 modelHash;
        uint32 capacityUnits;
        uint256 provenUnits;
        bytes32 lastProofHash;
        Status status;
        uint64 registeredAt;
        uint64 lastProofAt;
    }

    uint256 public constant REWARD_CENTS_PER_UNIT = 2;

    address public admin;
    address public governor;

    mapping(bytes32 => Device) public devices;

    event DeviceRegistered(
        bytes32 indexed deviceId,
        address indexed owner,
        bytes32 modelHash,
        uint32 capacityUnits,
        bytes32 proofHash
    );
    event WorkProven(
        bytes32 indexed deviceId,
        address indexed owner,
        uint32 units,
        uint256 rewardCents,
        bytes32 proofHash
    );
    event DeviceSlashed(bytes32 indexed deviceId, string reason);
    event DeviceRetired(bytes32 indexed deviceId);
    event AdminChanged(address indexed admin);
    event GovernorChanged(address indexed governor);

    error NotAdmin();
    error NotGovernor();
    error NotOwner();
    error InvalidDevice();
    error InvalidState();
    error InvalidProof();
    error CapacityExceeded();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
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

    function registerDevice(
        bytes32 deviceId,
        bytes32 modelHash,
        uint32 capacityUnits,
        bytes32 proofHash
    ) external {
        if (deviceId == bytes32(0) || modelHash == bytes32(0) || proofHash == bytes32(0)) {
            revert InvalidDevice();
        }
        if (devices[deviceId].status != Status.NONE) revert InvalidState();
        if (capacityUnits == 0) revert CapacityExceeded();

        devices[deviceId] = Device({
            owner: msg.sender,
            modelHash: modelHash,
            capacityUnits: capacityUnits,
            provenUnits: 0,
            lastProofHash: proofHash,
            status: Status.ACTIVE,
            registeredAt: uint64(block.timestamp),
            lastProofAt: 0
        });
        emit DeviceRegistered(deviceId, msg.sender, modelHash, capacityUnits, proofHash);
    }

    /// @notice Prova de trabalho físico: unidade dentro da capacidade, prova inédita.
    function submitProof(bytes32 deviceId, uint32 units, bytes32 proofHash) external {
        Device storage device = devices[deviceId];
        if (device.status != Status.ACTIVE) revert InvalidState();
        if (msg.sender != device.owner) revert NotOwner();
        if (units == 0 || proofHash == bytes32(0) || proofHash == device.lastProofHash) {
            revert InvalidProof();
        }
        if (units > device.capacityUnits) revert CapacityExceeded();

        device.provenUnits += units;
        device.lastProofHash = proofHash;
        device.lastProofAt = uint64(block.timestamp);

        emit WorkProven(deviceId, msg.sender, units, uint256(units) * REWARD_CENTS_PER_UNIT, proofHash);
    }

    function slash(bytes32 deviceId, string calldata reason) external onlyGovernor {
        Device storage device = devices[deviceId];
        if (device.status != Status.ACTIVE) revert InvalidState();
        device.status = Status.SLASHED;
        emit DeviceSlashed(deviceId, reason);
    }

    function retire(bytes32 deviceId) external {
        Device storage device = devices[deviceId];
        if (msg.sender != device.owner && msg.sender != admin) revert NotOwner();
        if (device.status != Status.ACTIVE) revert InvalidState();
        device.status = Status.RETIRED;
        emit DeviceRetired(deviceId);
    }
}
