# xPartner Bank

Core financeiro de referência que une **adquirência, ledger de dupla entrada, Pix, antifraude em grafo e emissão de NFC-e em tempo real** em um único fluxo transacional — do cartão na maquininha ao XML assinado, com liquidação e antecipação de recebíveis. Sobre essa base roda uma camada de **tokenização lastreada**: ativos RWA/dívida, bioativos com consentimento e royalties, DePIN com Proof of Physical Work, governança DAO, agentes com guardrails, pontes PIX/Lightning/Drex/TCA e uma cadeia de âncoras verificável. Fechando o ciclo comercial, há uma **conta digital completa**: clientes, boleto registrado, links com checkout público, assinaturas recorrentes, extrato contábil e conciliação fiscal no mesmo aplicativo.

Fechando o arco de banco aberto e patrimônio, o aplicativo também opera **Open Finance** — consentimentos do titular, contas vinculadas mascaradas, débito externo e iniciação de pagamento Pix — e uma **carteira de investimentos** com CDB, LCI, LCA, Tesouro e fundos, resgate por liquidez e proventos com IR retido na fonte.

Sobre a tokenização roda o **stack Web3 institucional**: DVP atômico com digest tipado e nonce, crédito agro com colateral tokenizado e oráculo com staleness, atestações de predicado com nullifier, session keys ERC-4337 com política e teto, paymaster com anti-replay, e registro de appchains/subnets com governança. Todo movimento financeiro continua passando pelo ledger de dupla entrada e pela cadeia de âncoras.

Implementação funcional em **Node.js 24 + TypeScript + Fastify**, sem infraestrutura externa obrigatória: banco SQLite com WAL, barramento de eventos em processo e outbox transacional. A **conta digital** tem cadastro com aprovação do administrador, sessão segura, transferência real entre contas do banco, **crédito próprio** (antecipação de recebível e empréstimo com agenda de parcelas) e um **PDV com NFC-e síncrona**. O mesmo contrato bancário é espelhado em um **Worker Cloudflare** com D1, KV, R2, Queues e Workers AI. O modelo foi desenhado para migrar para PostgreSQL/Kafka/microsserviços sem reescrever o domínio.

```
[ Tap to Pay / SmartPOS ]  [ Dashboard / Backoffice ]
             \                     /
          HTTPS · HMAC · idempotência
                     │
              [ API Fastify ]
                     │
   ┌─────────────────┼──────────────────┐
   │                 │                  │
Autorização      Ledger ACID         Pix (BR Code)
   │                 │                  │
   └────────── evento transacional ─────┘
                     │
             [ Outbox → Event Bus ]
               │        │        │
            NFC-e    Notificação  Liquidação
           (SEFAZ)    (WS)        (D+n)
```

## O que está funcionando

