# Arquitetura · xPartner Bank

## 1. Princípios

1. **Dinheiro é inteiro.** Todo valor trafega e é persistido em centavos (`BIGINT`). Nunca float, nunca `NUMERIC` em cálculo de saldo.
2. **Nenhum centavo sem contrapartida.** Todo fato financeiro gera um grupo de lançamentos de dupla entrada balanceado, validado antes da escrita.
3. **O evento nasce na transação.** O outbox grava o evento na mesma transação SQL do fato de negócio; não existe janela em que a venda foi persistida mas o evento se perdeu.
4. **Segurança na origem.** O servidor nunca vê PAN. A captura acontece no Secure Enclave/Android Keystore e chega como token P2PE.
5. **Falha parcial não trava a fila do lojista.** Se a SEFAZ cair, a NFC-e sai em contingência e é reconciliada depois.
6. **Tudo explicável.** Score de risco, escolha de adquirente, taxa de antecipação e rejeição fiscal carregam motivos auditáveis.

## 2. Topologia em execução

Modular monolith deliberado para a fase 1:

```
┌──────────────────────────── Node.js 24 ────────────────────────────┐
│                                                                    │
│  Fastify ──► TransactionService ──► Ledger (dupla entrada)         │
│     │             │                                                │
│     │             ├──► RiskEngine (features + grafo em SQL)        │
│     │             ├──► SmartRouter (custo esperado)                │
│     │             ├──► Authorization (ISO 8583 simulada)           │
│     │             └──► Outbox (mesma transação SQL)                │
│     │                                                              │
│     ├──► PixService ──► BR Code EMV + liquidação D+0               │
│     ├──► BillingService / SubscriptionService                       │
│     │        └──► boleto 077 · links · checkout · recorrência       │
│     ├──► OpenFinanceService ──► consentimentos · débito · ITP       │
│     ├──► InvestmentService ──► aportes · resgates · proventos       │
│     └──► SettlementWorker / FiscalWorker / NotificationHub         │
│                                                                    │
│  SQLite WAL (`node:sqlite`)  ◄── OutboxRelay ──► MemoryEventBus    │
└────────────────────────────────────────────────────────────────────┘
```

Cada módulo tem fronteira de domínio e dependências explícitas. A substituição por serviços remotos é uma troca de adaptador: `TransactionService` continua sendo o caso de uso, mas o ledger, o risco e o roteador passam a ser chamados por RPC/eventos.

## 3. Fluxo de venda

```
Maquininha/App                         API                         Serviços internos
     │  POST /v1/transactions            │
     ├──────────────────────────────────►│
     │  HMAC(ts.nonce.body) + idem-key   │ 1. valida HMAC, janela, nonce
     │                                   │ 2. replay de idempotência
     │                                   │ 3. resolve token P2PE → bandeira/final4/fingerprint
     │                                   │ 4. risco (score + decisão)
     │                                   │ 5. roteia adquirente (custo esperado)
     │                                   │ 6. autoriza (ISO 8583)
     │                                   │ 7. grava transação + ledger + settlement + outbox (1 SQL tx)
     │◄──────────────────────────────────┤
     │  201 {status, nsu, taxa, líquido} │
                                       OutboxRelay
                                           │
                        ┌──────────────────┼──────────────────┐
                        ▼                  ▼                  ▼
                   FiscalWorker      NotificationHub    SettlementWorker
                   (NFC-e/SEFAZ)     (WebSocket)        (D+n e antecipação)
```

### Idempotência

- Chave `(terminalId, Idempotency-Key)`.
- Hash SHA-256 do corpo bruto é comparado: mesma chave + mesmo corpo devolve a resposta original (`x-idempotent-replayed: true`); mesma chave + corpo diferente devolve `409`.
- Nonce de dispositivo é consumido antes; replay da mesma assinatura devolve `401`. A idempotência é a camada de negócio, o nonce é a camada criptográfica.

### Decisão de recusa

