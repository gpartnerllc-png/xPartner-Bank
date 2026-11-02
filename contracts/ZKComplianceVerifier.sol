// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ZKComplianceVerifier — atestações de predicado com nullifier
/// @notice Verifica uma atestação assinada por emissor autorizado (EIP-712) e consome um
///         nullifier por compromisso + finalidade + época. O titular divulga apenas o predicado
///         (ex.: renda ≥ X), nunca o valor. Isto NÃO é uma prova zk-SNARK: é uma atestação
///         assinada off-chain com divulgação seletiva e anti-replay on-chain.
/// @dev Não compilado/auditado. Para privacidade real, substituir a assinatura do emissor por
///      um verificador de prova (Groth16/PLONK) e manter o nullifier como sinal público.
contract ZKComplianceVerifier {
    enum Predicate {
        GTE,
        LTE,
        EQ
    }

    struct Attestation {
        address issuer;
        bytes32 commitment;
        bytes32 claimType;
        Predicate predicate;
        uint256 threshold;
        uint256 validUntil;
        uint256 nonce;
    }

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address issuer,bytes32 commitment,bytes32 claimType,uint8 predicate,uint256 threshold,uint256 validUntil,uint256 nonce)"
    );
    bytes32 private constant NAME_HASH = keccak256("xPartner ZK Compliance");
    bytes32 private constant VERSION_HASH = keccak256("1");

    address public admin;
    bool public paused;
    mapping(address => bool) public issuers;
    mapping(bytes32 => bool) public revoked; // keccak256(issuer, nonce)
    mapping(bytes32 => bool) public nullifierUsed;

    event IssuerSet(address indexed issuer, bool allowed);
    event PredicateVerified(
        address indexed issuer,
        bytes32 indexed commitment,
        bytes32 claimType,
        Predicate predicate,
        uint256 threshold,
        bytes32 nullifier,
        bytes32 purpose
    );
    event AttestationRevoked(address indexed issuer, uint256 nonce);
    event PausedSet(bool value);

    error NotAdmin();
    error IsPaused();
    error ZeroAddress();
    error Expired();
    error Revoked();
    error InvalidSignature();
    error UnknownIssuer();
    error NullifierReused();
    error InvalidPredicate();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    function setIssuer(address issuer, bool allowed) external onlyAdmin {
        if (issuer == address(0)) revert ZeroAddress();
        issuers[issuer] = allowed;
        emit IssuerSet(issuer, allowed);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashAttestation(Attestation calldata attestation) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                attestation.issuer,
                attestation.commitment,
                attestation.claimType,
                attestation.predicate,
                attestation.threshold,
                attestation.validUntil,
                attestation.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function nullifierFor(bytes32 commitment, bytes32 purpose, uint256 epoch) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("xpartner:nullifier:v1:", commitment, purpose, epoch));
    }

    function revocationKey(address issuer, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(issuer, nonce));
    }

    /// @notice Verifica a atestação e consome o nullifier. Reverte em qualquer inconsistência.
    function verify(
        Attestation calldata attestation,
        bytes calldata signature,
        bytes32 purpose,
        uint256 epoch
    ) external returns (bytes32 nullifier) {
        if (paused) revert IsPaused();
        if (!issuers[attestation.issuer]) revert UnknownIssuer();
        if (attestation.issuer == address(0)) revert ZeroAddress();
        if (attestation.validUntil < block.timestamp) revert Expired();
        if (uint8(attestation.predicate) > uint8(Predicate.EQ)) revert InvalidPredicate();
        if (revoked[revocationKey(attestation.issuer, attestation.nonce)]) revert Revoked();
        if (_recover(hashAttestation(attestation), signature) != attestation.issuer) revert InvalidSignature();

        nullifier = nullifierFor(attestation.commitment, purpose, epoch);
        if (nullifierUsed[nullifier]) revert NullifierReused();
        nullifierUsed[nullifier] = true;

        emit PredicateVerified(
            attestation.issuer,
            attestation.commitment,
            attestation.claimType,
            attestation.predicate,
            attestation.threshold,
            nullifier,
            purpose
        );
    }

    function revoke(uint256 nonce) external {
        if (!issuers[msg.sender]) revert UnknownIssuer();
        revoked[revocationKey(msg.sender, nonce)] = true;
        emit AttestationRevoked(msg.sender, nonce);
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignature();
        }
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