- **Captura segura**: API aceita apenas token P2PE (`tok_bandeira_final4_hash`); PAN em claro é recusado com `PAN_NOT_ACCEPTED`.
- **Autorização**: simulador ISO 8583 determinístico (cartão bloqueado, limite, saldo, aprovação) com NSU e código de autorização.
- **Smart routing**: escolhe a adquirente pelo **custo esperado** (`taxa / taxa de sucesso`), com taxa de parcelamento e suporte por bandeira.
- **Antifraude explicável**: velocidade 1h, fan-out de cartão, fan-in de terminal, links sinalizados, anomalia de ticket, horário atípico e parcelas; score 0–100 com decisão `APPROVE / REVIEW / DECLINE`.
- **Ledger de dupla entrada**: cada grupo é validado como balanceado antes de qualquer escrita; dinheiro só em centavos inteiros; balancete sempre fecha.
- **Outbox transacional**: evento é gravado na mesma transação SQL do fato de negócio; consumidores têm deduplicação (`processed_events`) e dead-letter.
- **NFC-e 4.00**: chave de acesso de 44 dígitos com DV mod-11, XML com escaping, assinatura RSA (dev), QR Code, DANFE e ESC/POS; modo contingência (`tpEmis=9`) quando a SEFAZ rejeita.
- **Pix**: BR Code EMV com CRC16, cobrança, pagamento idempotente, liquidação D+0 e NFC-e do recebimento. Na conta digital, chaves Pix reais (CPF/CNPJ do titular, e-mail, telefone e EVP), resolução de chave, pagamento por chave e extrato marcado como Pix.
- **Clientes**: cadastro PF/PJ com dígitos verificadores de CPF/CNPJ, unicidade por documento e mascaramento LGPD.
- **Boleto registrado**: arranjo 077 com fator de vencimento FEBRABAN, código de barras de 44 posições, linha digitável de 47, baixa e cancelamento.
- **Links e checkout público**: link Pix ou boleto, página `/pay/:code` com BR Code/linha digitável, polling de status e simulação de pagamento apenas em demo.
- **Assinaturas**: ciclos semanal/mensal/trimestral/anual, primeira fatura imediata, renovação, pausa, retomada e baixa idempotente.
- **Conta e extrato**: leitura do ledger com origem (`BOLETO`, `LINK`, `SUBSCRIPTION`), totais de disponível/a receber e exportação CSV compatível com Excel brasileiro.
- **Open Finance**: consentimentos com escopo estrito (`DATA_SHARING`, `EXTERNAL_DEBIT`, `PAYMENT_INITIATION`), conta vinculada mascarada, autorização/recusa/revogação/expiração, débito externo com recebível e NFC-e, e iniciação Pix com tarifa de 50 bps lançada em partidas dobradas.
- **Investimentos**: catálogo de renda fixa (CDB/LCI/LCA/Tesouro/fundos), aporte com débito do disponível, resgate por liquidez (D0/D1/D30/vencimento), proventos (dividendo, JCP e rendimento) com IR na fonte e provisão em `TAX_PAYABLE`.
- **Liquidação**: Pix D+0, débito D+1, crédito D+30; boleto e assinatura em boleto D+1; antecipação com taxa dinâmica por prazo, volume e risco.
- **Tempo real**: WebSocket por estabelecimento para venda aprovada, nota emitida e liquidação paga.
- **Operação**: health checks, métricas Prometheus, OpenAPI, rate limit, headers de segurança, auditoria e logs com redaction.
- **Dashboard**: visão geral, simulador Tap to Pay, fila fiscal, cobrança Pix, grafo de risco, ledger e drawer de rastreabilidade.
- **Tokenização lastreada**: emissão/transferência/resgate com `TOKEN_RESERVE` e `TOKEN_LIABILITY` no mesmo grupo de dupla entrada; teto de unidades e metadata hash.
- **Bioativos com consentimento**: hash de consentimento e dataset, admissão obrigatória pela DAO, royalty contratual de até 30% e revogação imediata; nenhum dado biológico armazenado.
- **DePIN e PoPW**: registro de dispositivo, prova física inédita, capacidade declarada e recompensa contábil de 2 centavos por unidade.
- **Governança ADLA e agentes**: voto ponderado com quórum, propostas de admissão/tesouraria/parâmetro e avaliação de agente com allowlist, limite por ação, limite diário e revisão humana.
- **Pontes e provas**: cotação/liquidação simulada em PIX, Lightning, Drex e TCA; credenciais por compromisso SHA-256 com prova de inclusão Merkle e cadeia de âncoras append-only à prova de adulteração.
- **DVP atômico**: oferta com digest tipado, nonce, validade e taker opcional; aceite move as duas pernas no mesmo grupo de dupla entrada, com taxa limitada e proteção contra replay.
- **Crédito agro com oráculo**: colateral tokenizado em escrow, LTV na abertura, juros fixos, quitação com liberação e liquidação permissionless quando o preço cai abaixo do limiar.
- **Divulgação seletiva e nullifier**: atestação de predicado assinada por emissor, expiração, revogação e nullifier por finalidade/dia — sem prometer zk-SNARK.
- **ERC-4337, paymaster e agentes**: session keys com hash persistido, allowlist de seletores/símbolos, teto por sessão, limite diário, aprovação humana e patrocínio de gas com teto por UserOp e global.
- **Appchains e subnets**: registro de redes com `chainId` único, contratos de ponte/token/DVP/paymaster, finalidade e governança, tudo ancorado.
- **Conta digital com aprovação**: cadastro PF/PJ com CPF/CNPJ validado, fila de pendentes e liberação pelo administrador; senha scrypt, sessão HttpOnly com CSRF, bloqueio após 5 falhas, reset de senha temporária, exclusão só com saldo zero e auditoria de toda ação.
- **RSFN / PAG0004**: XML no namespace `bcb.gov.br` com `NumCtrlIF` de 26 caracteres, parser fechado (sem DTD, entidades ou atributos), validação de CPF/CNPJ por módulo 11, XSD publicado, hash SHA-256 do XML, débito/crédito atômicos com a câmara de compensação, estorno automático na recusa e retorno simulado apenas em demo. Sem ISPB, ICP-Brasil e conector mTLS homologado, nenhum XML sai do processo.
- **Transferência real entre contas do banco**: débito e crédito atômicos, duas partidas no razão com saldo após cada lançamento, E2E ID, chave de idempotência com hash da requisição, limites por operação e diário, comprovante com hash de integridade e extrato CSV. Sem PSP, o dinheiro circula apenas dentro do xPartner Bank — e isso está declarado em toda a interface.
- **Crédito próprio**: antecipação de recebível em 30 dias e empréstimo pessoal de 1 a 12 meses, taxa por faixa de score congelada no contrato, limite derivado de saldo e movimentação, desembolso atômico da tesouraria, agenda Price, pagamento de parcela, liquidação antecipada com desconto de juros futuros, idempotência e exportação CSV. Sem SCR/BACEN nem mora — declarado na API e na interface.
- **PDV com NFC-e síncrona**: venda presencial demo autorizada pelo adquirente simulado, emissão imediata da NFC-e, crédito do líquido na conta pela tesouraria, XML/DANFE/ESC-POS e CSV. Em produção, a liquidação pertence ao arranjo de pagamento, não à tesouraria.
- **Capital demo e carteira internacional**: aporte de capital lastreado por uma conta de contraparte no ledger em BRL (canal `CAPITAL`) e **carteira USD** com livro próprio de dupla entrada, tesouraria USD, extrato e aporte idempotente. Valores de laboratório, claramente rotulados: **não há câmbio, remessa internacional nem conta no exterior**.
- **Saldo de demonstração por CLI**: `npm run demo:balance` leva um titular a um saldo-alvo em BRL e USD creditando apenas a diferença, sem debitar, com ledger balanceado ao final.
- **Edge Cloudflare**: Worker com D1, KV, R2, Queues e Workers AI espelhando `/v1/bank/*`; o saldo é protegido por trigger atômico no D1. **Publicado em produção** em `https://xpartner-bank-edge.contatodroppfy.workers.dev` (D1, KV, R2 e filas provisionados na conta).
- **Checkout mTLS**: listener HTTPS mutual-TLS para maquininhas, com CA própria, CN = serial do terminal, fingerprint SHA-256 pinado e autorização pelo mesmo pipeline de venda. Sem certificado, o handshake é derrubado; CN desconhecido recebe 401 e fingerprint divergente recebe 403.

