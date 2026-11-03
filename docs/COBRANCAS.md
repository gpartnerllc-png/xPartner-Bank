# Cobranças, checkout e conta digital · xPartner Bank

Esta camada transforma o core de adquirência em uma operação completa de recebíveis: cadastro de clientes, boleto registrado com padrão FEBRABAN, links de pagamento com checkout público, assinaturas recorrentes, extrato contábil, liquidações e conciliação com as notas fiscais emitidas pelo mesmo pipeline de eventos.

Tudo roda sobre as mesmas garantias do core: centavos inteiros, ledger de dupla entrada, outbox transacional, idempotência e auditoria. Não há tabela paralela de saldo nem cálculo de dinheiro em ponto flutuante.

## 1. Mapa funcional

| Capacidade | Interface | Serviço | Persistência |
|---|---|---|---|
| Clientes PF/PJ com CPF/CNPJ validado e mascarado | `/app#customers` | `CustomerService` | `customers` |
| Boleto registrado 077 (44/47 posições) | `/app#charges` | `BillingService` | `boletos` |
| Link de pagamento Pix/boleto | `/app#charges` | `BillingService` | `payment_links` |
| Checkout público do link | `/pay/:code` | rotas públicas | `payment_links` |
| Assinaturas e faturas recorrentes | `/app#subscriptions` | `SubscriptionService` | `subscriptions`, `subscription_invoices` |
| Extrato contábil e CSV | `/app#statement` | `BillingService.statement` | `ledger_entries`, `transactions` |
| Liquidações D+0/D+1 | `/app#settlements` | `SettlementWorker` | `settlements` |
| Notas fiscais das cobranças | `/app#fiscal` | `FiscalWorker` | `fiscal_documents` |
| KPIs consolidados | `/app#overview` | `buildOverview` + `billing.overview` | consultas agregadas |

O aplicativo é servido em `GET /app`; o checkout público em `GET /pay/:code`. Ambos são HTML single-file, sem build e sem dependências de CDN.

## 2. Clientes

- Validação de CPF/CNPJ com dígitos verificadores; documento inválido retorna `422`.
- Unicidade por `(merchant_id, document)`; duplicata retorna `409`.
- Dados sensíveis são expostos apenas mascarados (`529.***.***-25`, `11.***.***/****-81`).
- E-mail, telefone, cidade e UF são normalizados; UF em duas letras maiúsculas.
- `PATCH /v1/customers/:id` permite atualização cadastral sem alterar o documento; `status` aceita `ACTIVE`/`BLOCKED` (bloqueio impede novas cobranças).
- `DELETE /v1/customers/:id` remove o cliente da base ativa: apaga e-mail, telefone e cidade (LGPD), mantém documento e histórico fiscal (boletos, assinaturas, NFC-e) e retorna `{ customer, preserved: { boletos, subscriptions } }`. Reaparece como `Cliente removido · <sufixo>`. Cadastrar o mesmo documento reativa o registro.

## 3. Boleto registrado

Parâmetros do arranjo de demonstração (banco `077`):

| Campo | Regra |
|---|---|
| Código de barras | 44 dígitos, DV geral mod-11 |
| Linha digitável | 47 dígitos, três DVs de campo mod-10 |
| Fator de vencimento | base `2025-02-22 = 1000`; janela 1000–9999 |
| Valor | inteiro em centavos, até `9.999.999.999` |
| Campo livre | banco (3) + sufixo do estabelecimento (9) + nosso número (11) + carteira (2) |

- O nosso número é sequencial por estabelecimento e atribuído na mesma transação SQL do boleto.
- A criação grava `transactions` pendente com `source='BOLETO'` e agenda liquidação **D+1**.
- `GET /v1/boletos/:reference` aceita id, nosso número, código de barras ou linha digitável (com ou sem formatação).
- Baixa (`POST /v1/boletos/:reference/pay`) aprova a transação, registra o recebível no ledger e publica `transactions.approved`; a NFC-e é emitida pelo worker fiscal.
- Cancelamento só é permitido em boleto `OPEN`/`OVERDUE`; após pago, retorna conflito.

