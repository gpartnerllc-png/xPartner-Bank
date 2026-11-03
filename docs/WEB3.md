# Web3 institucional · xPartner

Esta camada estende o core do xPartner Bank com as tecnologias que bancos e consórcios usam para operar ativos digitais sem abrir mão de contabilidade, compliance e rastreabilidade. Tudo é **aditivo**: nenhuma tabela ou rota existente foi alterada, e o ledger de dupla entrada continua sendo a fonte da verdade financeira.

## O que está integrado

| Capacidade | Onde vive no core | O que faz de verdade |
|---|---|---|
| **DVP atômico** | `web3_dvp_offers`, `web3_dvp_trades`, `Web3Hub` | Oferta com digest tipado, nonce e validade; aceite liquida as duas pernas no mesmo `tx()`; perna em BRL gera partidas `MERCHANT_AVAILABLE` + `FEE_REVENUE`. |
| **Token regulado / RWA** | `token_assets` + `RegulatedToken.sol` | Emissão lastreada 1:1 já existente no core; o contrato de referência adiciona KYC, blacklist, congelamento e papéis separados. |
| **Crédito agro com oráculo** | `web3_agro_contracts`, `web3_oracle_*` | Colateral tokenizado em escrow (`xpartner:escrow:agro`), LTV na abertura, juros fixos, quitação com liberação e liquidação permissionless disparada por queda de preço. |
| **Oráculo com staleness** | `web3_oracle_feeds`, `web3_oracle_prices` | Rodadas numeradas, fonte declarada, decimais validados e leitura que recusa preço velho (`ORACLE_STALE`). |
| **ZKP / divulgação seletiva** | `web3_zk_attestations`, `web3_zk_nullifiers` | Atestação de predicado assinada por emissor + nullifier por compromisso/finalidade/dia. **Não é zk-SNARK**; é o mesmo modelo honesto do `zk.ts` existente. |
| **ERC-4337 / account abstraction** | `web3_agent_sessions`, `agent_policies` | Session key com hash armazenado (a chave aparece uma única vez), allowlist de seletores e símbolos, teto por sessão, política diária e aprovação humana acima do limite. |
| **Paymaster** | `web3_paymaster_budgets`, `web3_paymaster_ops` | Orçamento por lojista, teto por UserOp, teto global, allowlist e anti-replay por `userOpHash`. |
| **Subnets / appchains** | `web3_networks` | Registro de rede com `chainId` único, RPC, explorer, contratos de ponte/token/DVP/paymaster, finalidade e governança. |
| **Agentes autônomos Web3** | `agent_decisions` (reuso) | Toda ação do agente vira decisão auditada (`APPROVE`/`REVIEW`/`BLOCK`) ancorada na cadeia de hashes. |
| **Motor de risco Aladdin + IA** | `aladdin_risk_metrics`, `aladdin_loans`, `AladdinEngine`, `src/domain/aladdin.ts` | Monte Carlo determinístico (sha256 + mulberry32/Box-Muller) para VaR diário, score composto 0–10.000, staleness de métrica, teto por faixa de score e crédito com partidas dobradas. |
| **zk-SNARK real (Groth16/BN254)** | `zk_snark_proofs`, `circuits/NetWorthProof.circom`, `generated/NetWorthVerifier.sol` | Circuito Poseidon + `GreaterEqThan(64)` prova `patrimônio ≥ limiar` sem revelar o valor. Verificação real com snarkjs, anti-replay por hash e consumo único da prova no empréstimo. |
| **CCIP + intents + liquidez P2P com IA** | `ccip_lanes`, `ccip_liquidity`, `crosschain_intents`, `crosschain_quotes`, `ccip_messages`, `CrossChainHub` | Intents com escrow, cotações de solvers pontuadas por preço/taxa/latência/risco, seleção automática e mensagem CCIP com `messageId` único e anti-replay. |

## Superfície HTTP

