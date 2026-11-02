# Open Finance · xPartner Bank

Esta camada conecta o estabelecimento às contas que o cliente mantém em outras instituições: consentimento do titular, conta vinculada mascarada, **débito externo agendado** e **iniciação de pagamento Pix**. O dinheiro continua passando pelo mesmo ledger de dupla entrada, pelo mesmo pipeline de recebíveis e pela mesma emissão de NFC-e do core — não existe uma via paralela de conciliação.

O Open Finance desta entrega é **interno e determinístico**. Ele modela o ciclo de vida completo (consentimento, autorização, expiração, revogação, liquidação e cancelamento) e é exercitável pelo aplicativo e pela API, mas não conversa com o diretório de participantes, com o DICT ou com o SPI reais. O caminho de produção está descrito na seção 9.

## 1. Mapa funcional

| Capacidade | Interface | Serviço | Persistência |
|---|---|---|---|
| Consentimentos e contas vinculadas | `/app#openfinance` | `OpenFinanceService` | `of_consents`, `of_accounts` |
| Débito externo agendado | `/app#openfinance` | `OpenFinanceService` | `of_external_debits` |
| Iniciação de pagamento Pix | `/app#openfinance` | `OpenFinanceService` | `of_payments` |
| Recebível do débito externo | pipeline Pix | `settleReceivable` + `SettlementWorker` | `transactions`, `settlements` |
| Nota fiscal do recebimento | worker fiscal | `FiscalWorker` | `fiscal_documents` |
| KPIs consolidados | `/app#overview` e `/v1/open-finance/overview` | `OpenFinanceService.overview` | consultas agregadas |

## 2. Consentimento

Tipos (`kind`) e escopos padrão:

| Tipo | Escopos padrão | Uso |
|---|---|---|
| `DATA_SHARING` | `accounts:read`, `balances:read`, `transactions:read` | compartilhamento de dados; **não** movimenta dinheiro |
| `EXTERNAL_DEBIT` | `accounts:read`, `payments:debit` | agendamento de débito na conta externa |
| `PAYMENT_INITIATION` | `accounts:read`, `payments:initiate` | saída Pix a partir do saldo do estabelecimento |

Ciclo de vida:

```
create ──► AWAITING_AUTHORISATION ──► AUTHORISED ──► REVOKED
                    │                      │
                    ├──► REJECTED          └──► EXPIRED (validade vencida)
                    └──► EXPIRED
```

- A criação grava a conta como `PENDING` e o consentimento como `AWAITING_AUTHORISATION` na mesma transação SQL.
- `expiresInDays` fica entre 1 e 365 (padrão 90). O vencimento é avaliado de forma preguiçosa antes de listar ou operar; consentimento autorizado que vence também passa a `EXPIRED`.
- Autorização é idempotente: repetir em consentimento já `AUTHORISED` devolve o estado atual. Autorizar fora da validade retorna `409 CONSENT_EXPIRED`.
- Recusa (`REJECTED`) e revogação (`REVOKED`) encerram a conta vinculada.
- Revogar também **cancela** débitos `SCHEDULED` e pagamentos `PENDING` daquele consentimento, impedindo movimentação posterior.
- O escopo é exigido por operação: um consentimento de compartilhamento de dados não agenda débito nem inicia pagamento (`409 CONSENT_SCOPE_MISMATCH`).

## 3. Conta vinculada

- Agência e número são normalizados para dígitos; o número é persistido apenas mascarado no formato `1234/****9012`.
- O documento do titular é validado (CPF/CNPJ) e devolvido somente mascarado (`529.***.***-25`).
- Estados: `PENDING` (aguardando autorização), `ACTIVE` (operável) e `REVOKED` (recusada, revogada ou expirada).
- O saldo informado (`balanceCents`) é um retrato do momento da autorização; não é usado para autorizar operações. Ele serve para exibição e conciliação.
- Toda operação exige conta `ACTIVE`; caso contrário retorna `409 CONSENT_ACCOUNT_UNAVAILABLE`.

## 4. Débito externo

- Agendado com valor, vencimento (`YYYY-MM-DD`, padrão hoje) e descrição.
- Estados: `SCHEDULED → SETTLED`, com saídas para `CANCELED` e `FAILED`.
- A liquidação cria uma transação Pix interna com `source='OPEN_FINANCE'`, aprova o recebível, agenda a liquidação D+0 e publica `transactions.approved` — a NFC-e sai pelo worker fiscal como qualquer outra venda.
- Liquidação é idempotente: repetir em débito `SETTLED` devolve o mesmo estado sem duplicar recebível, liquidação ou nota.
- Débito cancelado não liquida (`409 DEBIT_CLOSED`); débito pago não é cancelado (`409 DEBIT_SETTLED`).
- Em produção, a confirmação do débito viria do SPI/PSP; aqui a rota de liquidação é restrita a `DEMO_MODE=true`.

## 5. Iniciação de pagamento Pix

- Consentimento `PAYMENT_INITIATION` autorizado + chave Pix + valor.
- Tarifa de iniciação de **50 bps** sobre o valor, arredondada em centavos; o total debitado é `valor + tarifa`.
- Estados: `PENDING → SETTLED`, com `CANCELED`.
- A liquidação exige saldo disponível (`MERCHANT_AVAILABLE`) suficiente para o total; caso contrário `422 INSUFFICIENT_FUNDS`.
- O `endToEndId` é gerado no momento da liquidação no formato `E<8 dígitos><timestamp>`.
- Lançamento contábil (partidas dobradas):

