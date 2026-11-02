// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ADLAToken} from "./ADLAToken.sol";
import {BioRoyaltyVault} from "./BioRoyaltyVault.sol";

/// @title XPartnerGovernor — governança ponderada por ADLA
/// @notice Espelha a DAO do core: proposta só com saldo mínimo, voto único por titular
///         ponderado por unidades, quórum explícito e fechamento após a janela.
/// @dev A admissão de bioativo só acontece pelo fluxo ADMIT_BIO_SOURCE aprovado, o que
///      torna o contrato o gatekeeper do BioRoyaltyVault. Em produção, o fechamento deve
///      ser acionado por timelock e o peso de voto deve usar checkpoints (ERC20Votes),
///      não o saldo spot, para impedir voto emprestado dentro do bloco.
contract XPartnerGovernor {
    enum Kind {
        ADMIT_BIO_SOURCE,
        TREASURY_SPEND,
        PARAMETER_CHANGE
    }

    enum Status {
        NONE,
        OPEN,
        APPROVED,
        REJECTED
    }

    struct Proposal {
        address proposer;
        Kind kind;
        bytes32 subject;
        bytes32 metadataHash;
        uint256 quorumUnits;
        uint256 votesFor;
        uint256 votesAgainst;
        uint64 createdAt;
        uint64 closesAt;
        Status status;
    }

    ADLAToken public immutable token;
    BioRoyaltyVault public immutable bioVault;
    uint256 public immutable proposalThreshold;
    uint256 public immutable minQuorum;
    uint64 public immutable minDuration;
    uint64 public immutable maxDuration;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        Kind kind,
        bytes32 subject,
        uint256 quorumUnits,
        uint64 closesAt
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalClosed(uint256 indexed proposalId, Status status, uint256 votesFor, uint256 votesAgainst);

    error NotHolder();
    error InvalidProposal();
    error InvalidQuorum();
    error InvalidDuration();
    error NotOpen();
    error VotingClosed();
    error AlreadyVoted();
    error NoWeight();

    constructor(
        ADLAToken token_,
        BioRoyaltyVault bioVault_,
        uint256 proposalThreshold_,
        uint256 minQuorum_,
        uint64 minDuration_,
        uint64 maxDuration_
    ) {
        token = token_;
        bioVault = bioVault_;
        proposalThreshold = proposalThreshold_;
        minQuorum = minQuorum_;
        minDuration = minDuration_;
        maxDuration = maxDuration_;
    }

    function createProposal(
        Kind kind,
        bytes32 subject,
        bytes32 metadataHash,
        uint256 quorumUnits,
        uint64 duration
    ) external returns (uint256 proposalId) {
        if (token.balanceOf(msg.sender) < proposalThreshold) revert NotHolder();
        if (subject == bytes32(0) || metadataHash == bytes32(0)) revert InvalidProposal();
        if (quorumUnits < minQuorum) revert InvalidQuorum();
        if (duration < minDuration || duration > maxDuration) revert InvalidDuration();

        proposalId = ++proposalCount;
        proposals[proposalId] = Proposal({
            proposer: msg.sender,
            kind: kind,
            subject: subject,
            metadataHash: metadataHash,
            quorumUnits: quorumUnits,
            votesFor: 0,
            votesAgainst: 0,
            createdAt: uint64(block.timestamp),
            closesAt: uint64(block.timestamp) + duration,
            status: Status.OPEN
        });
        emit ProposalCreated(proposalId, msg.sender, kind, subject, quorumUnits, uint64(block.timestamp) + duration);
    }

    function vote(uint256 proposalId, bool support) external {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.status != Status.OPEN) revert NotOpen();
        if (block.timestamp >= proposal.closesAt) revert VotingClosed();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        uint256 weight = token.balanceOf(msg.sender);
        if (weight == 0) revert NoWeight();

        hasVoted[proposalId][msg.sender] = true;
        if (support) proposal.votesFor += weight;
        else proposal.votesAgainst += weight;

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /// @notice Fechamento permissionless após a janela; aprova com quórum e maioria simples.
    function close(uint256 proposalId) external {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.status != Status.OPEN) revert NotOpen();
        if (block.timestamp < proposal.closesAt) revert VotingClosed();

        bool approved = proposal.votesFor >= proposal.quorumUnits && proposal.votesFor > proposal.votesAgainst;
        Status outcome = approved ? Status.APPROVED : Status.REJECTED;
        proposal.status = outcome;

        if (approved && proposal.kind == Kind.ADMIT_BIO_SOURCE) {
            bioVault.admit(proposal.subject, proposalId);
        }

        emit ProposalClosed(proposalId, outcome, proposal.votesFor, proposal.votesAgainst);
    }
}