A transação recusada também é persistida com `failure_reason`, score e motivos, e alimenta o grafo (`FLAGGED`). Não há efeito no ledger nem emissão fiscal.

## 4. Ledger

Contas são identificadas por `(owner_type, owner_id, kind, currency)`:

| Conta | Natureza | Quando move |
|---|---|---|
| `ACQUIRER_RECEIVABLE` | ativo da plataforma | débito no valor bruto da venda |
| `MERCHANT_PAYABLE` | passivo com lojista | crédito no líquido a receber |
| `FEE_REVENUE` | receita | crédito na taxa MDR |
| `MERCHANT_AVAILABLE` | passivo disponível | crédito na liquidação/antecipação |
| `ANTICIPATION_REVENUE` | receita | crédito na taxa de antecipação |
| `CASH` | caixa | movimentos de tesouraria |
| `TOKEN_RESERVE` | ativo de plataforma | débito na emissão de token; crédito no resgate |
| `TOKEN_LIABILITY` | passivo de plataforma | crédito na emissão; débito no resgate |
| `ROYALTY_PAYABLE` | passivo com o titular do bioativo | crédito na licença de dataset admitido |
| `DEPIN_REWARD_EXPENSE` | despesa de plataforma | débito na recompensa por prova física |
| `OPEN_FINANCE_CLEARING` | clearing da plataforma | crédito na liquidação da iniciação Pix |
| `INVESTMENT_PRINCIPAL` | ativo do lojista | crédito no aporte; débito no resgate |
| `INVESTMENT_INCOME` | resultado da plataforma | débito na liquidação de provento |
| `TAX_PAYABLE` | passivo tributário | crédito no IR retido de provento |

Invariantes verificadas em código e em teste:

- `sum(DEBIT) == sum(CREDIT)` por grupo, antes da escrita.
- Grupo exige ≥ 2 partidas e valores positivos inteiros.
- Lançamentos são imutáveis; correção é novo lançamento.
- Balancete global sempre fecha (`trialBalance`).

## 5. Eventos

| Tópico | Produtor | Consumidores | Efeito |
|---|---|---|---|
| `transactions.approved` | venda aprovada / Pix pago | fiscal, notificações, conciliação | emite NFC-e, push, relatórios |
| `fiscal.issued` | worker fiscal | notificações, conciliação | avisa nota autorizada/contingência |
| `settlement.paid` | liquidação/antecipação | notificações, tesouraria | libera saldo e informa lojista |

Semântica: at-least-once com deduplicação por `(group_id, event_id)`. Falha após N tentativas vai para `dead_letters`. No Kafka, `partition_key = merchant_id` preserva ordem por estabelecimento.

## 6. Risco

Features calculadas em tempo de autorização:

| Feature | Consulta | Peso |
|---|---|---|
| Velocidade 1h | usos do mesmo cartão | 16 / 30 |
| Fan-out de cartão 24h | terminais distintos | 10 / 28 |
| Link sinalizado | aresta `FLAGGED` no grafo | 45 |
| Anomalia de ticket 30d | ticket / média do lojista | 14 / 26 |
| Fan-in de terminal 24h | cartões distintos | 18 |
| Horário atípico (1h–5h) | relógio | 6 |
| Parcelas ≥ 12 / ticket alto | payload | 8 / 8 |

`score >= 75` recusa; `>= 45` revisão; abaixo, aprova. Cada ponto tem motivo auditável exibido no dashboard.

Em escala: as features migram para uma feature store (Feast/Vertex) com leitura em milissegundos; o grafo é materializado em Neo4j/Neptune e consultado por padrões (cartão→terminal→lojista→conta).

## 7. Smart routing

Custo esperado por adquirente:

```
fee = round(amount × rateBps / 10000) + fixedFee + (parcelas > 1 ? amount × installmentsBps × (n-1) / 10000 : 0)
expectedCost = round(fee / successRate)
```

