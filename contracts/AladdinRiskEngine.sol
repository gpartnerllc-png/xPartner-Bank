// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Aladdin {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Verificador gerado por `snarkjs zkey export solidityverifier` para o circuito NetWorthProof.
///      Sinais públicos: [commitment, satisfied, thresholdCents].
interface IGroth16NetWorthVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata publicSignals
    ) external view returns (bool);
}

/// @title AladdinRiskEngine — crédito algorítmico com atestação de risco assinada e prova zk-SNARK
/// @notice Espelha o motor Aladdin do core: score mínimo, teto por faixa de score, VaR máximo,
///         uma operação ativa por tomador, cooldown após quitação, liquidez própria do pool e
///         gate criptográfico por prova Groth16/BN254 (patrimônio ≥ limiar) sem revelar patrimônio.
/// @dev NÃO compilado nem auditado neste repositório; ver `contracts/README.md`. Em produção:
///      HSM/KMS para a chave do oráculo de risco, cerimônia multi-participante para o zkey,
///      timelock + multisig para parâmetros e auditoria independente. O agente de IA assina a
///      atestação de risco; o contrato não confia em texto livre vindo de fora do EIP-712.
contract AladdinRiskEngine {
    struct RiskAttestation {
        address borrower;
        uint16 varBps;
        uint16 creditScore;
        uint64 nonce;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    struct Loan {
        address borrower;
        uint256 principal;
        uint256 outstanding;
        uint256 dueAt;
        uint256 score;
        uint256 proofCommitment;
        bool active;
    }

    uint256 public constant MIN_SCORE = 7_000;
    uint256 public constant MAX_VAR_BPS = 2_500;
    uint256 public constant MAX_INTEREST_BPS = 20_000;
    uint256 public constant MIN_TERM = 30 days;
    uint256 public constant MAX_TERM = 360 days;
    uint256 public constant MAX_ISSUED_AT_SKEW = 5 minutes;
    uint256 private constant _SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RISK_TYPEHASH = keccak256(
        "RiskAttestation(address borrower,uint16 varBps,uint16 creditScore,uint64 nonce,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("xPartner Aladdin Risk");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    address public admin;
    address public stableToken;
    address public treasury;
    address public riskSigner;
    address public verifier;
    uint256 public limitLow;
    uint256 public limitMid;
    uint256 public limitHigh;
    uint256 public minNetWorth;
    uint256 public cooldownSeconds = 1 days;
    bool public paused;
    uint256 private _lock = 1;

    uint256 public totalOutstanding;
    uint256 public nextLoanId = 1;
    mapping(uint256 => Loan) public loans;
    mapping(address => uint256) public activeLoanOf;
    mapping(address => uint256) public lastClosedAt;
    mapping(address => mapping(uint64 => bool)) public usedRiskNonces;
    mapping(uint256 => bool) public usedCommitments;

    event LoanOpened(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint256 outstanding,
        uint256 score,
        uint256 varBps,
        uint256 proofCommitment
    );
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 amount, uint256 remaining);
    event LiquidityDeposited(address indexed from, uint256 amount);
    event LiquidityWithdrawn(address indexed to, uint256 amount);
    event RiskSignerChanged(address indexed signer);
    event VerifierChanged(address indexed verifier);
    event LimitsChanged(uint256 low, uint256 mid, uint256 high);
    event MinNetWorthChanged(uint256 amount);
    event CooldownChanged(uint256 seconds_);
    event PausedSet(bool value);

    error NotAdmin();
    error NotBorrower();
    error IsPaused();
    error Reentrancy();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidParameters();
    error LoanActive();
    error LoanNotActive();
    error CooldownActive();
    error AttestationExpired();
    error AttestationNotYetValid();
    error AttestationReplayed();
    error InvalidSignature();
    error ScoreTooLow();
    error VarTooHigh();
    error LimitExceeded();
    error InsufficientLiquidity();
    error ProofRejected();
    error ProofReplayed();
    error ProofThresholdLow();
    error ProofUnsatisfied();
    error ZeroCommitment();
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

    constructor(
        address admin_,
        address stableToken_,
        address treasury_,
        address riskSigner_,
        address verifier_,
        uint256 limitLow_,
        uint256 limitMid_,
        uint256 limitHigh_,
        uint256 minNetWorth_
    ) {
        if (
            admin_ == address(0) ||
            stableToken_ == address(0) ||
            treasury_ == address(0) ||
            riskSigner_ == address(0) ||
            verifier_ == address(0)
        ) revert ZeroAddress();
        if (limitLow_ == 0 || limitLow_ > limitMid_ || limitMid_ > limitHigh_) revert InvalidParameters();
        if (minNetWorth_ == 0) revert ZeroAmount();
        admin = admin_;
        stableToken = stableToken_;
        treasury = treasury_;
        riskSigner = riskSigner_;
        verifier = verifier_;
        limitLow = limitLow_;
        limitMid = limitMid_;
        limitHigh = limitHigh_;
        minNetWorth = minNetWorth_;
        emit LimitsChanged(limitLow_, limitMid_, limitHigh_);
        emit MinNetWorthChanged(minNetWorth_);
    }

    // ── Administração ────────────────────────────────────────────────────────

    function setRiskSigner(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        riskSigner = next;
        emit RiskSignerChanged(next);
    }

    function setVerifier(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        verifier = next;
        emit VerifierChanged(next);
    }

    function setLimits(uint256 low, uint256 mid, uint256 high) external onlyAdmin {
        if (low == 0 || low > mid || mid > high) revert InvalidParameters();
        limitLow = low;
        limitMid = mid;
        limitHigh = high;
        emit LimitsChanged(low, mid, high);
    }

    function setMinNetWorth(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ZeroAmount();
        minNetWorth = amount;
        emit MinNetWorthChanged(amount);
    }

    function setCooldown(uint256 seconds_) external onlyAdmin {
        if (seconds_ > 30 days) revert InvalidParameters();
        cooldownSeconds = seconds_;
        emit CooldownChanged(seconds_);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    // ── Liquidez ─────────────────────────────────────────────────────────────

    function depositLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _safeTransferFrom(stableToken, msg.sender, address(this), amount);
        emit LiquidityDeposited(msg.sender, amount);
    }

    function withdrawLiquidity(uint256 amount) external onlyAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (freeLiquidity() < amount) revert InsufficientLiquidity();
        _safeTransfer(stableToken, msg.sender, amount);
        emit LiquidityWithdrawn(msg.sender, amount);
    }

    function freeLiquidity() public view returns (uint256) {
        uint256 balance = IERC20Aladdin(stableToken).balanceOf(address(this));
        return balance > totalOutstanding ? balance - totalOutstanding : 0;
    }

    // ── Crédito ──────────────────────────────────────────────────────────────

    /// @notice Abre crédito contra atestação EIP-712 do agente quantitativo e prova Groth16.
    /// @dev O tomador é sempre `msg.sender`; a atestação não é transferível entre carteiras.
    function openLoan(
        uint256 principal,
        uint256 interestBps,
        uint256 durationSeconds,
        RiskAttestation calldata attestation,
        bytes calldata signature,
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        uint256[3] calldata publicSignals
    ) external nonReentrant whenActive returns (uint256 loanId) {
        if (principal == 0) revert ZeroAmount();
        if (interestBps > MAX_INTEREST_BPS) revert InvalidParameters();
        if (durationSeconds < MIN_TERM || durationSeconds > MAX_TERM) revert InvalidParameters();
        if (attestation.borrower != msg.sender) revert InvalidSignature();
        if (activeLoanOf[msg.sender] != 0) revert LoanActive();
        if (lastClosedAt[msg.sender] != 0 && block.timestamp < lastClosedAt[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }

        if (attestation.expiresAt <= block.timestamp) revert AttestationExpired();
        if (attestation.issuedAt > block.timestamp + MAX_ISSUED_AT_SKEW) revert AttestationNotYetValid();
        if (attestation.nonce == 0 || usedRiskNonces[msg.sender][attestation.nonce]) revert AttestationReplayed();
        if (attestation.creditScore < MIN_SCORE) revert ScoreTooLow();
        if (attestation.varBps > MAX_VAR_BPS) revert VarTooHigh();
        if (principal > maxPrincipalForScore(attestation.creditScore)) revert LimitExceeded();

        _verifyAttestation(attestation, signature);

        if (freeLiquidity() < principal) revert InsufficientLiquidity();
        _verifyNetWorthProof(proofA, proofB, proofC, publicSignals);

        uint256 commitment = publicSignals[0];
        if (usedCommitments[commitment]) revert ProofReplayed();

        uint256 outstanding = principal + (principal * interestBps) / 10_000;

        usedRiskNonces[msg.sender][attestation.nonce] = true;
        usedCommitments[commitment] = true;
        totalOutstanding += principal;

        loanId = nextLoanId++;
        loans[loanId] = Loan({
            borrower: msg.sender,
            principal: principal,
            outstanding: outstanding,
            dueAt: block.timestamp + durationSeconds,
            score: attestation.creditScore,
            proofCommitment: commitment,
            active: true
        });
        activeLoanOf[msg.sender] = loanId;

        _safeTransfer(stableToken, msg.sender, principal);

        emit LoanOpened(
            loanId,
            msg.sender,
            principal,
            outstanding,
            attestation.creditScore,
            attestation.varBps,
            commitment
        );
    }

    /// @notice Amortiza ou quita. Quitação libera a trava de crédito após o cooldown.
    /// @dev Repagamento continua permitido com o contrato pausado.
    function repay(uint256 loanId, uint256 amount) external nonReentrant {
        Loan storage loan = loans[loanId];
        if (!loan.active) revert LoanNotActive();
        if (loan.borrower != msg.sender) revert NotBorrower();
        if (amount == 0) revert ZeroAmount();
        if (amount > loan.outstanding) revert InvalidParameters();

        uint256 remaining = loan.outstanding - amount;
        loan.outstanding = remaining;
        uint256 principalPortion = amount > loan.principal ? loan.principal : amount;
        loan.principal -= principalPortion;
        totalOutstanding -= principalPortion;

        if (remaining == 0) {
            loan.active = false;
            activeLoanOf[msg.sender] = 0;
            lastClosedAt[msg.sender] = block.timestamp;
        }

        _safeTransferFrom(stableToken, msg.sender, address(this), amount);
        emit LoanRepaid(loanId, msg.sender, amount, remaining);
    }

    // ── Visões ───────────────────────────────────────────────────────────────

    function maxPrincipalForScore(uint256 score) public view returns (uint256) {
        if (score >= 9_000) return limitHigh;
        if (score >= 8_000) return limitMid;
        if (score >= MIN_SCORE) return limitLow;
        return 0;
    }

    function currentLtvLikeBps(uint256 loanId) external view returns (uint256) {
        Loan memory loan = loans[loanId];
        if (!loan.active || loan.principal == 0) return 0;
        return (loan.outstanding * 10_000) / loan.principal;
    }

    /// @notice Digest EIP-712 que o agente de IA assina (via HSM) para emitir a atestação.
    function riskDigest(RiskAttestation calldata attestation) external view returns (bytes32) {
        return _hashTypedData(
            keccak256(
                abi.encode(
                    RISK_TYPEHASH,
                    attestation.borrower,
                    attestation.varBps,
                    attestation.creditScore,
                    attestation.nonce,
                    attestation.issuedAt,
                    attestation.expiresAt
                )
            )
        );
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this))
        );
    }

    // ── Internos ─────────────────────────────────────────────────────────────

    function _verifyAttestation(RiskAttestation calldata attestation, bytes calldata signature) internal {
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
        if (uint256(s) > _SECP256K1_HALF_N) revert InvalidSignature();

        bytes32 digest = _hashTypedData(
            keccak256(
                abi.encode(
                    RISK_TYPEHASH,
                    attestation.borrower,
                    attestation.varBps,
                    attestation.creditScore,
                    attestation.nonce,
                    attestation.issuedAt,
                    attestation.expiresAt
                )
            )
        );
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != riskSigner) revert InvalidSignature();
    }

    function _verifyNetWorthProof(
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        uint256[3] calldata publicSignals
    ) internal {
        if (publicSignals[0] == 0) revert ZeroCommitment();
        if (publicSignals[1] != 1) revert ProofUnsatisfied();
        if (publicSignals[2] < minNetWorth) revert ProofThresholdLow();
        if (!IGroth16NetWorthVerifier(verifier).verifyProof(proofA, proofB, proofC, publicSignals)) {
            revert ProofRejected();
        }
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Aladdin.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Aladdin.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