Todas as rotas exigem Bearer com escopo `demo:read` (leitura) ou `demo:write` (escrita). O titular do token é sempre o maker/lojista/liquidante; o taker de uma oferta é o próprio titular.

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/v1/web3/overview` | KPIs consolidados de redes, DVP, agro, ZK, agentes e paymaster |
| `GET/POST` | `/v1/web3/networks` | Lista / registra appchain, subnet, L2 ou L1 |
| `GET` | `/v1/web3/networks/:id` | Detalhe por id ou `chainId` |
| `GET/POST` | `/v1/web3/oracle/feeds` | Lista feeds com última rodada / registra feed |
| `POST` | `/v1/web3/oracle/prices` | Publica rodada de preço ancorada |
| `GET` | `/v1/web3/oracle/prices/:symbol` | Lê preço validando staleness |
| `GET/POST` | `/v1/web3/dvp/offers` | Lista ofertas (`?status=`, `?mine=true`) / cria oferta |
| `GET` | `/v1/web3/dvp/offers/:id` | Detalhe da oferta |
| `POST` | `/v1/web3/dvp/offers/:id/accept` | Liquidação atômica |
| `POST` | `/v1/web3/dvp/offers/:id/cancel` | Cancela oferta própria |
| `GET` | `/v1/web3/dvp/trades` | Trades liquidados |
| `GET/POST` | `/v1/web3/agro/contracts` | Lista / abre crédito agro |
| `GET` | `/v1/web3/agro/contracts/:id` | Contrato com LTV atual |
| `POST` | `/v1/web3/agro/contracts/:id/repay` | Amortiza ou quita |
| `POST` | `/v1/web3/agro/contracts/:id/liquidate` | Liquidação permissionless |
| `GET/POST` | `/v1/web3/zk/attestations` | Lista / emite atestação de predicado |
| `POST` | `/v1/web3/zk/attestations/:id/revoke` | Revoga atestação |
| `POST` | `/v1/web3/zk/verify` | Verifica com nullifier e anti-replay |
| `GET` | `/v1/web3/zk/verifications` | Histórico de verificações |
| `GET/POST` | `/v1/web3/agents/sessions` | Lista / emite session key |
| `POST` | `/v1/web3/agents/sessions/:id/authorize` | Autoriza ação contra política, sessão e teto |
| `POST` | `/v1/web3/agents/sessions/:id/revoke` | Revoga session key |
| `GET/POST` | `/v1/web3/paymaster/budgets` | Lista / cria orçamento de patrocínio |
| `GET` | `/v1/web3/paymaster/ops` | UserOps patrocinadas |
| `POST` | `/v1/web3/paymaster/sponsor` | Patrocina UserOp |
| `GET` | `/v1/web3/aladdin/overview` | Risco mais recente, política, empréstimos, provas e âncoras |
| `GET/POST` | `/v1/web3/aladdin/risk/metrics` | Lista métricas / registra métrica de fonte `ORACLE_FUSION` ou `OPERATOR` |
| `POST` | `/v1/web3/aladdin/risk/simulate` | Monte Carlo determinístico + score de crédito |
| `POST` | `/v1/web3/aladdin/zk/prove` | Gera prova Groth16 localmente (simulação do SDK cliente) |
| `GET/POST` | `/v1/web3/aladdin/zk/proofs` | Lista provas / verifica e registra prova com anti-replay |
| `GET/POST` | `/v1/web3/aladdin/loans` | Lista / abre crédito algorítmico (exige score, prova e limite) |
| `GET` | `/v1/web3/aladdin/loans/:id` | Detalhe do empréstimo |
| `POST` | `/v1/web3/aladdin/loans/:id/repay` | Amortiza ou quita |
| `GET/POST` | `/v1/web3/ccip/lanes` | Lista / registra lane CCIP (selectors, router, receiver, teto) |
| `GET/POST` | `/v1/web3/ccip/liquidity` | Lista / registra liquidez P2P do solver na lane |
| `GET/POST` | `/v1/web3/intents` | Lista intents próprias / cria intent com escrow |
| `GET` | `/v1/web3/intents/overview` | KPIs de intents, volume, entregue e mensagens |
| `GET` | `/v1/web3/intents/:id` | Intent com cotações e mensagem CCIP |
| `POST` | `/v1/web3/intents/:id/quotes` | Registra cotação do solver (score de IA) |
| `POST` | `/v1/web3/intents/:id/select` | Seleciona a melhor cotação (ou `quoteId` explícito) |
| `POST` | `/v1/web3/intents/:id/execute` | Liquida escrow, libera liquidez e emite mensagem CCIP |
| `POST` | `/v1/web3/intents/:id/cancel` | Cancela e devolve o escrow ao titular |
| `GET` | `/v1/web3/ccip/messages` | Mensagens CCIP emitidas (`?laneId=`) |

O contrato completo também aparece em `GET /openapi.json`.

## Invariantes

- **Ledger sempre balanceado**: DVP e crédito agro só escrevem via `postGroup`; qualquer perna em BRL fecha débito e crédito no mesmo grupo.
- **Lastro preservado**: o crédito agro move colateral para um holder de escrow explícito; a quitação só devolve o colateral quando o saldo devedor zera.
- **Nada de replay**: nonce por maker no DVP, nullifier por finalidade/dia no ZK, `userOpHash` único no paymaster e nonce consumido antes das transferências.
- **Preço nunca silencioso**: `readPrice` falha com `ORACLE_MISSING`, `ORACLE_STALE` ou `ORACLE_PAUSED`; não existe fallback para zero.
- **Chave de sessão não é persistida**: `grantAgentSession` devolve a chave uma única vez e guarda apenas `sha256("xpartner:agent-session:v1:" + chave)`. A listagem nunca expõe hash nem chave.
- **Tudo ancorado**: toda mutação relevante chama `appendAnchor`, então `verifyAnchorChain` detecta adulteração.
- **Prova ZK não reutilizável**: `zk_snark_proofs.proof_hash` é `UNIQUE` (anti-replay) e a prova que lastreia um empréstimo é marcada com `consumed_by`; a mesma prova não abre dois créditos.
- **Crédito algorítmico disciplinado**: sem métrica válida (`ALADDIN_RISK_MISSING`/`ALADDIN_RISK_STALE`), score abaixo de 7.000 (`ALADDIN_SCORE_LOW`), VaR acima do teto (`ALADDIN_VAR_HIGH`) ou empréstimo ativo (`ALADDIN_LOAN_ACTIVE`), o crédito é recusado.
- **Intent atômica**: o escrow do ativo de origem só sai para o solver após cotação selecionada e liquidez de destino suficiente; cancelamento devolve o escrow e a taxa do solver vai para `FEE_REVENUE` via `postGroup`.

## Demonstração

Com `DEMO_MODE=true` e `SEED_DEMO=true`, `seedWeb3` registra duas redes (appchain do consórcio e subnet agro), dois feeds com preço, uma oferta DVP aberta com NFCR, uma atestação de faturamento verificada e um orçamento de paymaster. `seedAladdin` acrescenta uma métrica Monte Carlo para o lojista demo, a lane `Consórcio → Subnet Agro` e liquidez P2P de NFCR. Os seeds são idempotentes. A prova Groth16 **não** é gerada no boot (custa segundos por design); ela é criada sob demanda em `/v1/web3/aladdin/zk/prove`.

## zk-SNARK de patrimônio

O circuito [`circuits/NetWorthProof.circom`](../circuits/NetWorthProof.circom) prova:

```
Poseidon(netWorth, salt) == commitment
netWorth >= threshold
satisfied == 1
```

Sinais públicos: `[commitment, satisfied, thresholdCents]`. O core usa os artefatos de `circuits/build/` (wasm + zkey) para provar e `verification_key.json` para verificar com snarkjs; o verificador Solidity gerado fica em `contracts/generated/NetWorthVerifier.sol` (GPL-3.0). Rebuild com `npm run zk:build`.

Limites: a cerimônia é **de demonstração**; a prova é gerada no servidor para o fluxo de demo (produção deve provar no cliente); o circuito não vincula identidade nem KYC. Ver [`docs/AGENT_HSM.md`](AGENT_HSM.md) para empacotamento com HSM.

## CCIP e intents

O fluxo é: criar lane → registrar liquidez do solver → criar intent (escrow) → cotar → selecionar → executar. Na execução, o core move o ativo do escrow para o solver, debita a liquidez de destino, credita a taxa em `FEE_REVENUE` e grava uma mensagem `ccip_messages` com `messageId = sha256(lane|sequence|intent|receiver|symbol|amount)`.

A entrega cross-chain é **modelada no ledger interno**: não há router CCIP ao vivo. `IntentReceiver.sol` mostra a perna de destino pronta para o router oficial (somente router, lane allowlist, replay por mensagem e por intent).


## Paridade on-chain

Os contratos em [`contracts/`](../contracts/README.md) são referência endurecida, não espelho byte a byte:

- `AtomicDVP.sol` usa **EIP-712/keccak256**; o core usa **SHA-256** sobre a mesma estrutura de campos.
- `AgroCreditVault.sol` e `XPartnerPaymaster.sol` implementam as mesmas travas (LTV, staleness, teto por operação, teto global) com mutex de reentrância e transferências seguras.
- `ZKComplianceVerifier.sol` verifica assinatura de emissor e nullifier; para privacidade criptográfica real, use o caminho abaixo.
- `AladdinRiskEngine.sol` é o contrato com **zk-SNARK real**: chama `generated/NetWorthVerifier.sol`, exige `satisfied == 1`, limiar mínimo, compromisso único e atestação EIP-712 assinada pelo agente (nonce, validade, score, VaR).
- `IntentVault.sol` + `IntentReceiver.sol` modelam escrow de origem, liquidez pré-financiada do solver, liquidação por relayer/router e recepção CCIP somente-router com lane allowlist e anti-replay.
- `AgentPolicyVault.sol` reproduz a session key com allowlist de alvo/seletor, teto, expiração e revogação.

Nenhum contrato foi compilado ou auditado neste repositório. Produção exige auditoria, multisig/timelock, testes de invariantes e revisão jurídica. O guia de HSM/Docker está em [`docs/AGENT_HSM.md`](AGENT_HSM.md).

## Limites explícitos

- DVP, crédito agro, Aladdin e intents movem valores **demo** dentro do ledger; não há integração com dinheiro real, tesouraria regulada ou custódia de terceiros.
- O oráculo aceita publicação autenticada pela própria API; em produção, o publicador deve ser um serviço com multisig e limites de desvio.
- A atestação de `web3_zk_attestations` prova que um emissor autorizado afirmou um predicado; **não** é zk-SNARK. A prova Groth16 de patrimônio é real, mas cobre apenas `patrimônio ≥ limiar` sobre um compromisso Poseidon, sem identidade.
- A entrega cross-chain é simulada no ledger; `IntentReceiver.sol` é a referência da perna de destino, não uma lane CCIP ativa.
- Paymaster usa uma struct local de UserOperation; produção deve importar a interface oficial do EntryPoint e acompanhar a especificação ERC-4337 vigente.
- Não há leitura nem persistência de dado biométrico, genoma ou identificador civil nesta camada.

## Roadmap natural

1. Expor as rotas v11 no Worker/D1 (paridade de edge).
2. Provar no cliente (wasm) e manter o zkey em um prover isolado/HSM cofre.
3. Cerimônia multi-participante do circuito e auditoria do verificador gerado.
4. Deploy dos contratos em testnet permissionada com Foundry + invariantes.
5. Router CCIP oficial e lane real por chain selector, com monitoramento de mensagens falhas.
6. Multisig/timelock para governança de redes, oráculos, paymaster e verificador.
7. UI `/web3` no aplicativo com mesa de DVP, saúde de LTV, console Aladdin e mesa de intents.
