# Crédito, parcelas e PDV/NFC-e

O xPartner Bank concede **antecipação de recebível** e **empréstimo pessoal** com capital próprio da tesouraria. Não é uma tela de simulação: o valor é debitado de uma conta real da tesouraria, creditado na conta do titular, e o contrato nasce com agenda de parcelas, taxa congelada e baixa contábil no mesmo livro-razão usado por Pix, RSFN e transferências.

O mesmo módulo fecha o ciclo comercial com um **PDV de demonstração**: a venda é autorizada pelo adquirente simulado, a NFC-e é emitida de forma síncrona e o valor líquido é liquidado na conta do titular pela tesouraria.

> **Escopo honesto.** Crédito aqui é operação interna lastreada em capital próprio, **não registrada no SCR/BACEN** e não ofertada ao público. O PDV só funciona com `DEMO_MODE=true`; a SEFAZ continua sendo mock determinístico. Operar crédito de terceiros exige licença de SCD/IP ou parceria com instituição autorizada — ver [GO_LIVE.md](GO_LIVE.md).

## 1. Produtos

| Produto | Prazo | Parcelas | Liberação |
|---|---|---|---|
| `ANTECIPACAO` | 30 dias | 1 | valor solicitado menos o deságio do período |
| `EMPRESTIMO` | 1 a 12 meses | 1 a 12 | principal integral; parcelas fixas pela tabela Price |

Limites: **R$ 100,00** mínimo, **R$ 50.000,00** por contrato e o menor valor entre o limite sugerido pelo score e o máximo global. O limite disponível é:

```
limite_sugerido = min(limite_diário, round((saldo × 0,50 + volume_90d × 0,05) / 100) × 100)
limite_disponível = min(limite_sugerido, R$ 50.000,00) − principal_em_aberto
```

O score é o mesmo indicador interno da conta (0–1000, determinístico, sem bureau). A faixa define a taxa; a taxa é **gravada no contrato** e não muda depois.

| Faixa | Score | Antecipação (30 dias) | Empréstimo (a.m.) |
|---|---|---|---|
| `MUITO_BAIXO` | ≥ 850 | 1,49% | 2,49% |
| `BAIXO` | ≥ 700 | 1,79% | 2,99% |
| `MEDIO` | ≥ 500 | 2,29% | 3,49% |
| `ALTO` | ≥ 300 | 2,99% | 4,29% |
| `MUITO_ALTO` | < 300 | 3,99% | 5,49% |

## 2. Matemática

### Antecipação

O valor solicitado é o **valor de face**; o cliente recebe o principal e paga uma parcela única em 30 dias:

```
juros   = round(face × i / (1 + i))
principal = face − juros
parcela = face, vencimento em 30 dias
```

Exemplo com face de R$ 5.000,00 a 3,99% no período: juros de **R$ 191,85**, principal liberado de **R$ 4.808,15** e uma parcela de **R$ 5.000,00**.

### Empréstimo (Price)

```
parcela = P × i / (1 − (1 + i)^−n)
```

Cada parcela é arredondada ao centavo; a última absorve a diferença para que a soma dos principais seja exatamente `P`. Exemplo de R$ 3.000,00 em 6x a 5,49% a.m.: 6 parcelas, total de **R$ 3.602,07**, primeira parcela de **R$ 600,35**.

### Liquidação antecipada

```
juros_corridos = round(principal_aberto × taxa × dias_corridos / (30 × 10000))
payoff = min(total_contratado_em_aberto, principal_aberto + juros_corridos)
desconto = total_em_aberto − payoff
```

`dias_corridos` conta desde o último pagamento (ou da contratação) e é limitado a 30. Juros futuros são descontados; o contrato vira `PAID` com `settled_early = true`, todas as parcelas são baixadas e o saldo devedor zera. No exemplo acima, após pagar a 1ª parcela, a liquidação saiu por **R$ 2.564,35** com desconto de **R$ 437,37**.

## 3. Fluxo contábil

Todo dinheiro passa pelo ledger de dupla entrada. A tesouraria é a contraparte de funding e não pode ficar negativa.

| Evento | Débito | Crédito | `channel` |
|---|---|---|---|
| Desembolso | Tesouraria | Conta do cliente | `CREDIT` |
| Pagamento de parcela | Conta do cliente | Tesouraria | `CREDIT_PAYMENT` |
| Liquidação antecipada | Conta do cliente | Tesouraria | `CREDIT_PAYMENT` |
| Venda no PDV (líquido) | Tesouraria | Conta do cliente | `PDV` |

No extrato: `Crédito liberado`, `Parcela de crédito` e `Liquidação de venda NFC-e`. O comprovante de cada transferência continua disponível em `GET /v1/bank/transfers/:id`.

A contratação, o pagamento e a liquidação rodam em uma única transação SQL (`BEGIN IMMEDIATE`). Se o crédito na conta falhar, o contrato não existe; se o pagamento falhar, a parcela continua aberta. Não há estado intermediário.

## 4. Idempotência

`POST /v1/bank/credit/contracts` aceita `idempotencyKey` no corpo ou no header `Idempotency-Key` (mínimo 8 caracteres). A chave é única por titular:

- mesma chave + mesmo payload → devolve o contrato original com `HTTP 200` e `x-idempotent-replayed: true`;
- mesma chave + payload diferente → `CONFLICT`;
- sem chave → cada chamada cria um contrato novo.

