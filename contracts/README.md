# Contratos de referência · xPartner

Contratos Solidity `^0.8.24` que espelham as regras já executadas no core TypeScript. Eles existem para demonstrar a camada on-chain sem mentir sobre o estado da entrega:

- **Não estão implantados** em mainnet, testnet ou rede permissionada.
- **Não foram compilados nem auditados** neste repositório (não há toolchain Solidity nas dependências). Trate como especificação executável, não como produto.
- O caminho de produção exige auditoria independente, timelock, multisig, testes de invariantes (Foundry) e revisão jurídica por jurisdição.

| Contrato | Espelha no core | Regras principais |
|---|---|---|
| `ADLAToken.sol` | ativo `ADLA` (`token_assets` + `token_holdings`) | ERC-20 mínimo, teto imutável, pausa administrativa, sem promessa de renda |
| `BioRoyaltyVault.sol` | `bio_assets` + `bio_royalties` | consentimento e dataset como hash imutável, admissão só pela DAO, royalty ≤ 30%, revogação imediata, pull payments |
| `DePINRegistry.sol` | `depin_devices` + `depin_rewards` | prova de trabalho físico com hash inédito, capacidade declarada, recompensa de 2 centavos/unidade liquidada off-chain |
| `XPartnerGovernor.sol` | `dao_proposals` + `dao_votes` | proposta com saldo mínimo, voto único ponderado por ADLA, quórum e fechamento permissionless |
| `MerkleAnchor.sol` | `anchor_chain` + `src/domain/zk.ts` | cadeia append-only com a mesma canonicalização SHA-256 do core e verificação de inclusão Merkle |

## Paridade de canonicalização

`MerkleAnchor.submitAnchor` reproduz exatamente `appendAnchor`:

```
anchorHash = sha256("{prevHash}|{payloadHash}|{height}|{createdAt}")
```

Hashes hexadecimais são strings ASCII minúsculas sem `0x`; `createdAt` é o ISO-8601 do core. A verificação Merkle segue `commitClaim` (`xpartner:commit:v1:{salt}:{subject}:{claim}:{value}`), `hashLeaf = sha256("00" + leafHex)` e `hashPair = sha256("01" + min + max)`.

## Limites explícitos

- Nenhum contrato lê ou grava dado biológico, genoma, íris ou identificador civil. Só compromissos.
- Não há mecanismo de staking de DNA, renda garantida por "vida" ou liquidação de biometria.
- Agentes autônomos sem guardrails não existem no core nem aqui: a decisão é registrada e limitada por política, nunca executa DeFi sozinha.
- A ponte PIX/Lightning/Drex/TCA do core é cotação e liquidação interna simulada; estes contratos não movem fundos reais.
