# Tokenização, bioativos e agentes · xPartner Bank

Esta camada adiciona ao core financeiro um **registro de ativos tokenizados lastreados no ledger**, **royalties de bioativos com consentimento verificável**, **governança DAO**, **DePIN com Proof of Physical Work**, **agentes com guardrails** e **pontes multi-trilho** — tudo executável hoje, com limites explícitos sobre o que é simulação, referência ou roadmap.

> **Honestidade técnica:** não há zk-SNARK, não há dado biométrico, não há staking de DNA, não há agente autônomo irrestrito e nenhum contrato está implantado. O que existe está descrito abaixo, com testes que provam o comportamento.

## 1. Princípios

1. **Token é obrigação registrada, não promessa.** Cada unidade emitida tem lastro em conta de ledger; emissão e resgate são grupos de dupla entrada balanceados.
2. **Consentimento antes de biovalor.** Bioativo só existe com hash de consentimento e dataset; só paga royalty depois de admissão pela DAO; revogação é imediata.
3. **Nada de dado sensível.** O core guarda compromissos SHA-256, nunca genoma, íris, rosto ou identificador civil.
4. **Autonomia com trilhos.** Agente avalia ações dentro de política (símbolos, notional, limite diário, aprovação humana); não executa operação financeira sozinho.
5. **Prova de inclusão é honesta.** Usamos compromissos e Merkle de divulgação seletiva; não chamamos isso de zero-knowledge.
6. **Tudo ancorado.** Cada fato relevante entra na cadeia `anchor_chain`, verificável a qualquer momento por recálculo completo.

## 2. O que roda hoje

| Capacidade | Onde | Prova |
|---|---|---|
| Emissão, transferência e resgate lastreados | `TokenizationHub` | `tests/tokenization.test.ts`, `tests/tokenization-api.test.ts` |
| Bioativo com consentimento, admissão DAO e royalty | `TokenizationHub` + ledger | teste de bioativo e API HTTP |
| DePIN com prova física e recompensa | `TokenizationHub` + ledger | teste de dispositivo |
| Governança ADLA ponderada | `TokenizationHub` | teste de DAO |
| Agentes com guardrails | `TokenizationHub` | teste APPROVE/REVIEW/BLOCK |
| Pontes PIX/Lightning/Drex/TCA | `TokenizationHub` | teste de cotação, liquidação e expiração |
| Credenciais e inclusão Merkle | `src/domain/zk.ts` | teste de prova e adulteração |
| Cadeia de âncoras | `src/kernel/anchor.ts` | teste de detecção de adulteração |
| Dashboard operacional | `/tokenization.html` | smoke de UI e API |
| Contratos de referência | `contracts/` | não compilados nem implantados |

A demonstração nasce com ADLA, recebíveis NFC-e (NFCR), cotítulo TCA26, bioativo admitido, dispositivo DePIN, agente com bloqueio e revisão, três pontes liquidadas, credenciais e âncoras.

## 3. Arquitetura

```
┌──────────────────────── xPartner Bank (Node 24) ────────────────────────┐
│                                                                         │
│  Fastify /v1/tokenization/*                                             │
│        │                                                                │
│        ▼                                                                │
│  TokenizationHub ──► Ledger (dupla entrada, centavos inteiros)          │
│        │        │                                                       │
│        │        ├──► token_assets / holdings / events                   │
│        │        ├──► bio_assets / bio_royalties                         │
│        │        ├──► depin_devices / depin_rewards                      │
│        │        ├──► dao_proposals / dao_votes                          │
│        │        ├──► agent_policies / agent_decisions                   │
│        │        ├──► bridge_intents                                     │
│        │        ├──► zk_credentials (compromissos)                      │
│        │        └──► anchor_chain (hash-chain append-only)              │
│        │                                                                │
│        └──► Outbox ──► Event Bus (token.minted, bio.royalty_paid, ...)  │
│                                                                         │
│  SQLite WAL ── migração v1→v2 por PRAGMA user_version                   │
└─────────────────────────────────────────────────────────────────────────┘

contracts/*.sol  ── referência da camada on-chain, mesma canonicalização
```

## 4. Ativos tokenizados e lastro contábil