Ordena por `expectedCost`, desempata por taxa nominal e limita alternativas. Recusas também custam, por isso taxa de sucesso entra na conta. Em produção, `successRate` é atualizada por janela móvel e o roteador pode considerar latência e limite de exposição por adquirente.

## 8. Fiscal (NFC-e 4.00)

Chave de acesso:

```
cUF(2) AAMM(4) CNPJ(14) modelo(2=65) série(3) número(9) tpEmis(1) cNF(8) DV(1) = 44
```

Fluxo:

1. Worker consome `transactions.approved` e deduplica.
2. Aloca número por `(merchant, série)` de forma atômica.
3. Monta XML com escaping, assina RSA (XMLDSig simplificado em dev).
4. Transmite à SEFAZ com até 3 tentativas; resposta é determinística no mock.
5. Autorizada → `AUTHORIZED` com protocolo e QR Code. Rejeitada → contingência `tpEmis=9`, status `CONTINGENCY`, DANFE com aviso.
6. Persiste XML, DANFE, ESC/POS e publica `fiscal.issued`.

Produção: XMLDSig completo com certificado A1 ICP-Brasil, schema XSD oficial, endpoint da SEFAZ do estado, contingência offline com assinatura pré-calculada e reconciliação posterior — exatamente o modelo aqui descrito, trocando o transmissor.

## 9. Liquidação e antecipação

- Pix: D+0; débito: D+1; crédito/voucher: D+30.
- `SettlementWorker` move `MERCHANT_PAYABLE → MERCHANT_AVAILABLE` no vencimento.
- Antecipação: taxa base `120 bps + 9 bps por dia antecipado`, descontos por volume (30d), prêmio por risco, piso/teto 80–600 bps e taxa mínima de 50 centavos.
- O recebível antecipado vira `PAID` com `mode=ANTICIPATION`; a taxa vira `ANTICIPATION_REVENUE`.

## 10. Resiliência

| Falha | Comportamento |
|---|---|
| SEFAZ indisponível/rejeitando | contingência; nenhuma venda é perdida |
| Consumidor de evento falha | retry pelo outbox; DLQ após limite |
| Requisição repetida | idempotência devolve a resposta original |
| Assinatura repetida | nonce bloqueia replay |
| Queda do processo | WAL + transações atômicas preservam o estado |
| Dashboard desconecta | reconexão WebSocket + polling de fallback |

## 11. Escala e multicloud

Fase 2 (verticalizar o monólito sem mudar o domínio):

1. **PostgreSQL/Aurora** substitui SQLite; `db/schema.postgres.sql` é o ponto de partida.
2. **Kafka/MSK** substitui o outbox relay; o produtor continua sendo o outbox.
3. **Ledger, autorização, Pix e fiscal** viram serviços independentes com contratos versionados.
4. **Redis** para sessão, rate limit distribuído e cache de limites.
5. **HSM/KMS** para chaves de token, DUKPT e certificado fiscal.

Fase 3 (multicloud ativo-ativo):

- Autorização e ledger em AWS e GCP simultaneamente.
- Banco globalmente consistente (Spanner/CockroachDB) para o ledger; dados derivados podem ser eventualmente consistentes.
- Roteamento por saúde/latência na borda; failover sem intervenção humana.
- Risco com feature store replicada; grafo por região com reconciliação assíncrona.

Fase 4 (Drex e Open Finance):

- Nó Hyperledger Besu integrado ao core, com contratos para liquidação condicional (ex.: pagamento liberado na confirmação de entrega).
- Licença de Iniciador de Pagamentos (ITP) e APIs do Open Finance para movimentar contas externas.
- Conciliação contábil entre ledger interno, SPI e rede Drex.

## 12. Observabilidade

- `/health/live`, `/health` e `/health/ready` (inclui pendências do outbox).
- `/metrics` no formato Prometheus: requisições, latência, recusas, vendas por status/meio, fila.
- Logs JSON com redaction de chaves sensíveis (`authorization`, `token`, `pan`, `signature`, segredos).
- `audit_log` para atos relevantes (venda, recusa, nota, antecipação).