| Conta | Direção | Valor |
|---|---|---|
| `MERCHANT_AVAILABLE` (lojista) | débito | valor |
| `OPEN_FINANCE_CLEARING` (plataforma) | crédito | valor |
| `MERCHANT_AVAILABLE` (lojista) | débito | tarifa |
| `FEE_REVENUE` (plataforma) | crédito | tarifa |

- Repetir a liquidação em pagamento `SETTLED` devolve o estado atual (idempotente); pagamento cancelado não liquida (`409 PAYMENT_CLOSED`).

## 6. Ledger

Contas usadas por esta camada:

| Conta | Natureza | Quando move |
|---|---|---|
| `OPEN_FINANCE_CLEARING` | ativo/clearing da plataforma | crédito na liquidação da iniciação Pix |
| `MERCHANT_AVAILABLE` | passivo disponível do lojista | débito no pagamento e na tarifa; crédito no recebível do débito externo |

O recebível do débito externo reutiliza `ACQUIRER_RECEIVABLE → MERCHANT_PAYABLE` e a liquidação D+0 do pipeline Pix. Nenhum grupo é gravado sem `sum(DEBIT) == sum(CREDIT)`.

## 7. API

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/v1/open-finance/overview` | KPIs + consentimentos, contas, débitos e pagamentos |
| `POST` | `/v1/open-finance/consents` | Cria consentimento com conta vinculada |
| `POST` | `/v1/open-finance/consents/:id/authorize` | Autoriza consentimento pendente |
| `POST` | `/v1/open-finance/consents/:id/reject` | Recusa consentimento pendente |
| `POST` | `/v1/open-finance/consents/:id/revoke` | Revoga consentimento e encerra a conta |
| `POST` | `/v1/open-finance/debits` | Agenda débito externo |
| `POST` | `/v1/open-finance/debits/:id/settle` | Liquida débito (demo) |
| `POST` | `/v1/open-finance/debits/:id/cancel` | Cancela débito agendado |
| `POST` | `/v1/open-finance/payments` | Inicia pagamento Pix |
| `POST` | `/v1/open-finance/payments/:id/settle` | Liquida pagamento com tarifa (demo) |
| `POST` | `/v1/open-finance/payments/:id/cancel` | Cancela pagamento pendente |

Exemplo de consentimento:

```bash
TOKEN=$(curl -s -X POST localhost:8080/v1/auth/demo | node -pe "JSON.parse(require('fs').readFileSync(0)).token")

curl -s -X POST localhost:8080/v1/open-finance/consents \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "provider": "Banco do Brasil S.A.",
    "providerCode": "BB",
    "kind": "EXTERNAL_DEBIT",
    "account": { "type": "CHECKING", "branch": "1234", "number": "56789012", "balanceCents": 1849000 }
  }'
```

A resposta traz `id`, `status: "AWAITING_AUTHORISATION"` e a conta mascarada. Em seguida `POST /v1/open-finance/consents/:id/authorize` habilita a conta (`ACTIVE`).

## 8. Demonstração

Com `DEMO_MODE=true`, o seed cria quatro consentimentos no estabelecimento *Padaria Pão de Ouro*:

| Instituição | Escopo | Situação | Movimentação |
|---|---|---|---|
| Banco do Brasil | débito externo | autorizado | R$ 89,90 liquidado + R$ 125,00 agendado |
| Itaú Unibanco | iniciação Pix | autorizado | R$ 120,00 liquidado (tarifa R$ 0,60) |
| Nu Pagamentos | compartilhamento | aguardando | — |
| Santander | débito externo | recusado | — |

No app, `Banco aberto → Open Finance` permite autorizar/recusar/revogar consentimentos, agendar/cancelar/liquidar débitos e iniciar/cancelar/liquidar pagamentos. A liquidação exige `DEMO_MODE=true` porque simula a confirmação da ponta externa.

## 9. Caminho de produção

1. **Participação no Open Finance**: adesão ao regulatório do Banco Central, certificados ICP-Brasil, mTLS com o diretório e registro de consentimentos no ecossistema.
2. **Papel de ITP** para iniciação de pagamento; o débito externo passa a ser uma jornada de pagamento autorizada pelo cliente, não um agendamento interno.
3. **DICT/SPI** para resolução de chaves Pix e liquidação real; hoje o `endToEndId` é gerado localmente.
4. **Webhooks e reconciliação** por `consentId`/`paymentId`, com assinatura, idempotência durável e conciliação diária contra o extrato do PSP.
5. **Expiração e revogação propagadas** por evento, não só de forma preguiçosa na leitura.
6. **Armazenamento de PII** do titular com criptografia em repouso, retenção mínima e trilha LGPD; nesta entrega o documento é apenas validado e mascarado.

## 10. Limites desta entrega

- Não há conexão com instituições reais, diretório de participantes, DICT, SPI ou Drex.
- O saldo da conta externa é informativo e não é consultado em tempo real.
- Autorização é uma chamada local; não há redirecionamento do titular nem jornada de consentimento no app do banco de origem.
- Liquidação de débito e pagamento é restrita ao modo demo.
- A tarifa de 50 bps é uma política local, configurável no código, sem negociação por contrato.
