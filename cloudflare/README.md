# xPartner Bank · Edge Cloudflare

Espelho de conta digital do xPartner Bank rodando 100% no edge: **Workers + D1 + KV + R2 + Queues + Workers AI**. É a mesma superfície de conta, cadastro, aprovação e transferência interna do núcleo Node, com o livro-razão protegido por trigger atômico no D1.

> **Estado real:** o Worker está implementado, tipado, testado (12 testes) e **publicado em produção** em `https://xpartner-bank-edge.contatodroppfy.workers.dev`. Recursos provisionados na conta: D1 `xpartner-bank` (`2bbeea7f-0f07-4dec-8bcb-1152a68660e6`, migração `0001_bank` aplicada), namespace KV `XPARTNER_KV`, bucket R2 `xpartner-bank-receipts`, filas `xpartner-bank-events`/`xpartner-bank-events-dlq` e binding Workers AI. As páginas de `public/` (dashboard, `/bank`, `/core`, `/app`, `/pay`, tokenização) são servidas como **Workers Static Assets** no mesmo domínio — a mesma `bank.html` conversa com a API do edge por origem única.

## Por que existe

O núcleo Node continua sendo a autoridade para adquirência, Pix, fiscal, boleto, Open Finance e investimentos. O Worker cobre a camada em que latência e disponibilidade importam mais que integração com trilhos externos: sessão, saldo, extrato e transferência entre contas do próprio banco. A paridade de rotas permite que o mesmo `public/bank.html` converse com qualquer um dos dois backends.

## Arquitetura

```
Cliente (public/bank.html)
        │  HTTPS · cookie HttpOnly + CSRF / Bearer
        ▼
┌──────────────────── Cloudflare Worker ────────────────────┐
│  router (src/index.ts)                                    │
│   ├── auth.ts       cadastro, login, aprovação, senhas    │
│   ├── bank.ts       transferência, extrato, comprovante    │
│   ├── repo.ts       contas, favorecidos, auditoria         │
│   ├── security.ts   PBKDF2, sessões, CSRF, rate limit KV   │
│   └── validation.ts CPF/CNPJ, valores, E2E                 │
│                                                           │
│  D1 ── trigger AFTER INSERT em bank_transfers              │
│   ├── debita só com saldo e conta ativos (ou aborta tudo)  │
│   ├── credita o favorecido                                 │
│   └── grava as duas partidas em bank_ledger                │
│                                                           │
│  KV  → rate limit por IP/usuário                          │
│  R2  → comprovante JSON com hash SHA-256                  │
│  Queues → bank.user / bank.transfer / bank.settlement     │
│  AI  → leitura de perfil com fallback heurístico           │
└───────────────────────────────────────────────────────────┘
```

O ponto central é o **trigger**: a transferência é inserida como uma linha `POSTED` em `bank_transfers`; o banco relacional do D1 aplica débito, crédito e as duas linhas do razão na mesma transação. Se o saldo não cobrir o valor, o `RAISE(ABORT)` desfaz a inserção inteira — não existe estado intermediário em que o dinheiro saiu de um lado e não chegou do outro.

## Rodando local

```bash
cd cloudflare
npm ci
npm run db:migrate:local
npm run dev
```

O `wrangler dev --local` usa D1, KV, R2 e fila simulados no disco (`.wrangler/`). Crie um `.dev.vars` a partir do exemplo — ele é ignorado pelo git:

```bash
cp .dev.vars.example .dev.vars
```

```ini
ENVIRONMENT=local
DEMO_MODE=true
APP_ORIGIN=http://localhost:8787
SESSION_PEPPER=troque-por-um-valor-aleatorio-longo
```

Em `DEMO_MODE=true` o primeiro cadastro vira administrador e o aporte da tesouraria fica habilitado. Fora do demo, o primeiro admin exige `BOOTSTRAP_TOKEN`.

## Publicando

```bash
npx wrangler d1 create xpartner-bank
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create xpartner-bank-receipts
npx wrangler queues create xpartner-bank-events
npx wrangler queues create xpartner-bank-events-dlq
```

