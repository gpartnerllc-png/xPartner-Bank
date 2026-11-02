// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ADLA — token de governança do consórcio xPartner
/// @notice Referência ERC-20 mínima para o ativo ADLA do core. Teto de emissão imutável,
///         pausa administrativa e nenhuma promessa de renda, dividendo ou valor de revenda.
/// @dev O peso de voto no XPartnerGovernor usa o saldo no momento do voto. Em produção,
///      substituir por ERC20Votes com checkpoints para evitar manipulação intra-bloco.
contract ADLAToken {
    string public constant name = "ADLA Governance";
    string public constant symbol = "ADLA";
    uint8 public constant decimals = 18;

    uint256 public immutable cap;
    uint256 public totalSupply;
    address public admin;
    bool public paused;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AdminChanged(address indexed admin);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error NotAdmin();
    error IsPaused();
    error CapExceeded();
    error InsufficientBalance();
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenActive() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(uint256 cap_) {
        if (cap_ == 0) revert ZeroAddress();
        cap = cap_;
        admin = msg.sender;
        emit AdminChanged(msg.sender);
    }

    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
        emit AdminChanged(next);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        if (value) emit Paused(msg.sender);
        else emit Unpaused(msg.sender);
    }

    function mint(address to, uint256 amount) external onlyAdmin whenActive {
        if (to == address(0)) revert ZeroAddress();
        if (totalSupply + amount > cap) revert CapExceeded();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(uint256 amount) external whenActive {
        uint256 balance = balanceOf[msg.sender];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[msg.sender] = balance - amount;
            totalSupply -= amount;
        }
        emit Transfer(msg.sender, address(0), amount);
    }

    function transfer(address to, uint256 amount) external whenActive returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external whenActive returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientBalance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