Tipos aceitos: `RWA`, `DEBT`, `BIO`, `DEPIN`, `KNOWLEDGE`, `COMPUTE`.

Regras de emissão:

- `backingPerUnitCents > 0`; `supply_units + units <= max_units`.
- Símbolo único de 3 a 12 caracteres alfanuméricos.
- `metadataHash = sha256("asset:" + JSON canônico)` ancora os termos do ativo.
- Cupom opcional de 0 a 10.000 bps; vencimento opcional.

Movimentos no ledger:

| Operação | Débito | Crédito | Efeito |
|---|---|---|---|
| Emitir | `TOKEN_RESERVE` | `TOKEN_LIABILITY` | lastro entra, obrigação nasce |
| Transferir | — | — | só muda titularidade; não cria lastro |
| Resgatar | `TOKEN_LIABILITY` | `TOKEN_RESERVE` | obrigação e lastro saem juntos |

`TOKEN_RESERVE` é conta de plataforma; `TOKEN_LIABILITY` também. Em produção, o lastro precisa de custódia segregada e conciliação diária com o emissor.

## 5. Bioativos: consentimento, DAO e royalty

Fluxo implementado:

1. **Registro** com `name`, pseudônimo do titular, texto de consentimento (≥ 24 caracteres), escopo, `datasetId` e `royaltyBps` (0–3000).
2. O core guarda `consentHash = sha256("consent:" + texto)` e `datasetHash = sha256("dataset:" + id)`. Nada além disso.
3. Status inicial `PENDING`; **nenhum royalty pode ser pago**.
4. Proposta `ADMIT_BIO_SOURCE` é aberta na DAO; aprovação exige quórum e maioria.
5. Aprovação muda para `ADMITTED` e grava `admission_proposal_id`.
6. Cada licença paga separa royalty ao estabelecimento titular e margem de licenciamento:

```
gross = royalty + platformFee
D CASH                          gross
C ROYALTY_PAYABLE (merchant)    royalty
C FEE_REVENUE                   platformFee
```

7. `POST /bio/:id/revoke` muda para `REVOKED`, publica evento e ancora a decisão; novas licenças são bloqueadas.

O royalty é **contratual e consentido**, limitado a 30% do valor da licença. Não é participação em "vida", pessoa ou genoma.

## 6. DePIN e Proof of Physical Work

- Registro de dispositivo com `model`, `capacityUnits` e hash da prova física.
- Cada recompensa exige prova inédita e `units <= capacityUnits`.
- Recompensa fixa de **2 centavos por unidade**, paga no ledger:

```
D DEPIN_REWARD_EXPENSE  2 × units
C MERCHANT_AVAILABLE    2 × units
```

- `slash` e `retire` existem nos contratos de referência; no core o status é `ACTIVE`, `SLASHED` ou `RETIRED`.
- A prova é um hash de atestação. Em produção, deve vir de assinatura de hardware/TEE ou do fabricante; hoje é demonstrativa e assim declarada.

## 7. Governança ADLA

- Peso de voto = saldo de ADLA do votante no momento do voto; um voto por titular por proposta.
- Proposta exige `kind` (`ADMIT_BIO_SOURCE`, `TREASURY_SPEND`, `PARAMETER_CHANGE`), subject, título, descrição, quórum (padrão 100 unidades) e duração (padrão 72 h, máximo 720 h).
- Voto só é aceito em proposta `OPEN` e antes de `closes_at`.
- Fechamento aprova se `votes_for >= quorum` **e** `votes_for > votes_against`.
- Aprovação de bioativo aplica a admissão atomicamente.
- Cada proposta, voto e decisão gera âncora.

Limitação declarada: o peso usa saldo corrente, não snapshot histórico. Produção deve usar checkpoints/ERC20Votes e timelock para execução.

## 8. Agentes autônomos com guardrails

A ordem de avaliação é determinística:

1. Símbolo fora da allowlist → `BLOCK`.
2. Notional acima do limite por ação → `BLOCK`.
3. Soma do dia + notional acima do limite diário → `BLOCK`.
4. Notional ≥ gatilho de aprovação humana → `REVIEW`.
5. Caso contrário → `APPROVE`.