Copie os IDs devolvidos para `wrangler.jsonc` (`database_id` e o `id` do KV). Depois:

```bash
npx wrangler secret put SESSION_PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN
npm run db:migrate
npm run deploy
```

**Nunca** coloque `SESSION_PEPPER` ou `BOOTSTRAP_TOKEN` em `wrangler.jsonc` nem no repositório. Segredos vão sempre por `wrangler secret put`.

## Bindings

| Binding | Recurso | Uso |
|---|---|---|
| `DB` | D1 `xpartner-bank` | usuários, contas, sessões, transferências, razão, auditoria e eventos |
| `CACHE` | KV `CACHE` | rate limit de login, cadastro, transferência e consulta |
| `RECEIPTS` | R2 `xpartner-bank-receipts` | comprovante JSON imutável de cada transferência |
| `EVENTS` | Queue `xpartner-bank-events` | eventos de negócio com DLQ |
| `AI` | Workers AI | leitura do perfil financeiro (fallback heurístico se falhar) |
| `ENVIRONMENT` | var | `production` / `local` |
| `DEMO_MODE` | var | `false` em produção |
| `APP_ORIGIN` | var | origem permitida no CORS e nos cookies |
| `SESSION_TTL_SECONDS` | var | validade da sessão (padrão 8 h) |

## Scripts

| Comando | Função |
|---|---|
| `npm run dev` | Worker local com D1/KV/R2/fila simulados |
| `npm run deploy` | Publica em produção |
| `npm run check` | TypeScript strict no `src/` |
| `npm test` | 12 testes de schema, trigger, idempotência e segurança |
| `npm run db:migrate:local` | Aplica `migrations/` no D1 local |
| `npm run db:migrate` | Aplica `migrations/` no D1 remoto |
| `npm run tail` | Logs em tempo real |

## Migração

`migrations/0001_bank.sql` cria `bank_users`, `bank_accounts`, `bank_sessions`, `bank_transfers`, `bank_ledger`, `bank_audit`, `bank_sequences`, `edge_events`, as views `contas`/`transacoes` e o trigger `bank_transfers_post`. É **aditiva**: nada é apagado. Para evoluir, crie `0002_*.sql` — nunca edite uma migração já aplicada.

## Testes

```bash
npm test        # 12 testes
npm run check   # tsc strict
```

`test/schema.test.ts` prova que o trigger debita e credita, grava duas partidas, aborta tudo em saldo insuficiente, bloqueia auto-transferência e que a chave de idempotência é única. `test/security.test.ts` cobre PBKDF2, política de senha, senha temporária, CPF/CNPJ, dígito de conta, parsing de valores e chave de idempotência.

## Diferenças honestas em relação ao núcleo Node

| Item | Node | Edge |
|---|---|---|
| Hash de senha | scrypt (N=16384) | PBKDF2-SHA256 210k (Workers não expõe scrypt) |
| Banco | SQLite WAL local | D1 (SQLite distribuído, **sem** transação interativa) |
| Postura de escrita | `BEGIN IMMEDIATE` + serviço | trigger atômico no D1 |
| Eventos | outbox + bus em processo | Queues com DLQ e deduplicação em `edge_events` |
| Comprovante | hash no próprio registro | JSON no R2 + hash SHA-256 |
| IA | não usa | Workers AI com fallback |
| Trilhos externos | adquirência/Pix/fiscal | ausente por escopo |

## Limitações

- O Worker **não** substitui o núcleo para Pix, boleto, fiscal ou Open Finance; essas rotas vivem no Node.
- D1 não tem `BEGIN ... COMMIT` interativo: toda atomicidade depende do trigger e de `INSERT ... RETURNING`. Não mova a lógica de saldo para fora dele.
- Ainda não há deploy; os IDs em `wrangler.jsonc` são placeholders.
- Sem integração com PSP real, nenhuma transferência sai do xPartner Bank. O que existe é transferência **real e contábil** entre contas do mesmo banco.

Veja também [docs/CLOUDFLARE.md](../docs/CLOUDFLARE.md) e [docs/BANCO.md](../docs/BANCO.md).
