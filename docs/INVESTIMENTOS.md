# Investimentos e proventos · xPartner Bank

A carteira do estabelecimento aplica o saldo disponível em produtos de renda fixa (CDB, LCI, LCA, Tesouro e fundos), com liquidez por produto, resgate parcial e **proventos** (dividendo, JCP e rendimento) com retenção de IR na fonte. Todo movimento usa a mesma conta `MERCHANT_AVAILABLE` e o mesmo ledger de dupla entrada do core: aplicar é uma transferência entre contas do lojista, não um saldo paralelo.

Esta camada é **funcional e determinística**, inspirada na experiência de carteira e proventos de BTG/B3, mas não está conectada a corretora, custodiante, B3 ou Receita Federal. O caminho de produção está na seção 8.

## 1. Mapa funcional

| Capacidade | Interface | Serviço | Persistência |
|---|---|---|---|
| Catálogo de produtos | `/app#investments` | `InvestmentService` | `investment_products` |
| Aporte com débito do disponível | `/app#investments` | `InvestmentService.invest` | `investment_positions` |
| Resgate com liquidez | `/app#investments` | `InvestmentService.redeem` | `investment_positions` |
| Proventos com IR | `/app#investments` | `InvestmentService.createProvento` | `investment_proventos` |
| Liquidação de proventos vencidos | worker de liquidação | `InvestmentService.settleDue` | `investment_proventos` |
| KPIs consolidados | `/app#overview` e `/v1/investments/overview` | `InvestmentService.overview` | consultas agregadas |

## 2. Produtos

| Campo | Valores | Regra |
|---|---|---|
| `kind` | `CDB`, `LCI`, `LCA`, `TESOURO`, `FUNDO` | tipo do produto |
| `indexer` | `CDI`, `PREFIXADO`, `IPCA` | indexador exibido ao lojista |
| `rateBps` | 0 a 50.000 | taxa em basis points; a UI mostra `rateBps / 100` como percentual |
| `liquidity` | `D0`, `D1`, `D30`, `MATURITY` | prazo mínimo para resgate |
| `minCents` | inteiro positivo | aporte mínimo |
| `maturityDate` | `YYYY-MM-DD` | obrigatório quando `liquidity = MATURITY` |
| `taxExempt` | booleano | isenção de IR sobre rendimento (ex.: LCI/LCA) |
| `status` | `ACTIVE`, `CLOSED` | apenas ativos aceitam aporte |

- Produto fechado recusa aporte (`409 PRODUCT_CLOSED`).
- Nome (3–80 caracteres), emissor (2–60) e datas são validados na criação.
- O catálogo público lista somente produtos `ACTIVE`, com filtro opcional por `kind`.

## 3. Aporte

- Exige produto ativo, valor inteiro positivo e valor ≥ mínimo do produto (`422 BELOW_MINIMUM`).
- Exige saldo em `MERCHANT_AVAILABLE` suficiente (`422 INSUFFICIENT_FUNDS`).
- A posição é única por `(merchantId, productId)`: novos aportes somam ao principal existente. Posição totalmente resgatada (`REDEEMED`) é reativada com nova data de abertura, reiniciando o prazo de liquidez.
- Lançamento contábil:

| Conta | Direção | Valor |
|---|---|---|
| `MERCHANT_AVAILABLE` (lojista) | débito | aporte |
| `INVESTMENT_PRINCIPAL` (lojista) | crédito | aporte |

- Grupo `INVESTMENT_CONTRIBUTION`, com auditoria `CONTRIBUTION` na mesma transação.

## 4. Resgate

- Exige posição `ACTIVE` (`409 POSITION_CLOSED`) e valor ≤ principal (`422 EXCEEDS_POSITION`).
- Resgate parcial reduz o principal e mantém a posição `ACTIVE`; resgate total marca `REDEEMED`.
- Liquidez:

| Liquidez | Resgate liberado a partir de |
|---|---|
| `D0` | data de abertura |
| `D1` | abertura + 1 dia |
| `D30` | abertura + 30 dias |
| `MATURITY` | data de vencimento do produto |

Antes do prazo retorna `409 NOT_LIQUID` com `redeemableAt` e `liquidity` no detalhe.

- Lançamento contábil:

| Conta | Direção | Valor |
|---|---|---|
| `INVESTMENT_PRINCIPAL` (lojista) | débito | resgate |
| `MERCHANT_AVAILABLE` (lojista) | crédito | resgate |

- Grupo `INVESTMENT_REDEMPTION`, auditado como `REDEMPTION`.

## 5. Proventos

Tipos e retenção:

| Tipo | IR na fonte |
|---|---|
| `DIVIDENDO` | 0% |
| `JCP` | 15% |
| `RENDIMENTO` | 15%, exceto produto `taxExempt` (0%) |