Toda decisão é persistida com motivos, ancorada e publicada em `agent.decision`. **Não existe caminho de execução financeira automática**: mesmo `APPROVE` é uma autorização limitada que outro fluxo precisa consumir. O "agente sombra" é um avaliador somente-leitura; não é um agente irrestrito.

## 9. Pontes multi-trilho

| Trilha | Tarifa | Cotação | Estado |
|---|---|---|---|
| PIX / SPI | 30 bps, mínimo 50 centavos | 1 BRL = 1 BRL, D+0 | simulado |
| Bitcoin Lightning | 45 bps | 1 BRL ≈ 1.000 sat | simulado |
| Drex (CBDC) | 20 bps | 1 BRL = 1 DREX | piloto |
| TCA (crédito tokenizado) | 60 bps | paridade de lastro | interno |

Fluxo: `quote` grava intenção com validade de 5 minutos e âncora; `settle` liquida antes do vencimento ou marca `EXPIRED`. A liquidação é **interna e contábil**, não movimenta SPI, Lightning ou rede Drex reais.

## 10. Credenciais e provas de inclusão

- `commitClaim = sha256("xpartner:commit:v1:{salt}:{subject}:{claimType}:{value}")`.
- A credencial guarda apenas o compromisso; o salt é devolvido ao titular e não é persistido.
- A prova monta a árvore Merkle do tipo de credencial e devolve o caminho.
- Folha: `sha256("00" + commitmentHex)`; nó: `sha256("01" + menor + maior)`.
- A verificação recalcula a raiz; adulteração de folha, caminho ou raiz falha.

Isso prova **pertinência a um conjunto** sem revelar os demais membros, mas o verificador recebe o compromisso e o caminho. Não é prova de conhecimento zero. zk-SNARK real está no roadmap, com circom/snarkjs e circuito auditado.

## 11. Cadeia de âncoras

```
anchorHash = sha256("{prevHash}|{payloadHash}|{height}|{createdAt}")
GENESIS = 64 zeros
```

- Append-only, uma linha por fato relevante.
- `GET /v1/tokenization/anchors` devolve o status da verificação completa.
- Qualquer alteração de payload, altura, elo anterior ou hash quebra a cadeia e é detectada.
- A cadeia é local; ancorar periodicamente o `latestHash` em rede pública é o passo de soberania (roadmap).

## 12. Contratos de referência

`contracts/` contém `ADLAToken`, `BioRoyaltyVault`, `DePINRegistry`, `XPartnerGovernor` e `MerkleAnchor`. Eles reproduzem as regras acima e a mesma canonicalização SHA-256. **Não foram compilados, testados nem implantados**; ver `contracts/README.md`.

## 13. Mapa da lista solicitada

