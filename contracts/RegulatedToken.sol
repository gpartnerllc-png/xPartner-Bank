// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RegulatedToken — token institucional com trilho de conformidade
/// @notice Referência on-chain do token regulado do xPartner: ERC-20 mínimo com KYC,
///         blacklist, congelamento individual, pausa e papéis separados de admin/operador.
/// @dev Não foi compilado nem auditado neste repositório. Em produção, use uma implementação
///      auditada (ERC-20 + ERC-3643 ou equivalente) e mantenha as listas fora do caminho crítico.
contract RegulatedToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    address public admin;
    bool public paused;
    bool public requireKyc = true;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    mapping(address => bool) public operators;
    mapping(address => bool) public kycApproved;
    mapping(address => bool) public blacklisted;
    mapping(address => bool) public frozen;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OperatorSet(address indexed account, bool allowed);
    event KycSet(address indexed account, bool approved);
    event BlacklistSet(address indexed account, bool blocked);
    event FrozenSet(address indexed account, bool value);
    event PausedSet(bool value);
    event AdminChanged(address indexed admin);

    error NotAdmin();
    error NotOperator();
    error IsPaused();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance();
    error InsufficientAllowance();
    error NotEligible(address account);
    error AccountBlacklisted(address account);
    error AccountFrozen(address account);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender] && msg.sender != admin) revert NotOperator();
        _;
    }

    modifier whenActive() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        admin = admin_;
        operators[admin_] = true;
        emit AdminChanged(admin_);
        emit OperatorSet(admin_, true);
    }

    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
        emit AdminChanged(next);
    }

    function setOperator(address account, bool allowed) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        operators[account] = allowed;
        emit OperatorSet(account, allowed);
    }

    function setKyc(address account, bool approved) external onlyOperator {
        if (account == address(0)) revert ZeroAddress();
        kycApproved[account] = approved;
        emit KycSet(account, approved);
    }

    function setBlacklist(address account, bool blocked) external onlyOperator {
        if (account == address(0)) revert ZeroAddress();
        blacklisted[account] = blocked;
        emit BlacklistSet(account, blocked);
    }

    function setFrozen(address account, bool value) external onlyOperator {
        if (account == address(0)) revert ZeroAddress();
        frozen[account] = value;
        emit FrozenSet(account, value);
    }

    function setRequireKyc(bool value) external onlyAdmin {
        requireKyc = value;
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    function eligible(address account) public view returns (bool) {
        if (blacklisted[account]) return false;
        if (requireKyc && !kycApproved[account]) return false;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external whenActive returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external whenActive returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
            emit Approval(from, msg.sender, allowed - amount);
        }
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external onlyOperator whenActive {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!eligible(to)) revert NotEligible(to);
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyOperator whenActive {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (frozen[from]) revert AccountFrozen(from);
        if (frozen[to]) revert AccountFrozen(to);
        if (blacklisted[from]) revert AccountBlacklisted(from);
        if (blacklisted[to]) revert AccountBlacklisted(to);
        if (!eligible(from)) revert NotEligible(from);
        if (!eligible(to)) revert NotEligible(to);

        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
