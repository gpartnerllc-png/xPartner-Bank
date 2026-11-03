# Cloudflare · integração do xPartner Bank

O xPartner Bank tem dois planos de execução que compartilham o mesmo domínio e o mesmo contrato de API bancária:

1. **Núcleo Node 24** — autoridade para adquirência, ledger, Pix, NFC-e, boleto, Open Finance, investimentos e tokenização. Persiste em SQLite WAL local.
2. **Edge Cloudflare** — espelho de conta digital em Workers + D1 + KV + R2 + Queues + Workers AI, com o mesmo fluxo de cadastro, aprovação, sessão, extrato e transferência interna.

O edge não é uma maquete: é um Worker tipado, com schema versionado, trigger de dupla entrada, testes e execução local validada. O que ainda não existe é o **deploy** — os IDs de D1/KV em `wrangler.jsonc` estão como placeholder.

## 1. Topologia

```
                       ┌──────────────────────────────┐
  public/bank.html ───►│  Cloudflare Worker (edge)    │
                       │  /v1/bank/*                  │
                       └──────────────┬───────────────┘
                                      │
        ┌───────────────┬─────────────┼─────────────┬──────────────┐
        ▼               ▼             ▼             ▼              ▼
      D1 (DB)         KV (CACHE)    R2            Queues       Workers AI
   usuários, contas,  rate limit   comprovantes   eventos      insights
   razão, auditoria                                             (fallback)
```

O núcleo Node expõe exatamente os mesmos caminhos `/v1/bank/*`, o que permite apontar o frontend para um ou outro backend sem alterar código de cliente.

## 2. Modelo D1

`migrations/0001_bank.sql` cria, de forma aditiva:

| Tabela | Papel |
|---|---|
| `bank_users` | cadastro PF/PJ, papel (`USER`/`ADMIN`/`SYSTEM`), status, hash de senha, `must_change_password` |
| `bank_accounts` | agência/número com dígito, saldo em centavos, limites por transferência e diário |
| `bank_sessions` | token em hash, CSRF, expiração e revogação |
| `bank_transfers` | transferência com status, E2E, chave de idempotência e hash da requisição |
| `bank_ledger` | duas linhas por transferência (`-D` e `-C`) com `balance_after_cents` |
| `bank_audit` | trilha de ações sensíveis |
| `bank_sequences` | numeração monotônica de contas via `UPDATE ... RETURNING` |
| `edge_events` | eventos consumidos da fila, com `INSERT OR IGNORE` para deduplicar |

Views de compatibilidade `contas` e `transacoes` expõem o modelo em português, com a mesma semântica de saldo do núcleo:

```sql
SELECT a.id, u.name, SUM(l.amount_cents * CASE l.direction WHEN 'CREDIT' THEN 1 ELSE -1 END) AS saldo_cents
  FROM bank_accounts a
  JOIN bank_users u ON u.id = a.user_id
  JOIN bank_ledger l ON l.account_id = a.id
 GROUP BY a.id, u.name;
```

### Trigger de transferência

O ponto mais importante do desenho: o D1 não oferece transação interativa com `BEGIN IMMEDIATE`. A atomicidade é delegada ao banco por um trigger `AFTER INSERT`:

```sql
CREATE TRIGGER bank_transfers_post AFTER INSERT ON bank_transfers
WHEN NEW.status = 'POSTED' BEGIN
  UPDATE bank_accounts SET balance_cents = balance_cents - NEW.amount_cents
   WHERE id = NEW.debit_account_id AND status = 'ACTIVE' AND balance_cents >= NEW.amount_cents;
  SELECT RAISE(ABORT, 'DEBIT_ACCOUNT_INACTIVE') WHERE ...;
  SELECT RAISE(ABORT, 'INSUFFICIENT_FUNDS')      WHERE ...;
  UPDATE bank_accounts SET balance_cents = balance_cents + NEW.amount_cents
   WHERE id = NEW.credit_account_id AND status = 'ACTIVE';
  SELECT RAISE(ABORT, 'CREDIT_ACCOUNT_INACTIVE') WHERE ...;
  INSERT INTO bank_ledger (...) VALUES (NEW.id || '-D', ...);
  INSERT INTO bank_ledger (...) VALUES (NEW.id || '-C', ...);
END;
```

Se qualquer condição falhar, o `ABORT` desfaz o `INSERT` e todas as alterações do trigger. Não há janela de inconsistência, e a aplicação não pode “esquecer” de gravar uma partida.

