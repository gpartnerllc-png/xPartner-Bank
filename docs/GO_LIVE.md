# Go-live: do laboratório ao banco real

Este documento separa o que **já funciona de verdade dentro do sistema** do que depende de **licença, contrato ou credencial de terceiros**. Nada aqui autoriza operar dinheiro real: enquanto os itens obrigatórios não estiverem cumpridos, o ambiente permanece de demonstração.

O diagnóstico vivo está em `GET /v1/readiness` — ele retorna cada capacidade com status `READY`, `PARTIAL`, `MISSING` ou `MANUAL`, o que falta e o percentual de prontidão, sem expor segredos.

## 1. O que já é real no código

| Capacidade | Situação |
|---|---|
| Ledger de dupla entrada em centavos | Real, com validação de balanço antes de cada escrita |
| Transferências internas entre contas | Reais dentro do banco, atômicas e idempotentes, com comprovante e hash |
| Cadastro, aprovação, bloqueio e reset | Reais, com scrypt, sessão HttpOnly, CSRF, lockout e auditoria |
| Outbox transacional | Real: evento e fato de negócio na mesma transação SQL |
| NFC-e | XML, assinatura, QR, DANFE e contingência reais; **SEFAZ é mock** |
| Pix | BR Code, cobrança e liquidação internas reais; **SPI/PSP não conectados** |
| Chaves Pix e pagamento por chave | Registro, titularidade CPF/CNPJ, limite e soft delete reais; **DICT local, sem SPI** |
| Dígito FEBRABAN módulo 11 | Real: validação de conta com convenção `0` e `X` legado |
| Cartões | Roteamento, risco e autorização reais; **adquirente é simulador ISO 8583** |
| Boleto, links, assinaturas, extrato | Motor real; **registro bancário e captura externos não conectados** |
| Open Finance / investimentos | Ciclo interno real; **adesão e custódia externas não conectadas** |
| RSFN / PAG0004 | XML, XSD, validação e contabilização reais; **conector RSFN e retorno da câmara não implementados** |
| Crédito (antecipação e empréstimo) | Linha, taxa por score, desembolso, agenda, parcela e liquidação reais no ledger; **sem SCR/BACEN, mora ou cobrança** |
| PDV / NFC-e | Venda, NFC-e síncrona e liquidação do líquido reais no ledger; **adquirente e SEFAZ simulados, somente demo** |
| Capital demo e carteira USD | Aporte de capital em BRL e carteira USD com dupla entrada reais no livro demo; **sem câmbio, remessa internacional ou correspondente** |
| mTLS de terminal | Handshake real com CA própria e fingerprint fixado |
| Edge Cloudflare | Worker/D1/KV/R2/Queues prontos; **não publicado** |

## 2. O que só o negócio destrava

Estes itens não são código. Dependem de contrato, licença, certificação ou capital.

### Licença e conformidade

- Autorização do Banco Central como **Instituição de Pagamento (IP)** ou **Sociedade de Crédito Direto (SCD)**, ou operar como correspondente/parceiro de um **banco ou BaaS licenciado**.
- Para conceder crédito com capital próprio em escala: **SCD** autorizada, políticas de crédito aprovadas, **registro no SCR/BACEN**, apuração de IOF/IR e contratos aderentes ao CDC.
- **KYC/KYB** e **PLD/FT** com fornecedor aprovado, regras de sanções, PEP e comunicação de operações suspeitas.
- **PCI DSS** para captura, tokenização e armazenamento de dados de cartão (SAQ D se houver transmissão).
- **LGPD**: base legal, DPO, consentimento, retenção e direito de exclusão.
- Contratos com **bandeiras** e **adquirentes**, regras de chargeback e antifraude.
- Auditoria independente, capital mínimo, plano de continuidade e seguro.

### Integrações externas

| Integração | O que contratar | O que a instituição fornece | Variáveis previstas |
|---|---|---|---|
| Adquirência | Cielo, Rede, Stone, Getnet ou Sub | Credenciais, certificado, endpoint ISO 8583/API, homologação | `ACQUIRER_PROVIDER`, `ACQUIRER_BASE_URL`, `ACQUIRER_CLIENT_ID`, `ACQUIRER_CLIENT_SECRET` |
| Pix | PSP participante ou participação direta no SPI | Credenciais mTLS/RSFN, certificado ICP-Brasil, DICT, webhook assinado | `PIX_PSP_PROVIDER`, `PIX_PSP_CLIENT_ID`, `PIX_PSP_CLIENT_SECRET`, `PIX_WEBHOOK_SECRET` |
| RSFN | Participação direta na RSFN (ou BaaS participante) | ISPB, certificado ICP-Brasil em HSM/KMS, conector mTLS homologado e arquivos de retorno | `RSFN_ISPB`, `RSFN_ENDPOINT`, `RSFN_CERT_PATH`, `RSFN_KEY_PATH`, `RSFN_CA_PATH` |
| NFC-e | SEFAZ do estado | Certificado A1/A3, CSC e ID do token, habilitação do contribuinte | `FISCAL_CERT_PATH`, `FISCAL_CERT_PASSWORD`, `FISCAL_CSC`, `FISCAL_CSC_ID` |
| Open Finance | Adesão ao Open Finance Brasil | Certificação FAPI, diretório, contrato com detentora/receptora | `OPEN_FINANCE_CLIENT_ID`, `OPEN_FINANCE_CERT_PATH`, `OPEN_FINANCE_DIRECTORY_URL` |
| Edge | Cloudflare | Conta, domínio, IDs de D1/KV/R2 | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |

As variáveis acima são o contrato de configuração usado pelo diagnóstico. Os adaptadores reais entram no seam já existente de autorização, Pix, fiscal e consentimentos; enquanto não houver credencial, o sistema recusa e registra em vez de fingir sucesso.

## 3. O que falta tecnicamente para produção

1. **Banco de dados**: trocar SQLite por PostgreSQL/Aurora com réplica, migrações versionadas e backup PITR testado. O schema de referência está em `db/schema.postgres.sql`, `db/schema.ledger.postgres.sql`, `db/schema.rsfn.postgres.sql`, `db/schema.credit.postgres.sql` e `db/schema.fx.postgres.sql`.
2. **Eventos**: Kafka/Redpanda com partição por estabelecimento, DLQ e replay; o outbox já garante a publicação.
3. **Segredos e chaves**: KMS/HSM para chave mestra, certificados A1 e chaves de assinatura; rotação e CRL/OCSP para mTLS.
4. **Observabilidade**: OpenTelemetry, métricas Prometheus, logs estruturados com redaction, alertas de saldo, outbox e fila fiscal.
5. **Resiliência**: múltiplas zonas, health checks, circuit breaker por adquirente/PSP, retry idempotente e conciliação diária.
6. **Conciliação**: arquivos/API de cada parceiro versus ledger, com quebra e reprocesso.
7. **Segurança de aplicação**: WAF, rate limit distribuído, revisão de sessão, pentest e gestão de vulnerabilidades.
8. **Operação**: runbooks de chargeback, MED, contingência SEFAZ, estorno e encerramento de conta.

## 4. Ordem recomendada

1. **Fase 0 — sandbox**: contratar um BaaS/PSP com Pix e boleto; rodar homologação sem dinheiro real.
2. **Fase 1 — dinheiro entrando**: Pix, boleto registrado, conta e transferências internas com conciliação.
3. **Fase 2 — cartões**: adquirência homologada, tokenização P2PE, chargeback e liquidação.
4. **Fase 3 — fiscal**: NFC-e em homologação estadual e depois produção, com contingência.
5. **Fase 4 — Open Finance**: consentimentos regulados, iniciação de pagamento e débito externo.
6. **Fase 5 — investimentos**: custódia segregada, B3/corretora, apuração fiscal.

## 5. Critérios de aceite antes de dinheiro real

- [ ] Licença ou contrato de BaaS assinado e vigente.
- [ ] KYC/KYB e PLD/FT operando com trilha de auditoria.
- [ ] PCI DSS emitido para o escopo de cartões.
- [ ] Pix homologado com DICT, webhook e devoluções testadas.
- [ ] Chaves Pix reivindicadas e portáveis no DICT oficial, com OTP de e-mail/telefone e bloqueio cautelar/MED.
- [ ] RSFN/PAG0004 com ISPB, certificado ICP-Brasil e conector mTLS homologados, retorno real e conciliação diária.
- [ ] Crédito com política aprovada, registro no SCR/BACEN, cobrança/mora, IOF/IR e contratos revisados juridicamente; capital próprio segregado.
- [ ] PDV liquidado pelo arranjo de pagamento (D+1), com conciliação por adquirente, em vez da tesouraria.
- [ ] Carteira USD substituída por conta de câmbio/remessa autorizada (ou desativada), com correspondente, SWIFT/SPI internacional e conciliação cambial; o livro demo não opera dinheiro real.
- [ ] NFC-e autorizada em homologação e contingência ensaiada.
- [ ] Conciliação diária fechando 100% com todos os parceiros.
- [ ] Teste de restore e plano de continuidade aprovados.
- [ ] Pentest sem achados críticos e alertas em produção.
- [ ] `NODE_ENV=production`, `DEMO_MODE=false`, segredo de 32+ via KMS.
- [ ] `GET /v1/readiness` sem itens `MISSING` e com os itens `MANUAL` concluídos.

Enquanto os itens acima não estiverem completos, o sistema deve continuar em demonstração e **não deve processar dinheiro de terceiros**.