## 4. Links e checkout público

- Código alfanumérico de 10 posições, único, gerado com verificação de colisão.
- `kind=PIX` cria cobrança Pix com BR Code EMV; `kind=BOLETO` cria boleto com vencimento.
- A transação pendente recebe `source='LINK'`.
- `GET /v1/public/links/:code` devolve merchant, valor, descrição, status e o payload de pagamento (Pix ou boleto) sem exigir token — apenas dados públicos do link.
- `POST /v1/public/links/:code/pay` existe somente em `DEMO_MODE=true`; simula a confirmação do pagador.
- O checkout `/pay/:code` faz polling do status a cada 8 s enquanto o link está ativo e trata os estados `PAID`, `CANCELED`/expirado e erro.
- Link pago ou cancelado não aceita novo pagamento (`409`).

## 5. Assinaturas

- Periodicidade `WEEKLY`, `MONTHLY`, `QUARTERLY` ou `YEARLY`, com avanço de calendário correto em fim de mês e ano bissexto.
- Meio de cobrança `PIX` (D+0) ou `BOLETO` (D+1).
- A primeira fatura é gerada na criação; cada fatura tem transação pendente com `source='SUBSCRIPTION'`.
- `runDue` gera faturas vencidas para assinaturas ativas, sem duplicar ciclo.
- `POST /v1/subscription-invoices/:id/pay` baixa a fatura e libera o recebível; pagamento repetido retorna `409 INVOICE_ALREADY_PAID`.
- `renew` gera nova cobrança para a fatura; `pause`/`resume`/`cancel` controlam o ciclo.
- A renovação de assinatura Pix produz novo `txid`; não há reutilização de BR Code.

## 6. Extrato e conciliação

O extrato é uma leitura do ledger, não um saldo materializado:

- `GET /v1/statement?from&to` retorna lançamentos com data, descrição, `source`, conta e direção.
- `GET /v1/statement.csv` devolve CSV com BOM UTF-8, cabeçalho citado e separador `;` para abrir corretamente no Excel brasileiro.
- Totais: disponível (`MERCHANT_AVAILABLE`), a receber (`MERCHANT_PAYABLE`), entradas, liquidado e saídas.
- Cada pagamento de boleto, link ou fatura aparece como grupo balanceado (`DEBIT` = `CREDIT`), com a taxa reconhecida em `FEE_REVENUE`.

`source` distingue a origem do recebível:

| Origem | Significado |
|---|---|
| `BOLETO` | boleto registrado pago |
| `LINK` | link de pagamento pago |
| `SUBSCRIPTION` | fatura de assinatura paga |
| `PIX` / vazio | venda ou cobrança Pix direta |

## 7. Liquidação e antecipação

- Pix e link Pix: D+0.
- Boleto, link de boleto e fatura de assinatura em boleto: D+1.
- `SettlementWorker.settleDue()` move `MERCHANT_PAYABLE → MERCHANT_AVAILABLE` sempre em dupla entrada e publica `settlement.paid`.
- A antecipação troca o recebível por disponível cobrando taxa dinâmica; a taxa é receita (`ANTICIPATION_REVENUE`) no mesmo grupo.