| Item solicitado | Estado nesta entrega | Onde / observação |
|---|---|---|
| Token ADLA | **Implementado** | ativo com lastro, governança ponderada e seed demo |
| Blockchain open source | **Parcial** | código aberto e âncoras portáveis; rede permissioned (Besu) é roadmap |
| Tokenização de infraestrutura | **Implementado** | kinds RWA/DEBT/DEPIN/COMPUTE e registro de ativos |
| TCA, Bitcoin Lightning e Drex | **Implementado como simulação** | pontes com cotação, tarifa, liquidação e expiração; trilhos reais são roadmap |
| Ocean Protocol / tokens de conhecimento | **Não adotado como dependência** | `KNOWLEDGE` existe no modelo; interoperabilidade com Ocean é roadmap |
| Worldcoin World ID / íris | **Não adotado** | biometria de íris e identidade civil ficam fora; alternativa é consentimento + credencial seletiva |
| DeAI / renda por inteligência | **Parcial** | agentes com política e kind `COMPUTE`; nenhuma promessa de renda |
| Blockchain + IA cripto | **Implementado** | decisões de agente e fatos de ativo ancorados |
| Edge AI | **Roadmap** | integração local com Ollama/LM Studio sem dependência de nuvem |
| Agentes generativos | **Implementado com guardrails** | avaliador determinístico, sem execução irrestrita |
| Zero-Knowledge Proofs | **Parcial, rotulado com honestidade** | compromissos + Merkle; zk-SNARK é roadmap, não claim atual |
| Ollama / LM Studio | **Roadmap** | modelo local para classificação e explicação; decisão financeira continua determinística |
| Protocolo de bioativos | **Implementado** | consentimento, dataset hash, admissão DAO, royalty e revogação |
| "IA Shadow" | **Parcial** | agente sombra somente-leitura que avalia e registra; não opera |
| Web3 / smart contracts | **Referência** | contratos Solidity no repositório, não implantados |
| Bio-data lake | **Parcial** | apenas hash de dataset; lake federado com consentimento é roadmap |
| NFTs dinâmicos ERC-721/1155 | **Roadmap** | hoje eventos + âncora; certificados NFT exigem contrato e custódia |
| DePIN Render / Akash / io.net | **Parcial** | PoPW próprio implementado; integrações de rede são roadmap |
| Nós validadores Solana/Ethereum | **Roadmap** | âncoras já são portáveis; operação de validador não faz parte do core |
| DNA staking / Bio-Staking | **Não adotado** | mercantiliza genoma e pessoa; incompatível com consentimento e LGPD |
| Eficiência de capital com IA | **Parcial** | limites por ação/dia e revisão humana; sem alavancagem autônoma |
| Agente "Shadow unfiltered" | **Não adotado** | agente sem política é risco operacional e regulatório |
| Infraestrutura DePIN | **Implementado** | dispositivos, capacidade, provas e recompensas |
| Nó soberano | **Parcial** | cadeia local verificável; ancoragem pública é roadmap |
| DAO gatekeeper do master code | **Parcial** | gate de admissão de bioativo implementado; upgrade de código com timelock é roadmap |
| Royalties de bioativos "sobre a vida" | **Implementado com limite** | royalty consentido ≤ 30%, não direito sobre a pessoa |
| Solidity | **Referência** | cinco contratos em `contracts/` |
| Oráculos neurais | **Roadmap** | hoje entradas determinísticas e auditáveis; oráculo neural exige fallback e auditoria |
| Síntese de RWA | **Implementado** | recebíveis NFC-e tokenizados (NFCR) como exemplo |
| Agentes DeFi autônomos irrestritos | **Não adotado** | todo agente passa por allowlist, limites e revisão |
| WPT DePIN EVM | **Parcial** | Proof of Physical Work implementado; transferência de energia sem fio está fora de escopo |
| Hardware / TEE | **Roadmap** | hash de prova já existe; atestação TEE real é requisito de produção |
| Proof of Physical Work (PoPW) | **Implementado** | prova inédita por dispositivo, capacidade e recompensa contábil |
| Camada de smart contracts | **Referência + paridade** | contratos espelham a canonicalização do core |

## 14. Limites éticos, legais e regulatórios

- **Não é oferta pública de valores mobiliários.** Os ativos são instrumentos internos de referência; captar recursos de terceiros exige registro/isenção na CVM e estrutura juridicamente válida.
- **Não é instituição financeira licenciada.** Operar pagamentos, câmbio ou ativos virtuais exige autorização do Banco Central e adesão às regras aplicáveis (incluindo a regulação de prestadoras de serviços de ativos virtuais).
- **Bioativos:** consentimento livre, informado, específico e revogável; finalidade delimitada; minimização; nenhuma reidentificação; nenhuma biometria. O titular pode revogar e a licença futura é bloqueada.
- **Royalties:** natureza contratual, sem promessa de retorno; teto de 30% evita captura econômica desproporcional.
- **Agentes:** humano no circuito acima do limite, trilha de auditoria e nenhuma execução autônoma de crédito, câmbio ou DeFi.
- **Provas:** Merkle é apresentado como inclusão seletiva, nunca como zk-SNARK. Qualquer claim de privacidade forte exige circuito auditado.
- **DePIN:** recompensa é despesa de plataforma, não rendimento de investimento; hardware e prova precisam de atestação independente antes de dinheiro real.
- **Contratos:** referência sem auditoria; implantação exige Foundry, invariantes, auditoria externa, multisig e timelock.

## 15. Roadmap priorizado