Testes em `test/schema.test.ts` verificam: débito/crédito corretos, duas partidas com `balance_after_cents`, abort integral por saldo insuficiente, bloqueio de auto-transferência por `CHECK`, unicidade da chave de idempotência e leitura correta das views.

## 3. Paridade de endpoints

| Método | Rota | Node | Edge |
|---|---|---|---|
| `GET` | `/v1/bank/status` | ✅ | ✅ |
| `POST` | `/v1/bank/auth/register` | ✅ | ✅ |
| `POST` | `/v1/bank/auth/login` | ✅ | ✅ |
| `POST` | `/v1/bank/auth/logout` | ✅ | ✅ |
| `POST` | `/v1/bank/auth/change-password` | ✅ | ✅ |
| `GET` | `/v1/bank/me` | ✅ | ✅ |
| `GET` | `/v1/bank/account` | ✅ | ✅ |
| `GET` | `/v1/bank/statement` | ✅ | ✅ |
| `GET` | `/v1/bank/statement.csv` | ✅ | ✅ |
| `GET` | `/v1/bank/recipients/lookup` | ✅ | ✅ |
| `POST` | `/v1/bank/transfers` | ✅ | ✅ |
| `GET` | `/v1/bank/transfers/:id` | ✅ | ✅ |
| `GET` | `/v1/bank/receipts/:id` | — | ✅ (R2) |
| `GET` | `/v1/bank/credit/score` | ✅ | ✅ |
| `POST` | `/v1/bank/ai/insights` | — | ✅ |
| `POST` | `/v1/bank/demo/credit` | ✅ | ✅ |
| `GET` | `/v1/bank/admin/overview` | ✅ | ✅ |
| `GET` | `/v1/bank/admin/users` | ✅ | ✅ |
| `GET/DELETE` | `/v1/bank/admin/users/:id` | ✅ | ✅ |
| `POST` | `/v1/bank/admin/users/:id/approve\|reject\|block\|unblock\|reset-password` | ✅ | ✅ |
| `GET` | `/v1/bank/admin/audit` | ✅ | ✅ |
| `GET` | `/v1/bank/admin/demo-data` · `POST .../purge` | ✅ | ✅ (D1 + Durable Object do lojista) |
| `GET` | `/v1/bank/rsfn/config` · `/validate` · `/transfers` · `/messages` · `/pag0004.xsd` | ✅ | ✅ |
| `GET/POST/DELETE` | `/v1/bank/pix/keys` · `/keys/evp` | ✅ | ✅ |
| `GET` | `/v1/bank/recipients/lookup` | ✅ | ✅ |
| `GET/POST` | `/v1/bank/credit/score` · `/quote` · `/contracts` · `/contracts.csv` | ✅ | ✅ |
| `GET/POST` | `/v1/bank/demo/capital` · `/demo/fx` · `GET /v1/bank/fx/wallets` | ✅ | ✅ |
| `GET` | `/v1/bank/pdv/sales*` | ✅ | — (somente Node) |

A paridade é de **coleção**, não de item: o edge atende as listas, o cadastro, a sessão, as transferências, o extrato, o crédito (cotação, contratos e CSV), as chaves Pix, o RSFN, o capital/USD e a limpeza de demonstração. O que ainda **só existe no núcleo** é o que depende de identificar um registro por `:id` ou de escrever em dois bancos na mesma transação SQLite: `GET /v1/bank/transfers/:id` (comprovante), o ciclo de vida administrativo por usuário (`approve|reject|block|unblock|reset-password`, `DELETE /users/:id`), os contratos de crédito por id com pagamento de parcela e liquidação antecipada, a linha de crédito (`/credit/line`), o **PDV/NFC-e** (assinatura RSA, numeração síncrona e XML), os documentos por mensagem RSFN e o aceite da câmara, o BR Code por chave, a consulta por chave (`/pix/lookup`), a validação de conta (`/accounts/validate`) e o extrato da carteira USD por moeda. Para esses casos o contrato é o do núcleo; o edge devolve `404` ou `503 NOT_AVAILABLE`.

O **capital e a carteira USD** estão nos dois lados e seguem a mesma regra: abrem zerados, o aporte debita a contraparte e credita o titular na mesma transação e, sem lastro, a resposta é `TREASURY_EMPTY` / `CAPITAL_EMPTY`. **Não há câmbio nem remessa internacional**; contrato em [BANCO.md](BANCO.md).

