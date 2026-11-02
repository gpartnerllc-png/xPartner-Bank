# Stack · o que roda, o que é referência e o que é roadmap

Esta página existe para não vender fumaça. O xPartner Bank é uma base funcional de engenharia; a lista de tecnologias pedida é grande e nem tudo cabe — nem deve caber — em um único processo local. Abaixo, cada tecnologia aparece com o estatuto **real** dentro do repositório.

Legenda:

- **Roda** — há código executável, testado nesta entrega.
- **Referência** — há schema, contrato ou manifesto versionado, mas não é executado aqui.
- **Emulado** — o comportamento existe com mecanismo mais simples declarado.
- **Roadmap** — desenho documentado, sem código.

## 1. Núcleo financeiro

| Camada | Tecnologia pedida | Estatuto | Onde |
|---|---|---|---|
| Runtime | TypeScript, Node.js 24 | **Roda** | `src/**` |
| HTTP | Fastify 5, WebSocket | **Roda** | `src/api/server.ts`, `src/modules/notifications.ts` |
| Banco | SQLite WAL (`node:sqlite`) | **Roda** | `src/kernel/db.ts` |
| Ledger | dupla entrada, centavos inteiros, `BEGIN IMMEDIATE` | **Roda** | `src/domain/ledger.ts`, `src/modules/bank.ts` |
| Eventos | outbox transacional + bus em processo | **Roda** | `src/kernel/bus.ts` |
| Eventos em escala | Kafka / Redpanda | **Emulado** | mesma semântica de tópico/deduplicação/DLQ; troca de adaptador |
| Streaming | Apache Flink | **Roadmap** | agregações hoje em SQL |
| Banco relacional de produção | PostgreSQL / MySQL com réplica | **Referência** | `db/schema.postgres.sql`, Docker Compose |
| Ledger unificado (UUID/JSONB) | PostgreSQL 16+ | **Referência** | `db/schema.ledger.postgres.sql` (schema `ledger_core`) |
| ACID distribuído | CockroachDB / Spanner | **Roadmap** | desenho multicloud em `docs/ARQUITETURA.md` |
| Cache | Redis Enterprise | **Emulado** | rate limit em memória/KV |
| Contêineres | Docker, Kubernetes | **Referência** | `Dockerfile`, `docker-compose.yml`, `deploy/k8s.yaml` |
| gRPC | contrato de serviço | **Referência** | `proto/bank.proto` (não compilado) |
| Outras linguagens | C++, Java/NestJS, Go, Kotlin, Elixir, Python, Julia | **Roadmap** | extração de serviços; nenhuma dessas linhas roda aqui |
| Dados analíticos | Snowflake, Hadoop, Sybase ASE | **Roadmap** | exportação CSV e views prontas para CDC |
| Observabilidade | Splunk / ELK | **Emulado** | logs estruturados, `/metrics` Prometheus, health checks |

O núcleo é um **monólito modular deliberado**. Cada módulo tem fronteira de domínio, o que permite trocar SQLite por PostgreSQL, o bus por Kafka e chamadas internas por gRPC sem reescrever os casos de uso. Dizer que Kafka, Spanner ou Snowflake “rodam” aqui seria mentira: eles são o alvo de migração, não a implementação.

## 2. Conta digital

| Item | Estatuto | Onde |
|---|---|---|
| Cadastro PF/PJ com CPF/CNPJ | **Roda** | `src/modules/bank-auth.ts` |
| Aprovação pelo administrador | **Roda** | idem + `public/bank.html` |
| Senha scrypt, sessão, CSRF, bloqueio | **Roda** | idem |
| Transferência interna atômica | **Roda** | `src/modules/bank.ts` |
| Idempotência + E2E + comprovante com hash | **Roda** | idem |
| Extrato com saldo após lançamento + CSV | **Roda** | idem |
| Score de crédito | **Roda** (determinístico, 0–1000) | idem |
| Score por XGBoost / PyTorch | **Roadmap** | hoje é regra explicável, não modelo treinado |
| Transferência para outro banco | **Não existe** | exige PSP/SPI |
| Cartão, crédito, câmbio | **Roadmap** | — |

## 3. Edge Cloudflare

| Serviço | Estatuto | Uso |
|---|---|---|
| Workers | **Roda localmente** | API `/v1/bank/*` |
| D1 | **Roda localmente** | usuários, contas, razão, auditoria |
| KV | **Roda localmente** | rate limit |
| R2 | **Roda localmente** | comprovantes JSON |
| Queues + DLQ | **Roda localmente** | eventos de negócio |
| Workers AI | **Roda localmente com fallback** | insights de perfil |
| Deploy em produção | **Pendente** | faltam IDs e segredos da sua conta |
| Hyperdrive | **Não usado** | não há Postgres externo para acelerar |
| Vectorize, Durable Objects, Workflows | **Roadmap** | não necessários para o escopo atual |