1. **Endurecer o que existe:** testes de invariantes no ledger, conciliação de lastro, limites de exposição e revisão de API.
2. **Testnet dos contratos:** Foundry + fuzz, ERC20Votes com checkpoints, timelock, auditoria e deploy em rede de teste.
3. **Trilhos reais:** PSP/SPI para Pix, LND/LNbits para Lightning, piloto Drex e custódia para TCA com conciliação.
4. **Provas reais:** zk-SNARK para faixa de limite/KYC, Open Finance como fonte de credencial e atestação de dispositivo.
5. **Bio-data lake federado:** catálogo com consentimento, lineage, retenção e distribuição auditável de royalties.
6. **Agentes e oráculos:** LLM local (Ollama/LM Studio) para explicação, oráculo neural com fallback determinístico e avaliação contínua de política.
7. **Soberania:** ancoragem periódica em rede pública, nó validador e verificação independente por terceiros.

## 16. Operação

Dashboard: <http://localhost:8080/tokenization.html> (demo). Token: `GET /v1/demo/bootstrap`.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/v1/tokenization/overview` | KPIs de ativos, bio, DePIN, DAO, agentes, pontes e âncoras |
| `GET` | `/v1/tokenization/anchors` | status da cadeia e últimos blocos |
| `POST` | `/v1/tokenization/assets` | cria ativo |
| `POST` | `/v1/tokenization/assets/:id/mint` | emite com lastro |
| `POST` | `/v1/tokenization/assets/:id/transfer` | transfere unidades |
| `POST` | `/v1/tokenization/assets/:id/redeem` | resgata e libera lastro |
| `POST` | `/v1/tokenization/bio` | registra bioativo (PENDING) |
| `POST` | `/v1/tokenization/bio/:id/royalties` | paga licença/royalty |
| `POST` | `/v1/tokenization/bio/:id/revoke` | revoga consentimento |
| `POST` | `/v1/tokenization/depin/devices` | registra dispositivo |
| `POST` | `/v1/tokenization/depin/devices/:id/rewards` | prova e recompensa |
| `GET/POST` | `/v1/tokenization/dao/proposals` | lista/cria proposta |
| `POST` | `/v1/tokenization/dao/proposals/:id/vote` | vota com peso ADLA |
| `POST` | `/v1/tokenization/dao/proposals/:id/close` | fecha e aplica decisão |
| `GET/POST` | `/v1/tokenization/agents/policies` | políticas de guardrail |
| `POST` | `/v1/tokenization/agents/evaluate` | avalia ação do agente |
| `GET` | `/v1/tokenization/bridges/rails` | trilhas e tarifas |
| `POST` | `/v1/tokenization/bridges/quote` | cota ponte |
| `POST` | `/v1/tokenization/bridges/:id/settle` | liquida ou expira |
| `POST` | `/v1/tokenization/zk/credentials` | emite compromisso |
| `POST` | `/v1/tokenization/zk/prove` | gera prova de inclusão |
| `POST` | `/v1/tokenization/zk/verify` | verifica prova |

Exemplo:

```bash
TOKEN=$(curl -s localhost:8080/v1/demo/bootstrap | node -pe "JSON.parse(require('fs').readFileSync(0)).token")
curl -s localhost:8080/v1/tokenization/overview -H "authorization: Bearer $TOKEN"
curl -s localhost:8080/v1/tokenization/dao/proposals -H "authorization: Bearer $TOKEN"
```

## 17. Testes

`npm test` cobre o domínio bancário e a camada de tokenização:

- `tests/tokenization.test.ts`: ciclo de ativo com lastro, admissão DAO e royalty, guardrails, pontes, Merkle/adulteração, âncoras e coerência do seed.
- `tests/tokenization-api.test.ts`: fluxo HTTP completo, incluindo página, ativos, bioativo `BIO_NOT_ADMITTED`, decisões, ponte, credencial, âncoras, balancete e overview.
- `tests/e2e.test.ts`: venda, risco, roteamento, ledger, NFC-e e antecipação.

## 18. O que este módulo deliberadamente não faz

- Não deposita, não capta, não promete rendimento e não emite valor mobiliário.
- Não armazena dado biológico, genoma, íris ou identidade civil.
- Não executa operações financeiras autônomas por agente.
- Não movimenta PIX, Lightning, Drex ou TCA reais.
- Não implanta contratos ou ancoragem em rede pública.
- Não chama Merkle de zk-SNARK.