## 8. API

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/v1/customers` | Lista clientes do estabelecimento |
| `POST` | `/v1/customers` | Cria cliente PF/PJ |
| `GET/PATCH` | `/v1/customers/:id` | Consulta/atualiza/bloqueia cliente |
| `DELETE` | `/v1/customers/:id` | Remove da base ativa com histórico preservado |
| `GET` | `/v1/boletos` | Lista boletos (filtro por status) |
| `POST` | `/v1/boletos` | Emite boleto registrado |
| `GET` | `/v1/boletos/:reference` | Consulta por id, nosso número, barras ou linha |
| `POST` | `/v1/boletos/:reference/pay` | Baixa o boleto (demo) |
| `POST` | `/v1/boletos/:reference/cancel` | Cancela boleto em aberto |
| `GET` | `/v1/payment-links` | Lista links |
| `POST` | `/v1/payment-links` | Cria link Pix ou boleto |
| `GET` | `/v1/payment-links/:code` | Detalhe do link |
| `POST` | `/v1/payment-links/:code/pay` | Baixa o link (demo) |
| `POST` | `/v1/payment-links/:code/cancel` | Cancela link ativo |
| `GET` | `/v1/public/links/:code` | Checkout público (sem token) |
| `POST` | `/v1/public/links/:code/pay` | Simula pagamento (somente demo) |
| `GET/POST` | `/v1/subscriptions` | Lista/cria assinaturas |
| `GET` | `/v1/subscriptions/:id` | Detalhe com faturas |
| `POST` | `/v1/subscriptions/:id/pause` | Pausa o ciclo |
| `POST` | `/v1/subscriptions/:id/resume` | Retoma o ciclo |
| `POST` | `/v1/subscriptions/:id/cancel` | Encerra a assinatura |
| `GET` | `/v1/subscription-invoices` | Lista faturas |
| `GET` | `/v1/subscription-invoices/:id` | Detalhe da fatura |
| `POST` | `/v1/subscription-invoices/:id/pay` | Baixa a fatura |
| `POST` | `/v1/subscription-invoices/:id/renew` | Gera nova cobrança |
| `GET` | `/v1/statement` | Extrato contábil |
| `GET` | `/v1/statement.csv` | Exportação CSV |
| `GET` | `/v1/app/overview` | Payload consolidado do aplicativo |
| `GET` | `/v1/fiscal/recent` | Notas fiscais recentes |

## 9. Fluxo de demonstração ponta a ponta

1. `GET /app` autentica via `/v1/demo/bootstrap` e carrega os dados reais do estabelecimento.
2. Em **Cobranças**, emita um boleto ou crie um link; o modal mostra linha digitável ou BR Code.
3. No link, abra `/pay/<code>` em outra aba e use **Simular pagamento (demo)**.
4. O app reflete `PAGO`, o extrato ganha o grupo contábil e a NFC-e aparece em **Notas fiscais**.
5. Em **Assinaturas**, crie um plano, baixe a fatura, pause e retome.
6. Em **Liquidações**, o recebível muda de `PENDENTE` para pago conforme a regra D+0/D+1.

## 10. Segurança e LGPD

- Rotas privadas exigem token com escopo `demo:read`/`demo:write` e `merchantId` no claim; toda consulta é filtrada por estabelecimento.
- O checkout público expõe apenas o necessário para o pagamento; não devolve documento completo do pagador nem dados de outros links.
- Documentos são armazenados integralmente para validação e conciliação, mas somente mascarados na saída da API e da UI.
- O modo demo é explicitamente sinalizado na interface e `POST /pay` público é bloqueado fora de `DEMO_MODE`.
- O CSV herda o escopo do token e o filtro de período; nenhuma exportação cruza estabelecimentos.

## 11. Da referência à produção

| Camada | Hoje | Produção |
|---|---|---|
| Boleto | Arranjo 077 de demonstração | Registro em banco/PSP real, API de cobrança e baixa automática |
| Pix | BR Code e ciclo interno | PSP/RSFN/SPI com webhook assinado e devolução |
| Links | Checkout próprio | Página hospedada com antifraude, 3DS quando aplicável e captura real |
| Assinaturas | Motor de ciclos local | Cobrança recorrente com retentativa, dunning e cartão tokenizado |
| Extrato | Ledger SQLite | Ledger PostgreSQL com partição por data e trilha de auditoria imutável |
| NFC-e | Mock determinístico | SEFAZ estadual, certificado A1 em HSM/KMS e contingência offline |

O desenho mantém os mesmos contratos de entrada/saída ao trocar o provedor: o domínio não conhece o PSP, apenas o resultado da cobrança.
