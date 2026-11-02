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

O contrato completo também aparece em `GET /openapi.json`.

## Invariantes

- **Ledger sempre balanceado**: DVP e crédito agro só escrevem via `postGroup`; qualquer perna em BRL fecha débito e crédito no mesmo grupo.
- **Lastro preservado**: o crédito agro move colateral para um holder de escrow explícito; a quitação só devolve o colateral quando o saldo devedor zera.
- **Nada de replay**: nonce por maker no DVP, nullifier por finalidade/dia no ZK, `userOpHash` único no paymaster e nonce consumido antes das transferências.
- **Preço nunca silencioso**: `readPrice` falha com `ORACLE_MISSING`, `ORACLE_STALE` ou `ORACLE_PAUSED`; não existe fallback para zero.
- **Chave de sessão não é persistida**: `grantAgentSession` devolve a chave uma única vez e guarda apenas `sha256("xpartner:agent-session:v1:" + chave)`. A listagem nunca expõe hash nem chave.
- **Tudo ancorado**: toda mutação relevante chama `appendAnchor`, então `verifyAnchorChain` detecta adulteração.

## Demonstração

Com `DEMO_MODE=true` e `SEED_DEMO=true`, `seedWeb3` registra duas redes (appchain do consórcio e subnet agro), dois feeds com preço, uma oferta DVP aberta com NFCR, uma atestação de faturamento verificada e um orçamento de paymaster. O seed é idempotente e não roda se já houver rede registrada.

## Paridade on-chain

Os contratos em [`contracts/`](../contracts/README.md) são referência endurecida, não espelho byte a byte:

- `AtomicDVP.sol` usa **EIP-712/keccak256**; o core usa **SHA-256** sobre a mesma estrutura de campos.
- `AgroCreditVault.sol` e `XPartnerPaymaster.sol` implementam as mesmas travas (LTV, staleness, teto por operação, teto global) com mutex de reentrância e transferências seguras.
- `ZKComplianceVerifier.sol` verifica assinatura de emissor e nullifier; para privacidade criptográfica real, troque por um verificador Groth16/PLONK.
- `AgentPolicyVault.sol` reproduz a session key com allowlist de alvo/seletor, teto, expiração e revogação.

Nenhum contrato foi compilado ou auditado neste repositório. Produção exige auditoria, multisig/timelock, testes de invariantes e revisão jurídica.

## Limites explícitos

- DVP, crédito agro e paymaster movem valores **demo** dentro do ledger; não há integração com dinheiro real, tesouraria regulada ou custódia de terceiros.
- O oráculo aceita publicação autenticada pela própria API; em produção, o publicador deve ser um serviço com multisig e limites de desvio.
- A atestação ZK prova que um emissor autorizado afirmou um predicado; não prova matemática de conhecimento zero.
- Paymaster usa uma struct local de UserOperation; produção deve importar a interface oficial do EntryPoint e acompanhar a especificação ERC-4337 vigente.
- Não há leitura nem persistência de dado biométrico, genoma ou identificador civil nesta camada.

## Roadmap natural

1. Migrar schema v10 para D1 e expor as mesmas rotas no Worker.
2. Verificador de prova real (Groth16/PLONK) por trás de `ZKComplianceVerifier`.
3. Deploy dos contratos em testnet permissionada com Foundry + invariantes.
4. Multisig/timelock para governança de redes, oráculos e paymaster.
5. UI `/web3` no aplicativo com mesa de DVP, saúde de LTV e console de sessões de agente.