O Worker foi executado com `wrangler dev`, migração aplicada, cadastro, aprovação, aporte, transferência, replay idempotente, extrato, comprovante no R2, score, IA com fallback, login de cliente e consumo de fila. O que falta é publicar.

Detalhes em [docs/CLOUDFLARE.md](CLOUDFLARE.md).

## 4. Web3, RWA e DePIN

| Item pedido | Estatuto | Onde |
|---|---|---|
| Contratos Solidity (ADLA, bio-royalty, governança, Merkle) | **Referência** | `contracts/*.sol` — não compilados nem implantados |
| PoPW / DePIN EVM | **Referência** | `contracts/DePINRegistry.sol` + recompensa contábil real no ledger |
| RWA e emissão lastreada | **Roda** (dentro do banco) | `src/modules/tokenization.ts` e ledger |
| NFT dinâmico / bioativos | **Roda** (metadados e royalty) | tokenização + consentimento por hash |
| Oráculos neurais | **Roadmap** | não há oráculo on-chain operando |
| Provas de credencial / ZK | **Emulado** | compromisso SHA-256 + inclusão Merkle, rotulado |
| Pontes PIX/Lightning/Drex/TCA | **Emulado** | cotação e liquidação interna declaradas demo |
| TEE / atestação de hardware | **Roadmap** | contrato prevê atestação; não há enclave |
| Agentes autônomos 24/7 sem filtro | **Não implementado por decisão** | ver abaixo |
| Agentes com guardrails | **Roda** | allowlist, limite por ação, limite diário e revisão humana |

**Por que não há agente “sem filtro” operando DeFi:** um agente sem limites movendo dinheiro real é um risco financeiro e jurídico, não um diferencial. A implementação entrega o oposto — agentes com allowlist, teto por ação, teto diário e revisão humana — e documenta o motivo. Autonomia irrestrita permanece fora do escopo até existir custódia regulada, auditoria e responsabilidade definida.

## 5. Inteligência artificial

| Item | Estatuto |
|---|---|
| Workers AI para leitura de perfil | **Roda** (edge, com fallback heurístico) |
| IA para crédito e risco (XGBoost/PyTorch) | **Roadmap** |
| Orquestração local (Ollama/LM Studio) | **Roadmap** |
| Modelos generativos no atendimento | **Roadmap** |

## 6. Segurança e privacidade

| Item | Estatuto |
|---|---|
| P2PE, tokenização de cartão | **Roda** (simulador de captura) |
| mTLS de maquininha (CA, CN, fingerprint) | **Roda** quando configurado |
| CRL/OCSP e HSM de CA | **Roadmap** |
| HMAC de dispositivo, mTLS documentado | **Roda** / referência |
| scrypt (Node) e PBKDF2 (edge) | **Roda** |
| CSRF, rate limit, auditoria, revogação de sessão | **Roda** |
| HSM / KMS | **Roadmap** |
| PCI DSS, licença bancária, adesão a bandeiras | **Fora do escopo** — exigem processo regulatório |

## 7. Como essa stack evolui sem reescrever

1. **Banco**: trocar `node:sqlite` por PostgreSQL usando `db/schema.postgres.sql`; o domínio já fala SQL padrão e centavos inteiros.
2. **Eventos**: substituir o bus em processo por Kafka mantendo o outbox; consumidores já deduplicam.
3. **Serviços**: extrair `bank`, `pix`, `fiscal` e `ledger` para processos Go/Java/Elixir atrás do contrato em `proto/bank.proto`.
4. **Edge**: publicar o Worker e manter o contrato `/v1/bank/*` idêntico ao núcleo.
5. **Analytics**: CDC do Postgres para Snowflake; views `contas`/`transacoes` já expõem o modelo em português.
6. **IA de crédito**: treinar modelo com o histórico do ledger e servir atrás do endpoint de score, mantendo o cálculo determinístico como fallback auditável.

## 8. Regra de honestidade

Nenhuma página deste repositório chama de “produção” o que roda em SQLite local, nem de “blockchain” o que é registro contábil interno. Quando algo é demonstração, o rótulo aparece na API, na interface e no documento. Essa disciplina é parte do produto: um banco que confunde simulação com dinheiro real não é confiável.