## 13. Tokenização, bioativos e provas

A camada de tokenização é um módulo explícito dentro do mesmo monólito transacional, com tabelas próprias (schema v2) e as mesmas garantias do core: centavos inteiros, dupla entrada, outbox na mesma transação e âncora append-only.

```
TokenizationHub
   ├── ativos: emissão/resgate movem TOKEN_RESERVE ↔ TOKEN_LIABILITY
   ├── bioativos: consentimento + dataset como SHA-256; admissão pela DAO; royalty → ROYALTY_PAYABLE
   ├── DePIN: prova física → DEPIN_REWARD_EXPENSE ↔ MERCHANT_AVAILABLE
   ├── DAO: peso por ADLA, quórum, fechamento e admissão atômica
   ├── agentes: allowlist → limite por ação → limite diário → revisão humana
   ├── pontes: cotação com validade, tarifa por trilha e liquidação/expiração
   ├── credenciais: compromisso + Merkle de inclusão seletiva
   └── anchor_chain: sha256(prev|payload|height|createdAt)
```

Invariantes:

- `sum(DEBIT) == sum(CREDIT)` também nos grupos `TOKEN_MINT`, `TOKEN_REDEEM`, `BIO_ROYALTY` e `DEPIN_REWARD`.
- Bioativo não admitido não paga royalty (`422 BIO_NOT_ADMITTED`); revogado não volta a ser admitido.
- Voto não pode ser repetido, só vale em proposta `OPEN` e dentro da janela; aprovação exige quórum e maioria.
- Agente nunca executa: a decisão é registrada, ancorada e limitada por política.
- Ponte expirada não liquida; a atualização para `EXPIRED` é commitada antes do erro.
- Âncora alterada quebra a verificação em cascata.

A implementação on-chain de referência está em `contracts/` (não compilada nem implantada). O mapeamento completo da lista de tecnologias solicitada, com o que é real, simulado, referência, roadmap ou deliberadamente não adotado, está em [TOKENIZACAO.md](TOKENIZACAO.md).

## 14. Cobranças, checkout e conta digital

O módulo de recebíveis vive no mesmo monólito transacional e reaproveita os mesmos tijolos do core: `transactions` como fato financeiro, ledger para dinheiro, outbox para eventos e `SettlementWorker` para liberar saldo.

```
BillingService ──┬── customers (CPF/CNPJ + máscara)
                 ├── boletos 077 (barras 44 · linha 47 · fator FEBRABAN)
                 ├── payment_links (Pix/boleto · código único · checkout /pay/:code)
                 └── statement (leitura de ledger_entries + CSV)
SubscriptionService ─── subscriptions ─── subscription_invoices
                                              │
                                     transação PENDING (source=SUBSCRIPTION)
                                              │
                                  pay ──► approve ──► outbox ──► NFC-e
                                              │
                                  SettlementWorker (D+0 Pix · D+1 boleto)
```

Invariantes:

- Toda cobrança paga cria um grupo balanceado no ledger; a taxa entra em `FEE_REVENUE` e o líquido em `MERCHANT_PAYABLE`.
- `source` da transação identifica a origem (`BOLETO`, `LINK`, `SUBSCRIPTION`) e alimenta extrato, liquidação e conciliação.
- Baixa de boleto, link e fatura é idempotente: repetição não duplica recebível (`409` quando já pago).
- Assinatura nunca cobra ciclo duplicado; `next_due_date` avança na mesma transação que gera a fatura.
- Cancelamento só alcança cobrança em aberto; pago permanece conciliado.
- Checkout público não usa token de estabelecimento e devolve apenas dados do próprio link.
- NFC-e das cobranças usa o mesmo worker fiscal do cartão: nenhuma via paralela de emissão.

O contrato detalhado, endpoints, fluxo de demonstração e caminho de produção estão em [COBRANCAS.md](COBRANCAS.md).