## Rodar em 30 segundos

Requisitos: Node.js **24+** (usa execução nativa de TypeScript, sem build).

```bash
npm ci
npm run dev
```

Abra <http://localhost:8080>. O modo demo cria o estabelecimento *Padaria Pão de Ouro*, dois terminais e vendas históricas automaticamente.

- Dashboard: `GET /`
- Conta digital: `GET /bank`
- Console operacional (crédito, PDV/NFC-e, Pix, RSFN): `GET /core`
- Aplicativo bancário: `GET /app`
- Tokenização: `GET /tokenization.html`
- Checkout público: `GET /pay/:code`
- API: `GET /v1/*`
- Métricas: `GET /metrics`
- OpenAPI: `GET /openapi.json`
- Token demo: `POST /v1/auth/demo` (ou `GET /v1/demo/bootstrap`)

### Exemplo de venda (demo)

```bash
TOKEN=$(curl -s -X POST localhost:8080/v1/auth/demo | node -pe "JSON.parse(require('fs').readFileSync(0)).token")

curl -s -X POST localhost:8080/v1/demo/sales \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"amountCents":12900,"method":"CREDIT","installments":3,"brand":"visa","last4":"4242","description":"Venda demo"}' | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync(0)),null,2)"
```

A resposta traz autorização, adquirente roteada, taxa, líquido, risco e status fiscal. A NFC-e é emitida em segundo plano pelo worker e aparece em `GET /v1/fiscal/recent`.

### Checkout mTLS (opcional)

Para aceitar maquininhas autenticadas por certificado, configure os três caminhos e suba o listener HTTPS:

```bash
export MTLS_KEY_PATH=./certs/server-key.pem
export MTLS_CERT_PATH=./certs/server-cert.pem
export MTLS_CA_PATH=./certs/bank-ca-cert.pem
npm start
```

O endpoint passa a existir em `POST https://localhost:8443/v1/secure-checkout`, com `CN` do certificado igual ao serial do terminal e fingerprint SHA-256 cadastrado em `terminals.cert_fingerprint`. Passo a passo de geração de CA, servidor e terminal em [docs/MTLS.md](docs/MTLS.md). Nunca versione os `.pem`.

### Produção com Docker

```bash
export XPARTNER_MASTER_KEY="$(openssl rand -base64 48)"
docker compose up -d --build
```

O `docker-compose.yml` sobe em modo produção (demo desligado, volume persistente, filesystem read-only). Para Kubernetes, aplique `deploy/k8s.yaml` ajustando imagem, host e secret.

## Scripts

| Comando | Função |
|---|---|
| `npm run dev` | API + dashboard com watch |
| `npm start` | API + dashboard |
| `npm test` | 93 testes (domínio, segurança, config, cobranças, Open Finance, investimentos, tokenização, Web3/DVP/agro/ZK/4337, conta digital, crédito/PDV, capital demo/carteira USD, Pix/chaves, RSFN/PAG0004, mTLS, prontidão e E2E) |
| `npm run typecheck` | TypeScript strict, sem emitir |
| `npm run check` | Typecheck + suíte completa |
| `npm run demo:balance -- --document CPF --brl 2000000000 --usd 3000000000` | Leva o titular ao saldo-alvo demo em BRL e USD, creditando só a diferença |
| `cd cloudflare && npm test` | 12 testes do edge (schema, trigger atômico, idempotência e segurança) |
| `cd cloudflare && npm run dev` | Worker local em `http://localhost:8787` |

