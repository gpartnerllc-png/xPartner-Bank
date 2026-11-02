// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MerkleAnchor — cadeia de âncoras append-only e provas de inclusão
/// @notice Reproduz exatamente a canonicalização de src/kernel/anchor.ts e src/domain/zk.ts:
///         anchorHash = sha256("{prevHash}|{payloadHash}|{height}|{createdAt}")
///         leaf       = sha256(ascii("00") + commitmentHex)
///         node       = sha256(ascii("01") + minHex + maxHex)
///         Todos os hashes são strings ASCII minúsculas de 64 caracteres, sem "0x".
/// @dev Prova de inclusão Merkle é divulgação seletiva honesta, não zk-SNARK: o verificador
///      aprende a raiz e o caminho, mas não os demais membros. A âncora periódica do
///      latestHash em rede pública (Ethereum/L2) é o próximo passo de soberania.
contract MerkleAnchor {
    bytes16 private constant HEX = 0x30313233343536373839616263646566;

    address public admin;
    address public relayer;

    uint256 public height;
    bytes32 public latestHash;

    mapping(uint256 => bytes32) public payloadHashAt;
    mapping(uint256 => bytes32) public anchorHashAt;
    mapping(uint256 => string) public createdAtAt;

    event AnchorSubmitted(
        uint256 indexed height,
        bytes32 payloadHash,
        bytes32 anchorHash,
        string createdAt
    );
    event RelayerChanged(address indexed relayer);
    event AdminChanged(address indexed admin);

    error NotAdmin();
    error NotRelayer();
    error EmptyPayload();
    error InvalidHex();
    error LengthMismatch();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    constructor(address relayer_) {
        admin = msg.sender;
        relayer = relayer_;
        emit AdminChanged(msg.sender);
        emit RelayerChanged(relayer_);
    }

    function setRelayer(address next) external onlyAdmin {
        relayer = next;
        emit RelayerChanged(next);
    }

    function transferAdmin(address next) external onlyAdmin {
        admin = next;
        emit AdminChanged(next);
    }

    /// @notice Anexa um novo bloco à cadeia. createdAtIso é o ISO-8601 gerado pelo core.
    function submitAnchor(
        bytes32 payloadHash,
        string calldata createdAtIso
    ) external onlyRelayer returns (uint256 newHeight, bytes32 anchorHash) {
        if (payloadHash == bytes32(0)) revert EmptyPayload();

        newHeight = height + 1;
        bytes32 prevHash = height == 0 ? bytes32(0) : latestHash;
        anchorHash = sha256(
            bytes(
                string.concat(
                    _toHex(prevHash),
                    "|",
                    _toHex(payloadHash),
                    "|",
                    _toString(newHeight),
                    "|",
                    createdAtIso
                )
            )
        );

        height = newHeight;
        latestHash = anchorHash;
        payloadHashAt[newHeight] = payloadHash;
        anchorHashAt[newHeight] = anchorHash;
        createdAtAt[newHeight] = createdAtIso;

        emit AnchorSubmitted(newHeight, payloadHash, anchorHash, createdAtIso);
    }

    /// @notice Verifica um caminho Merkle ordenado por par, idêntico ao verificador TypeScript.
    function verifyMerkleProof(
        string calldata leafHex,
        string calldata rootHex,
        string[] calldata pathHashes,
        bool[] calldata siblingOnLeft
    ) external pure returns (bool) {
        if (pathHashes.length != siblingOnLeft.length) revert LengthMismatch();

        string memory current = _sha256Hex(string.concat("00", _lowerHex(leafHex)));
        for (uint256 i = 0; i < pathHashes.length; i++) {
            string memory sibling = _lowerHex(pathHashes[i]);
            current = siblingOnLeft[i] ? _hashPair(sibling, current) : _hashPair(current, sibling);
        }
        return keccak256(bytes(current)) == keccak256(bytes(_lowerHex(rootHex)));
    }

    /// @notice Compromisso de credencial: sha256("xpartner:commit:v1:{salt}:{subject}:{claim}:{value}").
    function computeCommitment(
        string calldata salt,
        string calldata subjectId,
        string calldata claimType,
        string calldata value
    ) external pure returns (bytes32) {
        return sha256(
            bytes(string.concat("xpartner:commit:v1:", salt, ":", subjectId, ":", claimType, ":", value))
        );
    }

    function _hashPair(string memory a, string memory b) internal pure returns (string memory) {
        string memory lo;
        string memory hi;
        if (_lessOrEqual(a, b)) {
            lo = a;
            hi = b;
        } else {
            lo = b;
            hi = a;
        }
        return _sha256Hex(string.concat("01", lo, hi));
    }

    function _sha256Hex(string memory input) internal pure returns (string memory) {
        return _toHex(sha256(bytes(input)));
    }

    function _lessOrEqual(string memory a, string memory b) internal pure returns (bool) {
        bytes memory left = bytes(a);
        bytes memory right = bytes(b);
        for (uint256 i = 0; i < left.length; i++) {
            if (left[i] < right[i]) return true;
            if (left[i] > right[i]) return false;
        }
        return true;
    }

    function _lowerHex(string memory value) internal pure returns (string memory) {
        bytes memory raw = bytes(value);
        if (raw.length != 64) revert InvalidHex();
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            uint8 c = uint8(raw[i]);
            if (c >= 0x30 && c <= 0x39) out[i] = bytes1(c);
            else if (c >= 0x61 && c <= 0x66) out[i] = bytes1(c);
            else if (c >= 0x41 && c <= 0x46) out[i] = bytes1(c + 32);
            else revert InvalidHex();
        }
        return string(out);
    }

    function _toHex(bytes32 value) internal pure returns (string memory) {
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(value[i]);
            out[i * 2] = HEX[b >> 4];
            out[i * 2 + 1] = HEX[b & 0x0f];
        }
        return string(out);
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