## 15. Open Finance, débito externo e iniciação Pix

O módulo de banco aberto usa o mesmo recebível do core: débito externo liquidado vira transação Pix interna (`source='OPEN_FINANCE'`), segue para o `SettlementWorker` e gera NFC-e pelo worker fiscal.

```
OpenFinanceService
   ├── of_consents ──► AWAITING → AUTHORISED | REJECTED | REVOKED | EXPIRED
   │                        └── escopo exigido por operação
   ├── of_accounts ──► conta mascarada (PENDING → ACTIVE | REVOKED)
   ├── of_external_debits ──► SCHEDULED → SETTLED (transação Pix + NFC-e) | CANCELED
   └── of_payments ──► PENDING → SETTLED (MERCHANT_AVAILABLE ↔ OPEN_FINANCE_CLEARING + FEE_REVENUE) | CANCELED
```

Invariantes:

- Consentimento só opera no escopo exato: `DATA_SHARING` não agenda débito nem inicia pagamento.
- Expiração é avaliada antes de qualquer operação; consentimento vencido passa a `EXPIRED` e a conta a `REVOKED`.
- Revogação cancela débitos agendados e pagamentos pendentes na mesma transação.
- Liquidação de débito é idempotente: não duplica transação, liquidação ou nota.
- Iniciação Pix só liquida com saldo disponível para valor + tarifa; o grupo é sempre balanceado.

O contrato detalhado e o caminho de produção estão em [OPEN_FINANCE.md](OPEN_FINANCE.md).

## 16. Investimentos e proventos

A carteira é um conjunto de posições do lojista sobre produtos ativos, sem saldo materializado: aplicar move `MERCHANT_AVAILABLE → INVESTMENT_PRINCIPAL`; resgatar faz o inverso; provento liquida `INVESTMENT_INCOME → MERCHANT_AVAILABLE + TAX_PAYABLE`.

```
InvestmentService
   ├── investment_products (CDB/LCI/LCA/TESOURO/FUNDO · CDI/PREFIXADO/IPCA · D0/D1/D30/MATURITY)
   ├── investment_positions (única por lojista+produto; reativa após resgate total)
   └── investment_proventos (DIVIDENDO 0% · JCP 15% · RENDIMENTO 15% ou isento)
```

Invariantes:

- Aporte exige produto ativo, mínimo do produto e saldo disponível suficiente.
- Resgate respeita a liquidez (D0/D1/D30/vencimento) e nunca excede o principal; resgate total fecha a posição.
- Provento exige posição ativa e `paymentDate >= exDate`; líquido precisa ser positivo.
- `settleDue` só processa `SCHEDULED`, é idempotente e roda na inicialização e no overview.
- O IR retido é provisionado em `TAX_PAYABLE`; não é apuração fiscal.

O contrato detalhado e o caminho de produção estão em [INVESTIMENTOS.md](INVESTIMENTOS.md).

## 17. Conta digital e transferência interna

A conta digital é um contexto próprio dentro do monólito, com tabelas separadas do token de estabelecimento:

```
bank_users ──1:1── bank_accounts ──1:N── bank_ledger
      │                  │                    ▲
      │                  │                    │ duas partidas
      └── bank_sessions  └── bank_transfers ──┘
                                 │
                                 └── bank_audit / outbox / receipt
```

- **Cadastro**: `PENDING` até aprovação; a conta só nasce quando o usuário fica `ACTIVE`. O primeiro admin em demo é automático; em produção exige `BANK_BOOTSTRAP_TOKEN`.
- **Número de conta**: agência `0001`, base sequencial de 7 dígitos + dígito verificador, gerada com `UPDATE ... RETURNING` para não colidir sob concorrência.
- **Transferência**: uma transação `BEGIN IMMEDIATE` com débito condicionado, crédito, transferência, duas partidas e evento. Limites por operação (R$ 50 mil) e por dia móvel (R$ 100 mil).
- **Idempotência**: índice único por conta de origem + chave; hash do conteúdo detecta reuso divergente.
- **Extrato**: lê `bank_ledger` e devolve `balance_after_cents` por lançamento; o saldo da conta é redundante e conferível pelo razão.
- **Comprovante**: partes mascaradas, partidas e hash de integridade.
- **Score**: regra determinística auditável com fatores expostos; não é bureau.