## API principal

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/v1/transactions` | Autoriza venda com HMAC de dispositivo + `Idempotency-Key` |
| `POST` | `/v1/secure-checkout` | Autoriza venda em listener HTTPS mutual-TLS (porta 8443) |
| `GET` | `/v1/transactions/:id` | Rastro completo: risco, ledger, fiscal e liquidação |
| `POST` | `/v1/pix/charges` | Cria cobrança Pix com BR Code |
| `POST` | `/v1/pix/webhook` | Webhook do PSP assinado por HMAC |
| `GET` | `/v1/fiscal/:transactionId` | XML assinado, QR Code e DANFE |
| `GET` | `/v1/settlements/:transactionId/offer` | Oferta de antecipação precificada |
| `POST` | `/v1/settlements/:transactionId/advance` | Executa antecipação |
| `GET` | `/v1/ledger/trial` | Balancete (débitos = créditos) |
| `GET` | `/v1/app/overview` | Payload consolidado do aplicativo bancário |
| `GET/POST` | `/v1/customers` | Cadastro de clientes PF/PJ |
| `GET/POST` | `/v1/boletos` | Lista e emite boletos registrados 077 |
| `POST` | `/v1/boletos/:reference/pay` | Baixa boleto (demo) |
| `GET/POST` | `/v1/payment-links` | Lista e cria links Pix/boleto |
| `GET` | `/v1/public/links/:code` | Checkout público do link |
| `GET/POST` | `/v1/subscriptions` | Assinaturas recorrentes |
| `POST` | `/v1/subscription-invoices/:id/pay` | Baixa fatura de assinatura |
| `GET` | `/v1/statement` | Extrato contábil por período |
| `GET` | `/v1/statement.csv` | Exportação CSV do extrato |
| `GET` | `/v1/open-finance/overview` | Consentimentos, contas vinculadas, débitos e pagamentos |
| `POST` | `/v1/open-finance/consents` | Cria consentimento e conta vinculada |
| `POST` | `/v1/open-finance/consents/:id/authorize\|reject\|revoke` | Ciclo de vida do consentimento |
| `POST` | `/v1/open-finance/debits` | Agenda débito externo |
| `POST` | `/v1/open-finance/debits/:id/settle\|cancel` | Liquida (demo) ou cancela débito |
| `POST` | `/v1/open-finance/payments` | Inicia pagamento Pix via consentimento |
| `POST` | `/v1/open-finance/payments/:id/settle\|cancel` | Liquida (demo) ou cancela pagamento |
| `GET` | `/v1/investments/overview` | KPIs, produtos, posições e proventos |
| `GET` | `/v1/investments/products` | Catálogo de renda fixa ativo |
| `POST` | `/v1/investments/contributions` | Aporte com débito do saldo disponível |
| `POST` | `/v1/investments/redemptions` | Resgate respeitando liquidez |
| `GET/POST` | `/v1/investments/proventos` | Lista ou agenda dividendo, JCP e rendimento |
| `GET` | `/v1/risk/overview` | Estatísticas do grafo de risco |
| `GET` | `/v1/overview` | KPIs do estabelecimento |
| `GET` | `/v1/readiness` | O que já funciona e o que falta para operar com dinheiro real |
| `GET` | `/v1/tokenization/overview` | KPIs de ativos, bio, DePIN, DAO, agentes, pontes e âncoras |
| `POST` | `/v1/tokenization/assets/:id/mint` | Emite unidades com lastro no ledger |
| `POST` | `/v1/tokenization/bio/:id/royalties` | Paga royalty de bioativo admitido |
| `POST` | `/v1/tokenization/agents/evaluate` | Avalia ação de agente com guardrails |
| `POST` | `/v1/tokenization/bridges/quote` | Cotação em PIX, Lightning, Drex ou TCA |
| `POST` | `/v1/tokenization/zk/prove` | Prova de inclusão de credencial |
| `GET` | `/v1/web3/overview` | KPIs de DVP, agro, ZK, agentes e paymaster |
| `POST` | `/v1/web3/networks` | Registra appchain, subnet, L2 ou L1 com contratos |
| `POST` | `/v1/web3/oracle/prices` | Publica rodada de preço ancorada |
| `POST` | `/v1/web3/dvp/offers` | Cria oferta DVP com digest, nonce e validade |
| `POST` | `/v1/web3/dvp/offers/:id/accept` | Liquida as duas pernas atomicamente |
| `POST` | `/v1/web3/agro/contracts` | Abre crédito agro com LTV e oráculo |
| `POST` | `/v1/web3/agro/contracts/:id/liquidate` | Liquidação permissionless por LTV |
| `POST` | `/v1/web3/zk/verify` | Verifica predicado com nullifier e anti-replay |
| `POST` | `/v1/web3/agents/sessions` | Emite session key com seletores e teto |
| `POST` | `/v1/web3/paymaster/sponsor` | Patrocina UserOp com anti-replay |

Rotas `/v1/demo/*` existem apenas com `DEMO_MODE=true`. A superfície completa de tokenização está em [docs/TOKENIZACAO.md](docs/TOKENIZACAO.md) e a do stack Web3 em [docs/WEB3.md](docs/WEB3.md).

### Conta digital

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/v1/bank/status` | Estado do cadastro, demo e bootstrap |
| `POST` | `/v1/bank/auth/register` | Cadastro PF/PJ que entra na fila de aprovação |
| `POST` | `/v1/bank/auth/login` | Login com cookie HttpOnly, CSRF e Bearer |
| `POST` | `/v1/bank/auth/logout` | Encerra a sessão |
| `POST` | `/v1/bank/auth/change-password` | Troca de senha revogando outras sessões |
| `GET` | `/v1/bank/me` | Perfil, conta e token CSRF |
| `GET` | `/v1/bank/account` | Conta, saldo e limites |
| `GET` | `/v1/bank/statement` · `/statement.csv` | Extrato com saldo após cada lançamento e exportação |
| `GET` | `/v1/bank/recipients/lookup` | Favorecido por conta, CPF/CNPJ, e-mail ou chave Pix |
| `POST` | `/v1/bank/transfers` | Transferência interna/Pix real e idempotente |
| `GET` | `/v1/bank/transfers/:id` | Comprovante com partidas e hash de integridade |
| `GET/POST` | `/v1/bank/pix/keys` · `/pix/keys/evp` | Lista e registra chaves Pix (CPF/CNPJ do titular, e-mail, telefone, EVP) |
| `DELETE` | `/v1/bank/pix/keys/:id` | Remove (soft delete) uma chave do titular |
| `GET` | `/v1/bank/pix/keys/:id/brcode` | BR Code EMV com CRC16 e valor opcional |
| `GET` | `/v1/bank/pix/lookup` | Resolve chave ativa com dados mascarados |
| `GET` | `/v1/bank/accounts/validate` | Dígito verificador FEBRABAN módulo 11 (aceita `X` legado) |
| `GET` | `/v1/bank/credit/score` | Score interno 0–1000 e limite sugerido |
| `GET` | `/v1/bank/credit/line` | Linha de crédito com faixa, exposição e limite disponível |
| `POST` | `/v1/bank/credit/quote` | Simulação de antecipação ou empréstimo com agenda |
| `GET/POST` | `/v1/bank/credit/contracts` · `/:id` | Contratos, agenda, desembolso idempotente e exportação CSV |
| `POST` | `/v1/bank/credit/contracts/:id/installments/:number/pay` | Paga uma parcela |
| `POST` | `/v1/bank/credit/contracts/:id/settle` | Liquida antecipadamente com desconto de juros futuros |
| `GET/POST` | `/v1/bank/pdv/sales` · `/:id/fiscal` · `/:id/xml` · `.csv` | Venda demo com NFC-e síncrona, documentos e exportação |
| `POST` | `/v1/bank/demo/credit` | Aporte de tesouraria (somente demo) |
| `POST` | `/v1/bank/demo/capital` | Aporte de capital demo em BRL lastreado pela conta de capital (admin, demo, idempotente) |
| `GET` | `/v1/bank/fx/wallets` | Carteiras internacionais do titular com saldo e livro próprios |
| `GET` | `/v1/bank/fx/wallets/:currency/statement` | Extrato da carteira USD com saldo após cada lançamento |
| `POST` | `/v1/bank/demo/fx` | Aporte internacional demo em USD a partir da tesouraria USD (admin, demo) |
| `GET` | `/v1/bank/admin/overview` | KPIs, pendências e auditoria |
| `GET` | `/v1/bank/admin/users` · `/users/:id` | Lista, detalhe e exclusão lógica (saldo zero) |
| `POST` | `/v1/bank/admin/users/:id/approve\|reject\|block\|unblock\|reset-password` | Ciclo de vida do cliente |
| `GET` | `/v1/bank/admin/audit` | Trilha de auditoria |

Interface em `/bank` (abas Pix e Crédito), console operacional em `/core` com crédito e PDV, documentação em [docs/BANCO.md](docs/BANCO.md), [docs/PIX.md](docs/PIX.md) e [docs/CREDITO.md](docs/CREDITO.md).

### RSFN / PAG0004

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/v1/bank/rsfn/pag0004.xsd` | XSD do subconjunto PAG0004 usado pelo banco |
| `GET` | `/v1/bank/rsfn/config` | ISPB, modo, endpoint, certificados e notas do canal |
| `POST` | `/v1/bank/rsfn/validate` | Valida XML com parser fechado e módulo 11 sem movimentar valor |
| `POST` | `/v1/bank/rsfn/transfers` | Gera XML PAG0004, debita o cliente e credita a câmara RSFN |
| `GET` | `/v1/bank/rsfn/messages` · `/:id` · `/:id/xml` | Mensagens do titular, detalhe e download do XML |
| `POST` | `/v1/bank/rsfn/messages/:id/ack` | Simula aceite/recusa da câmara (somente demo, admin) |
| `GET` | `/v1/bank/admin/rsfn/messages` | Todas as mensagens RSFN (admin) |

Sem partidas dobradas e sem conector real: a mensagem é contabilizada, mas o envio à RSFN exige ISPB, ICP-Brasil e conector mTLS homologado. Contrato completo em [docs/RSFN.md](docs/RSFN.md).

## Estrutura

```
src/
  kernel/      config, db, dinheiro, crypto, bus/outbox, âncoras, métricas, log
  domain/      ledger, risco, roteamento, autorização, Pix, fiscal, liquidação, boleto, documentos, overview, vault, zk, web3, rsfn
  modules/     transações, Pix, workers, notificações, seed, cobranças, assinaturas, extrato, open finance, investimentos, tokenização, web3 (DVP, agro, ZK, 4337, paymaster, redes), banco (conta, auth, transferências, chaves Pix, crédito, PDV/NFC-e, capital demo e carteira USD), rsfn
  api/         Fastify, autenticação de dispositivo/token, rotas de tokenização, web3, cobranças e banco, mTLS, rate limit
public/        dashboards e aplicativo single-file (index, tokenization, app, bank, core e checkout)
cloudflare/    Worker edge: D1, KV, R2, Queues, Workers AI, migração e testes
contracts/     Solidity de referência (ADLA, bio-royalty, DePIN, governança, Merkle/anchor, token regulado, DVP, agro, paymaster, ZK, appchain, agentes)
proto/         contrato gRPC de referência da conta digital
tests/         unitários + E2E + API de tokenização + Web3 + conta digital + crédito/PDV + capital/carteira USD + Pix + mTLS
db/            schema PostgreSQL de referência, ledger unificado (ledger_core), RSFN (bank_rsfn_messages), Pix (bank_pix_keys), crédito/PDV (bank_credit_contracts, bank_credit_installments, bank_pdv_sales), câmbio demo (bank_fx_*) e XSD PAG0004
deploy/        manifestos Kubernetes
docs/          arquitetura, segurança, banco, crédito, Pix, RSFN, Cloudflare, mTLS, stack, tokenização e Web3
```

## O que é real e o que é simulado

| Camada | Nesta entrega | Caminho de produção |
|---|---|---|
| Captura | Token P2PE de desenvolvimento | Apple Tap to Pay / Google POS SDK, DUKPT + HSM |
| mTLS | Handshake TLS, CA própria, CN e fingerprint reais quando configurado | Certificados no HSM/KMS, CRL/OCSP e rotação automatizada |
| Autorização | Simulador ISO 8583 determinístico | Conexão com adquirentes/bandeiras via ISO 8583 ou API |
| Banco | SQLite WAL | PostgreSQL/Aurora; Spanner/CockroachDB para multicloud ativo-ativo |
| Eventos | Bus em processo + outbox | Kafka/MSK com partição por estabelecimento |
| Risco | Features em SQL + grafo local | Feature store (Feast/Vertex) + Neo4j/Neptune |
| SEFAZ | Mock determinístico com contingência | SEFAZ estadual real, certificado A1 no KMS/HSM |
| Pix | Chaves, BR Code EMV/CRC16, DV FEBRABAN e pagamento por chave internos, com extrato marcado como Pix | DICT e SPI via PSP participante, OTP de e-mail/telefone, devolução (MED) e conciliação |
| Boleto / links / assinaturas | Arranjo 077 interno, checkout próprio e motor de ciclos | Registro em banco/PSP, captura real, recorrência com dunning e retentativa |
| Extrato | Leitura do ledger em SQLite | Ledger PostgreSQL particionado com trilha imutável |
| Conta digital | Cadastro, aprovação, sessão, transferência interna atômica e comprovante reais em SQLite | Postgres + PSP/SPI para trilhos externos, KMS/HSM e antifraude dedicado |
| Crédito | Linha, taxa, desembolso, agenda, parcela e liquidação reais no ledger, com capital da tesouraria | SCD/IP autorizada, SCR/BACEN, cobrança/mora, IOF/IR, KYC de crédito e capital segregado |
| Capital demo (BRL) | Aporte lastreado por conta de capital no ledger, canal `CAPITAL`, idempotente e rotulado | Capital social integralizado, auditoria externa e patrimônio segregado |
| Carteira USD | Livro próprio de dupla entrada com tesouraria USD, extrato e aporte demo idempotente | Conta de câmbio/remessa autorizada, câmbio, SWIFT/SPI internacional e conciliação com correspondente |
| PDV / NFC-e de venda | Venda, NFC-e síncrona e liquidação real no ledger; adquirente e SEFAZ simulados, somente demo | Adquirente homologado, liquidação D+1 pelo arranjo, SEFAZ real e conciliação por bandeira |
| RSFN / PAG0004 | XML, XSD, validação e contabilização reais; retorno da câmara simulado | Adesão à RSFN, certificado ICP-Brasil em HSM/KMS e conector mTLS homologado |
| Edge Cloudflare | Worker, D1, KV, R2, Queues e IA implementados e testados localmente | Deploy com D1/KV/R2/fila da conta, segredos por `wrangler secret put` e observabilidade em produção |
| Open Finance | Consentimentos, contas mascaradas, débito externo e ITP internos | Adesão ao Open Finance, diretório, DICT/SPI, mTLS e conciliação com PSP |
| Investimentos | Carteira, resgate e proventos em SQLite + ledger | Custódia segregada, corretora/B3, precificação e apuração fiscal |
| Tokenização | Registro lastreado em SQLite + ledger | Emissor/custódia regulados, contratos auditados e conciliação diária |
| Bioativos | Consentimento/dataset como hash, royalty em ledger | Consentimento jurídico, LGPD operacional e distribuição auditada |
| DePIN / PoPW | Prova demonstrativa + recompensa contábil | Atestação de hardware/TEE e fabricante |
| Pontes PIX/Lightning/Drex/TCA | Cotação e liquidação interna | PSP/SPI, LND/LNbits, piloto Drex e custódia TCA |
| Provas de credencial | Compromisso + Merkle (divulgação seletiva) | zk-SNARK auditado, Open Finance e identidade descentralizada |
| Web3 institucional | DVP, crédito agro, atestação/nullifier, session keys ERC-4337, paymaster e appchains com ledger real e âncoras | Contratos auditados e implantados, oráculo multisig, verificador de prova e custódia regulada |
| Contratos em `contracts/` | Referência, não compilada nem implantada | Foundry + auditoria + timelock + multisig |
| Drex | Roadmap | Nó Hyperledger Besu, contratos e liquidação condicional |
| Multicloud | Design documentado | AWS + GCP ativos, roteamento por latência/saúde |

Este repositório é uma **referência de engenharia**, não uma instituição financeira licenciada. Operar pagamentos no Brasil exige autorização do Banco Central, adesão às bandeiras, certificação PCI e contrato com adquirente/PSP.

## Documentação

- [Arquitetura](docs/ARQUITETURA.md) — fluxos, invariantes, eventos, escala, multicloud, tokenização, conta digital e edge.
- [Conta digital](docs/BANCO.md) — cadastro, aprovação, sessão, transferência real, limites, comprovante, score e API.
- [Crédito e PDV/NFC-e](docs/CREDITO.md) — antecipação, empréstimo Price, linha por score, agenda, liquidação antecipada, contabilidade, idempotência, venda presencial e limites BACEN.
- [Pix](docs/PIX.md) — chaves, titularidade, limites, BR Code EMV/CRC16, pagamento por chave, DV FEBRABAN e caminho para DICT/SPI.
- [RSFN / PAG0004](docs/RSFN.md) — contrato XML, XSD, módulo 11, parser seguro, ciclo contábil, endpoints e caminho para o conector real.
- [Cloudflare](docs/CLOUDFLARE.md) — topologia, D1, trigger atômico, paridade de rotas, KV/R2/Queues/AI e limitações.
- [mTLS](docs/MTLS.md) — certificados das maquininhas, configuração, contrato do secure checkout, testes e limites.
- [Go-live](docs/GO_LIVE.md) — o que é real, o que depende de licença/contrato e o caminho para operar com dinheiro real.
- [Stack](docs/STACK.md) — o que roda, o que é referência, o que é emulado e o que é roadmap, tecnologia por tecnologia.
- [Cobranças](docs/COBRANCAS.md) — clientes, boleto, links, checkout, assinaturas, extrato e conciliação.
- [Open Finance](docs/OPEN_FINANCE.md) — consentimentos, contas vinculadas, débito externo, iniciação Pix e caminho de produção.
- [Investimentos](docs/INVESTIMENTOS.md) — produtos, aportes, resgate, proventos, IR e caminho de produção.
- [Segurança](docs/SEGURANCA.md) — P2PE, DUKPT, mTLS, ameaças, segredos, escopo PCI e limites de bioativos/agentes.
- [Tokenização](docs/TOKENIZACAO.md) — ativos, bioativos, DAO, DePIN, agentes, pontes, provas, mapa da lista solicitada e roadmap.
- [Web3 institucional](docs/WEB3.md) — DVP atômico, crédito agro com oráculo, ZKP/nullifier, ERC-4337, paymaster, appchains, invariantes e limites.
- [Contratos de referência](contracts/README.md) — Solidity e paridade de canonicalização.
- [Schema PostgreSQL](db/schema.postgres.sql) — modelo de produção equivalente, com complementos de [ledger](db/schema.ledger.postgres.sql), [Pix](db/schema.pix.postgres.sql), [crédito/PDV](db/schema.credit.postgres.sql), [RSFN](db/schema.rsfn.postgres.sql) e [carteira USD demo](db/schema.fx.postgres.sql).
