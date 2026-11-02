# Contratos de referência · xPartner

Contratos Solidity `^0.8.24` que espelham as regras já executadas no core TypeScript. Eles existem para demonstrar a camada on-chain sem mentir sobre o estado da entrega:

- **Não estão implantados** em mainnet, testnet ou rede permissionada.
- **Não foram compilados nem auditados** neste repositório (não há toolchain Solidity nas dependências). Trate como especificação executável, não como produto.
- O caminho de produção exige auditoria independente, timelock, multisig, testes de invariantes (Foundry), análise econômica e revisão jurídica por jurisdição.

| Contrato | Espelha no core | Regras principais |
|---|---|---|
| `ADLAToken.sol` | ativo `ADLA` (`token_assets` + `token_holdings`) | ERC-20 mínimo, teto imutável, pausa administrativa, sem promessa de renda |
| `BioRoyaltyVault.sol` | `bio_assets` + `bio_royalties` | consentimento e dataset como hash imutável, admissão só pela DAO, royalty ≤ 30%, revogação imediata, pull payments |
| `DePINRegistry.sol` | `depin_devices` + `depin_rewards` | prova de trabalho físico com hash inédito, capacidade declarada, recompensa de 2 centavos/unidade liquidada off-chain |
| `XPartnerGovernor.sol` | `dao_proposals` + `dao_votes` | proposta com saldo mínimo, voto único ponderado por ADLA, quórum e fechamento permissionless |
| `MerkleAnchor.sol` | `anchor_chain` + `src/domain/zk.ts` | cadeia append-only com a mesma canonicalização SHA-256 do core e verificação de inclusão Merkle |
| `RegulatedToken.sol` | token institucional / `web3_dvp_offers` | ERC-20 com KYC, blacklist, congelamento, pausa e papéis admin/operador separados |
| `AtomicDVP.sol` | `web3_dvp_offers` + `web3_dvp_trades` | oferta EIP-712 com nonce, validade, taker opcional, taxa ≤ 10%, cancelamento on-chain, ECDSA low-s e reentrância bloqueada |
| `AgroCreditVault.sol` | `web3_agro_contracts` + `web3_oracle_prices` | colateral em escrow, LTV na abertura, juros fixos, quitação com liberação e liquidação permissionless; oráculo com staleness |
| `XPartnerPaymaster.sol` | `web3_paymaster_budgets` + `web3_paymaster_ops` | patrocínio ERC-4337 com teto por UserOp, teto global, allowlist de sender e replay por `userOpHash` |
| `ZKComplianceVerifier.sol` | `web3_zk_attestations` + `web3_zk_nullifiers` | atestação assinada de predicado com emissor autorizado, expiração, revogação e nullifier por finalidade/época |
| `AppChainRegistry.sol` | `web3_networks` | catálogo de appchains/subnets/L2 com `chainId` único, contratos de interoperabilidade, governança e finalidade |
| `AgentPolicyVault.sol` | `web3_agent_sessions` + `agent_policies` | session key com alvo/seletor permitidos, teto de gasto, expiração, revogação e execução não reentrante |

## Paridade de canonicalização

`MerkleAnchor.submitAnchor` reproduz exatamente `appendAnchor`:

```
anchorHash = sha256("{prevHash}|{payloadHash}|{height}|{createdAt}")
```

Hashes hexadecimais são strings ASCII minúsculas sem `0x`; `createdAt` é o ISO-8601 do core. A verificação Merkle segue `commitClaim` (`xpartner:commit:v1:{salt}:{subject}:{claim}:{value}`), `hashLeaf = sha256("00" + leafHex)` e `hashPair = sha256("01" + min + max)`.

## Digest de oferta e de atestação

O core calcula o digest de oferta DVP e o hash de atestação com **SHA-256** (`src/domain/web3.ts`), enquanto `AtomicDVP` e `ZKComplianceVerifier` usam **EIP-712/keccak256** — a estrutura dos campos é a mesma, o algoritmo difere. Um preenchimento on-chain de oferta criada no core exigiria uma camada de tradução/assinatura própria; os contratos são referência de segurança, não um espelho byte a byte do digest.

## Garantias de segurança implementadas nos contratos

- **Reentrância**: `AtomicDVP`, `AgroCreditVault`, `AgentPolicyVault` usam mutex explícito e ordem checks-effects-interactions.
- **Assinaturas**: recuperação ECDSA rejeita `s` de alta ordem (`> secp256k1n/2`) e `v` fora de 27/28, cobrindo malleability.
- **Replay**: nonces por maker no DVP, `userOpHash` consumido no paymaster e nullifier por compromisso/finalidade/época no verificador.
- **Oráculo**: `AgroCreditVault` exige resposta positiva, `answeredInRound ≥ roundId`, `updatedAt` dentro de `maxStaleness` e decimais ≤ 18.
- **Limites**: taxa DVP ≤ 10%, LTV de abertura ≤ 90%, limiar de liquidação ≥ LTV, teto por UserOp ≤ teto global, gasto de sessão ≤ teto.
- **Transferências**: wrappers checam retorno booleano de ERC-20 não padronizados e revertem em falha.

## Limites explícitos

- Nenhum contrato lê ou grava dado biológico, genoma, íris ou identificador civil. Só compromissos.
- Não há mecanismo de staking de DNA, renda garantida por "vida" ou liquidação de biometria.
- Agentes autônomos sem guardrails não existem no core nem aqui: a decisão é registrada e limitada por política; `AgentPolicyVault` só executa alvos/seletores permitidos até um teto.
- `ZKComplianceVerifier` **não é zk-SNARK**: verifica atestação assinada por emissor autorizado com divulgação seletiva e nullifier. Privacidade criptográfica real exige um verificador de prova dedicado.
- `XPartnerPaymaster` usa uma struct local de UserOperation; produção deve importar a interface oficial do EntryPoint e acompanhar a versão vigente da especificação ERC-4337.
- A ponte PIX/Lightning/Drex/TCA do core é cotação e liquidação interna simulada; estes contratos não movem fundos reais.
