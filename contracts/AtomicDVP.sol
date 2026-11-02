// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Dvp {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title AtomicDVP — liquidação atômica entre dois ativos com assinatura EIP-712
/// @notice Referência endurecida do DVP do core: oferta assinada com nonce, validade,
///         taker opcional, taxa limitada, cancelamento on-chain e proteção contra reentrância
///         e malleability de assinatura. As duas pernas são ERC-20; a perna em BRL do core
///         usa o token de liquidação regulado (BRLT).
/// @dev Não compilado/auditado. Em produção exige auditoria, testes Foundry e limites por ativo.
contract AtomicDVP {
    struct Offer {
        address maker;
        address taker;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 buyAmount;
        uint256 feeBps;
        uint256 nonce;
        uint256 expiry;
    }

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant OFFER_TYPEHASH = keccak256(
        "Offer(address maker,address taker,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeBps,uint256 nonce,uint256 expiry)"
    );
    bytes32 private constant NAME_HASH = keccak256("xPartner Atomic DVP");
    bytes32 private constant VERSION_HASH = keccak256("1");

    uint256 public constant MAX_FEE_BPS = 1_000;

    address public admin;
    address public feeRecipient;
    bool public paused;
    uint256 private _lock = 1;

    /// @dev nonce consumido por maker (preenchido ou cancelado) — impede replay.
    mapping(address => mapping(uint256 => bool)) public usedNonce;

    event OfferFilled(
        bytes32 indexed offerHash,
        address indexed maker,
        address indexed taker,
        uint256 sellAmount,
        uint256 buyAmount,
        uint256 feeAmount
    );
    event OfferCancelled(address indexed maker, uint256 nonce);
    event FeeRecipientChanged(address indexed recipient);
    event PausedSet(bool value);
    event AdminChanged(address indexed admin);

    error NotAdmin();
    error IsPaused();
    error Reentrancy();
    error ExpiredOffer();
    error NonceUsed();
    error InvalidTaker();
    error SameMaker();
    error InvalidFee();
    error InvalidSignature();
    error ZeroAmount();
    error ZeroAddress();
    error TransferFailed();

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

    constructor(address admin_, address feeRecipient_) {
        if (admin_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        admin = admin_;
        feeRecipient = feeRecipient_;
        emit AdminChanged(admin_);
        emit FeeRecipientChanged(feeRecipient_);
    }

    function setFeeRecipient(address recipient) external onlyAdmin {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientChanged(recipient);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
        emit AdminChanged(next);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashOffer(Offer calldata offer) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                OFFER_TYPEHASH,
                offer.maker,
                offer.taker,
                offer.sellToken,
                offer.buyToken,
                offer.sellAmount,
                offer.buyAmount,
                offer.feeBps,
                offer.nonce,
                offer.expiry
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function cancel(uint256 nonce) external whenActive {
        if (usedNonce[msg.sender][nonce]) revert NonceUsed();
        usedNonce[msg.sender][nonce] = true;
        emit OfferCancelled(msg.sender, nonce);
    }

    /// @notice Preenche a oferta assinada pelo maker. Ambas as pernas ocorrem ou revertem juntas.
    function fill(Offer calldata offer, bytes calldata signature) external nonReentrant whenActive {
        if (offer.maker == address(0) || offer.sellToken == address(0) || offer.buyToken == address(0)) {
            revert ZeroAddress();
        }
        if (offer.sellAmount == 0 || offer.buyAmount == 0) revert ZeroAmount();
        if (offer.sellToken == offer.buyToken) revert ZeroAmount();
        if (offer.expiry < block.timestamp) revert ExpiredOffer();
        if (offer.feeBps > MAX_FEE_BPS) revert InvalidFee();
        if (offer.taker != address(0) && offer.taker != msg.sender) revert InvalidTaker();
        if (offer.maker == msg.sender) revert SameMaker();
        if (usedNonce[offer.maker][offer.nonce]) revert NonceUsed();

        bytes32 digest = hashOffer(offer);
        if (_recover(digest, signature) != offer.maker) revert InvalidSignature();

        usedNonce[offer.maker][offer.nonce] = true;

        uint256 feeAmount = (offer.buyAmount * offer.feeBps) / 10_000;
        uint256 netAmount = offer.buyAmount - feeAmount;

        _safeTransferFrom(offer.sellToken, offer.maker, msg.sender, offer.sellAmount);
        _safeTransferFrom(offer.buyToken, msg.sender, offer.maker, netAmount);
        if (feeAmount > 0) {
            _safeTransferFrom(offer.buyToken, msg.sender, feeRecipient, feeAmount);
        }

        emit OfferFilled(digest, offer.maker, msg.sender, offer.sellAmount, offer.buyAmount, feeAmount);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Dvp.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /// @dev ECDSA com rejeição de s de alta ordem e v inválido (EIP-2 / malleability).
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