Detalhes e API em [BANCO.md](BANCO.md).

## 18. Edge Cloudflare

O Worker em `cloudflare/` é um espelho de conta digital com contrato `/v1/bank/*` idêntico ao núcleo. A diferença central é o D1, que não oferece transação interativa:

```
INSERT bank_transfers (status=POSTED)
        │
        ├── trigger AFTER INSERT
        │     ├── UPDATE debit  WHERE saldo >= valor AND ativo   (ou ABORT)
        │     ├── UPDATE credit WHERE ativo                       (ou ABORT)
        │     └── INSERT bank_ledger -D / -C
        │
        └── resposta: transferência + saldo + hash
```

- **D1** guarda o mesmo modelo (`bank_users`, `bank_accounts`, `bank_sessions`, `bank_transfers`, `bank_ledger`, `bank_audit`, `bank_sequences`) e views `contas`/`transacoes`.
- **KV** faz rate limit; **R2** guarda comprovantes; **Queues** entrega eventos com DLQ e deduplicação em `edge_events`; **Workers AI** gera insights com fallback heurístico.
- **Sessão**: PBKDF2 no lugar de scrypt (limite do runtime), cookie HttpOnly, CSRF exato e revogação.
- **Atomicidade**: toda a regra de saldo vive no trigger. Lógica de saldo fora dele reintroduz a janela de inconsistência que o desenho elimina.
- **Escopo**: não fala com PSP, SPI, SEFAZ ou Open Finance. Quem integra trilhos externos é o núcleo Node.

O Worker roda localmente e ainda não foi publicado. Ver [CLOUDFLARE.md](CLOUDFLARE.md).

## 19. Checkout mTLS e ledger unificado

O banco sobe dois listeners deliberadamente separados:

```
:8080 HTTP  ── API pública, dashboard, /v1/transactions com HMAC
:8443 HTTPS ── mutual-TLS, /v1/secure-checkout para maquininhas
```

- O listener mTLS usa `requestCert` e `rejectUnauthorized`: sem certificado assinado pela CA do banco, a conexão morre antes da aplicação.
- O `CN` do certificado é o serial do terminal; o fingerprint SHA-256 é comparado em tempo constante com `terminals.cert_fingerprint`.
- Depois da autenticação, a venda entra no mesmo `TransactionService`: risco, roteamento, autorização, ledger, liquidação, outbox e NFC-e.
- Idempotência usa a mesma tabela do `/v1/transactions`, com escopo `mtls:<terminal>`.
- O CN também é conferido no `/v1/transactions` quando a conexão é TLS, para impedir usar o certificado de um terminal com o ID de outro.

O schema `db/schema.ledger.postgres.sql` adiciona o **ledger unificado** em um namespace próprio (`ledger_core`), com contas UUID, transações `NUMERIC` e documentos fiscais `JSONB` indexados por GIN. Ele **não substitui** `public.accounts`/`public.transactions`: a view `ledger_core.transactions_bridge` concilia o modelo operacional em centavos com o contrato unificado.

Detalhes em [MTLS.md](MTLS.md).

## 20. Não objetivos desta entrega

- Não é uma instituição financeira licenciada nem substitui homologação PCI/bandeiras.
- Não conecta a SEFAZ, PSP ou bandeiras reais.
- Não implementa Drex ou multicloud fisicamente; o Open Finance roda em modo interno, sem diretório de participantes, DICT/SPI ou adesão regulatória.
- Não implanta contratos, não ancora em rede pública e não movimenta trilhos cripto reais.
- Não usa biometria, DNA, íris ou agente financeiro irrestrito.