O hash do payload é `SHA-256(produto|valor|parcelas)`. Retry de rede não duplica desembolso.

## 5. PDV e NFC-e

`POST /v1/bank/pdv/sales` executa, em sequência:

1. exige `DEMO_MODE` (produção retorna `DEMO_ONLY`);
2. valida meio (`CREDIT`, `DEBIT`, `PIX`, `VOUCHER`), valor entre **R$ 1,00 e R$ 100.000,00** e a soma dos itens;
3. autoriza a venda pelo pipeline de adquirência com o estabelecimento demo (`createSale`), incluindo roteamento, taxa e antifraude;
4. emite a **NFC-e de forma síncrona** (`FiscalWorker.emitForTransaction`), com chave de 44 dígitos, XML assinado, QR Code e contingência quando a SEFAZ mock rejeita;
5. credita o **líquido** (`valor − taxa`) na conta do titular pela tesouraria, canal `PDV`, e grava a venda em `bank_pdv_sales` com vínculo à transferência e ao documento fiscal.

`GET /v1/bank/pdv/sales/:id/xml` baixa o XML como anexo (`application/xml`); `GET /v1/bank/pdv/sales/:id/fiscal` devolve XML, DANFE em texto e ESC/POS. As vendas e os contratos têm exportação CSV com BOM UTF-8 e separador `;`.

> Em produção, o líquido do PDV vem do arranjo de pagamento (D+1), não da tesouraria. O disclaimer acompanha cada resposta da API e a interface.

## 6. API

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/v1/bank/credit/line` | Score, faixa, limite sugerido, principal aberto e limite disponível |
| `POST` | `/v1/bank/credit/quote` | Simulação de antecipação ou empréstimo com agenda completa |
| `GET` | `/v1/bank/credit/contracts` | Contratos do titular, agenda e resumo da linha |
| `GET` | `/v1/bank/credit/contracts.csv` | Exportação CSV dos contratos |
| `POST` | `/v1/bank/credit/contracts` | Contratação com desembolso da tesouraria (idempotente) |
| `GET` | `/v1/bank/credit/contracts/:id` | Contrato e agenda completos |
| `POST` | `/v1/bank/credit/contracts/:id/installments/:number/pay` | Paga uma parcela |
| `POST` | `/v1/bank/credit/contracts/:id/settle` | Liquida antecipadamente com desconto de juros futuros |
| `GET` | `/v1/bank/pdv/sales?limit=` | Vendas do PDV com fiscal e liquidação |
| `GET` | `/v1/bank/pdv/sales.csv` | Exportação CSV das vendas |
| `POST` | `/v1/bank/pdv/sales` | Venda presencial demo com NFC-e síncrona |
| `GET` | `/v1/bank/pdv/sales/:id/fiscal` | XML, DANFE e ESC/POS da venda |
| `GET` | `/v1/bank/pdv/sales/:id/xml` | Download do XML da NFC-e |

Todas exigem sessão do titular. Escritas exigem CSRF quando autenticadas por cookie e senha já trocada. Um contrato de outro titular responde `404`, sem revelar existência.

Exemplo:

```bash
curl -s -X POST localhost:8080/v1/bank/credit/quote \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"product":"EMPRESTIMO","amountCents":300000,"installments":6}'

curl -s -X POST localhost:8080/v1/bank/credit/contracts \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: credito-2026-11-01-001' \
  -d '{"product":"EMPRESTIMO","amountCents":300000,"installments":6}'
```

## 7. Interface

- `/bank` → aba **Crédito**: linha disponível, simulação com agenda, contratação, lista de contratos com agenda, pagamento de parcela, liquidação antecipada e exportação CSV.
- `/core` → console operacional com KPIs de crédito, contratos e PDV/NFC-e do estabelecimento demo, incluindo venda, XML e CSV.
- O extrato marca cada lançamento com `channel` e rótulo próprios.

## 8. Testes

`tests/bank-credit.test.ts` cobre: score e faixas, matemática da antecipação e da Price, limites mínimo/máximo e de crédito, contratação idempotente com replay, desembolso na tesouraria, extrato e CSV, pagamento de parcela, liquidação antecipada com desconto, venda no PDV com NFC-e autorizada, XML/DANFE/ESC-POS, CSV, validação de itens e isolamento entre titulares.

```bash
npm test
```

## 9. O que é real e o que falta

| Item | Situação |
|---|---|
| Linha de crédito, taxa por score e agenda | real e persistida |
| Desembolso, parcela e liquidação no ledger | reais, atômicos e idempotentes |
| Contrato com taxa congelada e CSV | real |
| Antecipação com deságio | real, com juros de 30 dias |
| Liquidação antecipada | real, com desconto de juros futuros |
| PDV com autorização, NFC-e e liquidação | demo rotulado; SEFAZ mock |
| Registro no SCR/BACEN | **não existe** — exige instituição autorizada |
| Mora, juros de atraso e renegociação | **não implementados** |
| Cobrança, KYC de crédito e bureau | **não integrados** |
| Liquidação do PDV pelo arranjo | **não conectada** — hoje sai da tesouraria |

O schema PostgreSQL equivalente está em [db/schema.credit.postgres.sql](../db/schema.credit.postgres.sql). O contrato da conta digital está em [BANCO.md](BANCO.md) e o caminho para produção em [GO_LIVE.md](GO_LIVE.md).