## 4. Segurança no edge

- **Senha**: PBKDF2-HMAC-SHA256, 210.000 iterações, salt aleatório de 16 bytes, comparação em tempo constante. O runtime de Workers não expõe `scrypt`; PBKDF2 é o primitivo correto disponível via WebCrypto.
- **Sessão**: token aleatório de 32 bytes; só o SHA-256 é persistido. Cookie `HttpOnly`, `SameSite=Strict`, `Secure` fora do local, com revogação por linha.
- **CSRF**: toda escrita autenticada por cookie exige o token exato da sessão. Bearer é aceito para integrações e não exige CSRF.
- **Rate limit**: KV com janelas por IP e por usuário — cadastro 5/min, login 20/min, transferência 30/min.
- **Bloqueio**: 5 tentativas de login inválidas bloqueiam a conta por 15 minutos.
- **Aprovação**: cadastro nasce `PENDING`; só o admin aprova. `DELETE` é sempre lógico e exige saldo zero. Toda ação administrativa grava em `bank_audit`.
- **CORS**: restrito a `APP_ORIGIN`.
- **Segredos**: apenas por `wrangler secret put`.

## 5. Assíncrono

- **R2**: cada transferência grava um comprovante JSON com hash SHA-256, recuperável em `/v1/bank/receipts/:id` e conferível pelo hash retornado na resposta.
- **Queues**: eventos `bank.user`, `bank.transfer` e `bank.settlement` alimentam o consumidor, que grava em `edge_events` com deduplicação. Falha vai para retry e, após 5 tentativas, para a DLQ.
- **Scheduled**: cron limpa sessões expiradas/revogadas há mais de 7 dias e eventos com mais de 30 dias.
- **Workers AI**: `/v1/bank/ai/insights` gera uma leitura do perfil financeiro; se o modelo falhar, a rota devolve a análise heurística determinística em vez de erro.

## 6. Operação

```bash
cd cloudflare
npm ci
npm run db:migrate:local
npm run dev      # http://localhost:8787
npm test         # 32 testes
npm run check    # tsc strict
```

Para produção: crie D1, KV, R2 e filas; preencha os IDs; publique os segredos; rode `npm run db:migrate`; então `npm run deploy`. Passo a passo em [cloudflare/README.md](../cloudflare/README.md).

**Estado atual (2026-11-03): publicado em produção.** D1 `xpartner-bank` (id `2bbeea7f-0f07-4dec-8bcb-1152a68660e6`) com as migrações `0001` a `0006` aplicadas, namespace KV reutilizado (`XPARTNER_KV`, id `d3f7a791713342e4a0e2a04f3f5e4a8b`), bucket R2 `xpartner-bank-receipts` criado, filas `xpartner-bank-events` + DLQ criadas e Workers AI vinculado. Worker live em `https://xpartner-bank-edge.contatodroppfy.workers.dev` (`GET /v1/bank/status` responde com o mapa de capacidades do edge).

`0006_real_data_baseline.sql` é o baseline de fatos reais: apaga os lançamentos de demonstração do D1 na ordem que as chaves estrangeiras exigem, remove os usuários de teste `@xpartner.test` com suas contas e carteiras, zera `balance_cents`/`opening_balance_cents` e renomeia a conta de sistema para **Tesouraria de capital xPartner**. É **aditiva em estrutura** — nenhuma tabela some, nenhuma coluna é destruída e a trilha de auditoria continua. Depois dela, o painel público só mostra o que o titular lançou. A mesma limpeza pode ser refeita pelo console do `/bank` (`POST /v1/bank/admin/demo-data/purge`), que apaga o D1 e chama o Durable Object do lojista para apagar o SQLite dele.

## 7. O que não está integrado

- O Worker não fala com PSP, SPI, SEFAZ ou Open Finance. Adquirência, Pix e fiscal permanecem no núcleo Node.
- Não há replicação automática entre SQLite e D1. A paridade é de contrato de API, não de dados.
- Capital demo e carteira USD (`bank_fx_*`) seguem exclusivos do núcleo Node; a migração equivalente para D1 fica para quando houver operação real de câmbio/remessa.
- Hyperdrive não é usado: não há Postgres externo para acelerar. Se o núcleo migrar para PostgreSQL, Hyperdrive passa a fazer sentido.
