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
| `AladdinRiskEngine.sol` | `aladdin_risk_metrics` + `aladdin_loans` + `zk_snark_proofs` | atestação EIP-712 de risco assinada pelo agente (nonce/validade), score ≥ 7.000, VaR ≤ 25%, teto por faixa, uma operação ativa, cooldown, pool próprio e gate Groth16 de patrimônio |
| `IntentVault.sol` | `crosschain_intents` + `ccip_liquidity` | escrow do ativo de origem, liquidez de liquidação pré-financiada pelo solver, liquidação atômica via relayer/router, taxa ≤ 10% debitada dos proventos e anti-replay por `messageId` |
| `IntentReceiver.sol` | `ccip_messages` | perna de destino compatível com `Client.Any2EVMMessage`: somente router, lane allowlist por chain selector + sender, liquidez do solver liberada, replay por mensagem e por intent |

## Verificador Groth16 gerado

`generated/NetWorthVerifier.sol` é produzido por `snarkjs zkey export solidityverifier` a partir de `circuits/NetWorthProof.circom` (Poseidon + `GreaterEqThan(64)`). Ele verifica a prova de que o patrimônio comprometido é ≥ ao limiar declarado, com sinais públicos `[commitment, satisfied, thresholdCents]`.

- O verificador gerado é **GPL-3.0** (licença do template snarkjs), enquanto os contratos autorais deste diretório são MIT. Não misture os arquivos em um mesmo artefato distribuído sem revisar a licença.
- `AladdinRiskEngine` chama o verificador por interface (`IGroth16NetWorthVerifier`). Trocar o `.zkey` invalida provas e verificador; a cerimônia deste repositório é **de demonstração** (entropia única) e não substitui uma cerimônia multi-participante auditada.
- O circuito prova apenas o predicado de patrimônio sobre um compromisso Poseidon. Ele **não** vincula identidade, credencial ou scoring de IA; quem assina a atestação de risco é o oráculo EIP-712.

## Intents e CCIP

- O core simula a entrega cross-chain: o `messageId` é `sha256` e a mensagem nasce já liquidada no ledger interno. O `IntentVault` usa `keccak256` para o digest on-chain e exige um `messageId` único entregue pelo relayer; a estrutura é análoga, o algoritmo difere — integração real exige uma camada de tradução.
- `IntentReceiver` declara a struct mínima `Any2EVMMessage`; produção deve importar `@chainlink/contracts-ccip`, usar o router oficial por chain selector, configurar `extraArgs`/gas e tratar execução manual de mensagens falhas.
- Nenhum contrato fala com um router ou lane real neste repositório. Não há promessa de entrega entre chains fora do ledger interno.

## Paridade de canonicalização

`MerkleAnchor.submitAnchor` reproduz exatamente `appendAnchor`:

```
anchorHash = sha256("{prevHash}|{payloadHash}|{height}|{createdAt}")
```

Hashes hexadecimais são strings ASCII minúsculas sem `0x`; `createdAt` é o ISO-8601 do core. A verificação Merkle segue `commitClaim` (`xpartner:commit:v1:{salt}:{subject}:{claim}:{value}`), `hashLeaf = sha256("00" + leafHex)` e `hashPair = sha256("01" + min + max)`.

## Digest de oferta e de atestação

O core calcula o digest de oferta DVP e o hash de atestação com **SHA-256** (`src/domain/web3.ts`), enquanto `AtomicDVP` e `ZKComplianceVerifier` usam **EIP-712/keccak256** — a estrutura dos campos é a mesma, o algoritmo difere. Um preenchimento on-chain de oferta criada no core exigiria uma camada de tradução/assinatura própria; os contratos são referência de segurança, não um espelho byte a byte do digest.

## Garantias de segurança implementadas nos contratos

- **Reentrância**: `AtomicDVP`, `AgroCreditVault`, `AgentPolicyVault`, `AladdinRiskEngine`, `IntentVault` e `IntentReceiver` usam mutex explícito e ordem checks-effects-interactions.
- **Assinaturas**: recuperação ECDSA rejeita `s` de alta ordem (`> secp256k1n/2`) e `v` fora de 27/28, cobrindo malleability. `AladdinRiskEngine` usa EIP-712 com domínio por chain/contrato.
- **Replay**: nonces por maker no DVP, `userOpHash` consumido no paymaster, nullifier por compromisso/finalidade/época no verificador, nonce de risco + compromisso ZK únicos no Aladdin e `messageId`/intentId únicos em intents.
- **Oráculo**: `AgroCreditVault` exige resposta positiva, `answeredInRound ≥ roundId`, `updatedAt` dentro de `maxStaleness` e decimais ≤ 18.
- **Limites**: taxa DVP ≤ 10%, LTV de abertura ≤ 90%, limiar de liquidação ≥ LTV, teto por UserOp ≤ teto global, gasto de sessão ≤ teto, score Aladdin ≥ 7.000, VaR ≤ 25%, cooldown de 1 dia e taxa de intent ≤ 10%.
- **Transferências**: wrappers checam retorno booleano de ERC-20 não padronizados e revertem em falha.

## Limites explícitos

- Nenhum contrato lê ou grava dado biológico, genoma, íris ou identificador civil. Só compromissos.
- Não há mecanismo de staking de DNA, renda garantida por "vida" ou liquidação de biometria.
- Agentes autônomos sem guardrails não existem no core nem aqui: a decisão é registrada e limitada por política; `AgentPolicyVault` só executa alvos/seletores permitidos até um teto.
- `ZKComplianceVerifier` **não é zk-SNARK**: verifica atestação assinada por emissor autorizado com divulgação seletiva e nullifier. Privacidade criptográfica real exige um verificador de prova dedicado.
- `AladdinRiskEngine` é o único contrato deste diretório com zk-SNARK **real** (Groth16/BN254 via `NetWorthProof`). O core gera a prova no servidor para demonstração; produção deve provar no cliente (wasm) e manter o `.zkey`/wasm fora do servidor de verificação. A prova não substitui KYC nem prova identidade.
- `XPartnerPaymaster` usa uma struct local de UserOperation; produção deve importar a interface oficial do EntryPoint e acompanhar a versão vigente da especificação ERC-4337.
- A ponte PIX/Lightning/Drex/TCA do core é cotação e liquidação interna simulada; estes contratos não movem fundos reais.