- Exige posição ativa e datas ISO válidas; `paymentDate` não pode anteceder `exDate`.
- O IR é calculado em centavos: `round(grossCents × 1.500 / 10.000)` para 15%.
- O líquido precisa ser positivo (`422 INVALID_AMOUNT`).
- O provento nasce `SCHEDULED` e é liquidado quando `paymentDate <= hoje` por `settleDue`, chamado na inicialização do servidor e de forma preguiçosa no overview.
- Liquidação idempotente: apenas registros `SCHEDULED` são processados; repetir não duplica lançamento.
- Lançamento contábil na liquidação:

| Conta | Direção | Valor |
|---|---|---|
| `INVESTMENT_INCOME` (plataforma) | débito | bruto |
| `MERCHANT_AVAILABLE` (lojista) | crédito | líquido |
| `TAX_PAYABLE` (plataforma) | crédito | IR retido (quando > 0) |

- Grupo `INVESTMENT_PROVENTO`, auditado como `PROVENTO_PAID`.

## 6. KPIs do overview

| KPI | Cálculo |
|---|---|
| `investedCents` | soma do principal das posições `ACTIVE` |
| `activePositions` | posições `ACTIVE` |
| `proventosCents` | líquido dos proventos pagos no mês corrente |
| `taxCents` | IR retido nos proventos pagos no mês corrente |
| `scheduledCents` | líquido dos proventos `SCHEDULED` |
| `availableCents` | saldo `MERCHANT_AVAILABLE` do lojista |

O payload também devolve `products`, `positions` e `proventos` (até 20 cada), com valores formatados em BRL.

## 7. API

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/v1/investments/overview` | KPIs + produtos, posições e proventos |
| `GET` | `/v1/investments/products` | Catálogo ativo (`kind`, `limit`) |
| `POST` | `/v1/investments/contributions` | Aporte com débito do disponível |
| `POST` | `/v1/investments/redemptions` | Resgate respeitando liquidez |
| `GET` | `/v1/investments/positions` | Posições do lojista |
| `GET` | `/v1/investments/proventos` | Proventos (`status`, `limit`) |
| `POST` | `/v1/investments/proventos` | Agenda dividendo, JCP ou rendimento |

Exemplo de aporte:

```bash
TOKEN=$(curl -s -X POST localhost:8080/v1/auth/demo | node -pe "JSON.parse(require('fs').readFileSync(0)).token")

curl -s -X POST localhost:8080/v1/investments/contributions \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"productId":"<id-do-produto>","amountCents":10000}'
```

A resposta traz a posição atualizada, o novo principal e o saldo disponível após o aporte.

## 8. Demonstração

Com `DEMO_MODE=true`, o seed cria:

| Produto | Indexador | Taxa | Liquidez | Mínimo | IR |
|---|---|---|---|---|---|
| CDB xPartner Liquidez Diária | CDI | 102% | D+0 | R$ 50,00 | 15% |
| LCI Habitação 90 dias | IPCA | 6,5% | D+30 | R$ 50,00 | isento |
| Tesouro Selic 2029 | CDI | 100,5% | D+1 | R$ 100,00 | 15% |
| Fundo xPartner Crédito Privado | CDI | 108% | D+30 | R$ 100,00 | 15% |

Posições: R$ 100,00 em CDB e R$ 50,00 em LCI. Proventos: R$ 4,50 de rendimento já pago (IR R$ 0,68), R$ 3,00 de JCP e R$ 3,20 de rendimento isento agendados.

No app, `Banco aberto → Investimentos` mostra KPIs, carteira, proventos e catálogo; permite aplicar, resgatar (modal com valor parcial ou total) e agendar proventos. O resgate de LCI antes de D+30 é recusado com a data liberada.

## 9. Caminho de produção

1. **Custódia e registro**: produtos emitidos/distribuídos por instituição autorizada, com custódia segregada e conciliação diária; Tesouro via B3/STN.
2. **Suitability e transparência**: perfil do investidor, lâmina, cenários e taxas reais; esta entrega exibe apenas indexador, taxa e liquidez.
3. **Precificação**: curvas de CDI/IPCA, marcação a mercado e cálculo de rendimento acumulado; hoje o principal não rende automaticamente — o rendimento entra por provento explícito.
4. **IR e obrigações acessórias**: retenção, DIRF/e-Financeira, compensação e informe de rendimentos; o `TAX_PAYABLE` local é a provisão contábil, não a apuração fiscal.
5. **Eventos corporativos**: datas ex, pagamento, bonificações, desdobramentos e proventos da B3 importados por arquivo/API.
6. **Liquidez e caixa**: fila de resgates, conta de liquidação, D+0/D+1 reais e limites por produto.
7. **Regulatório**: CVM/Bacen conforme o produto, contratos de distribuição e adequação do produto ao lojista (pessoa jurídica).

## 10. Limites desta entrega

- Sem conexão com B3, corretora, custodiante ou Tesouro.
- Sem rendimento automático por tempo: o principal permanece estável até um provento ser agendado.
- A taxa (`rateBps`) é informativa; não há accrual diário.
- IR de 15% é uma alíquota fixa de demonstração; não modela faixas, prazos ou compensação.
- Não há oferta pública, suitability ou aconselhamento de investimento.
