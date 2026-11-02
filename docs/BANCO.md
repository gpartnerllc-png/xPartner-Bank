# Conta digital · cadastro, aprovação e transferências

O xPartner Bank tem uma conta digital de verdade dentro do próprio banco: cadastro com CPF/CNPJ validado, aprovação por administrador, senha com hash forte, sessão com CSRF, extrato contábil com saldo após cada lançamento e transferência **real** entre contas do mesmo banco — débito e crédito atômicos, duas partidas no livro-razão, comprovante com hash de integridade.

O que a transferência **não** faz: sair para outro banco. Sem conexão com PSP/SPI, o dinheiro circula apenas dentro do xPartner Bank. O que existe é contabilidade real, não um número fabricado na tela.

## 1. Ciclo de vida do cadastro

```
cadastro ──► PENDING ──aprovado──► ACTIVE ──bloqueio──► BLOCKED ──desbloqueio──► ACTIVE
                │                    │                    │
              recusado            exclusão lógica       exclusão lógica
                ▼                    ▼                    ▼
             DELETED              DELETED              DELETED
```

- **Campos**: nome, CPF ou CNPJ (dígito verificador validado), e-mail único, telefone e senha.
- **Cadastro novo entra `PENDING`** e não recebe conta nem sessão. A tela mostra “aguarde a aprovação”.
- **Aprovação** cria a conta corrente (agência `0001`, número de 7 dígitos + dígito verificador) e ativa o acesso.
- **Primeiro usuário**: em demonstração vira `ADMIN` e já entra ativo. Em produção, só vira admin com `BANK_BOOTSTRAP_TOKEN` correto — sem token, o cadastro é recusado com mensagem explícita.
- **Exclusão** é lógica e exige **saldo zero**. Conta com dinheiro não é apagada.
- `SYSTEM` é a tesouraria; não faz login (`!system-account-no-login!`) e não aparece nas listas.

## 2. Segurança de acesso

| Controle | Implementação |
|---|---|
| Hash de senha | `scrypt` N=16384, r=8, p=1, 64 bytes, salt aleatório; formato `scrypt$N$r$p$salt$hash` |
| Política de senha | mínimo 10 caracteres, maiúscula, minúscula, número e símbolo |
| Sessão | token aleatório de 32 bytes; só o SHA-256 fica no banco |
| Cookie | `xp_bank_session`, `HttpOnly`, `SameSite=Strict`, `Secure` em produção, TTL de 8 h |
| Bearer | aceito para integrações programáticas |
| CSRF | cookie sem Bearer exige o token exato da sessão em qualquer escrita |
| Força bruta | 5 falhas bloqueiam a conta por 15 minutos |
| Revogação | logout, troca de senha, reset administrativo e bloqueio revogam sessões |
| Auditoria | cadastro, aprovação, recusa, bloqueio, reset, exclusão e transferência gravam em `bank_audit` |
| Papéis | `USER`, `ADMIN`, `SYSTEM`; rotas `/admin/*` exigem `ADMIN` |

O administrador pode **aprovar, recusar, bloquear, desbloquear, excluir** (saldo zero) e **gerar senha temporária**. A senha temporária aparece **uma única vez** na resposta da API; o usuário entra com ela e o sistema marca `must_change_password`, exigindo a troca antes de operar.

## 3. Transferência interna real

```
POST /v1/bank/transfers
{
  "amount": "1250.00",
  "recipient": { "accountNumber": "0001/1000002-3" },
  "description": "Aluguel de outubro",
  "idempotencyKey": "pix-2026-10-31-001"
}
```

Sequência dentro de **uma transação SQL** (`BEGIN IMMEDIATE`):

1. valida conta de origem ativa e limites (por transferência e diário móvel de 24 h);
2. resolve o favorecido por **número de conta**, **CPF/CNPJ** ou **e-mail** — consulta exata, sem busca difusa;
3. recusa auto-transferência;
4. debita com guarda condicional (`balance_cents >= valor`); se não houver saldo, nada acontece;
5. credita o favorecido;
6. grava a transferência com `E2E ID`, chave de idempotência e hash da requisição;
7. grava **duas partidas** em `bank_ledger` com `balance_after_cents`;
8. grava evento no outbox e trilha de auditoria.

**Idempotência**: repetir a mesma chave com o mesmo conteúdo devolve a transferência original; repetir a chave com conteúdo diferente é recusado. Isso impede duplicidade em retry de rede.

**Limites padrão**: R$ 50.000,00 por transferência e R$ 100.000,00 por dia móvel por conta. A tesouraria tem limites próprios e apenas credita.

**Comprovante** (`GET /v1/bank/transfers/:id`): partes mascaradas, as duas partidas do razão, `balanced: true` e hash de integridade dos dados. Divergência de hash significa adulteração.

**Aporte de tesouraria** (`POST /v1/bank/demo/credit`): existe **somente em demo**, com teto de R$ 10.000,00 por aporte e R$ 50.000,00 por dia por conta, e é rotulado como aporte demo no extrato. Não é receita nem transferência de terceiro.

## 4. Capital demo e carteira internacional

Dois caminhos permitem saldos de laboratório sem inventar número na tela. Ambos são **exclusivos de demo**, exigem `ADMIN` com senha já trocada e gravam evento no outbox e trilha de auditoria.

**Capital em BRL** (`POST /v1/bank/demo/capital`): a contraparte é uma conta de capital do sistema (`Capital de laboratório (demo)`, agência `0000`, número `99999999`), que nasce com R$ 100.000.000.000,00 de abertura. O aporte debita a conta de capital, credita o titular e grava duas partidas em `bank_ledger` com canal `CAPITAL`; o extrato mostra **Aporte de capital demo**. Teto de R$ 500.000.000.000,00 por operação, respeitando `Number.isSafeInteger`, com idempotência de 8 a 120 caracteres. O balanço continua fechado.

**Carteira USD** (`GET /v1/bank/fx/wallets`, `POST /v1/bank/demo/fx`): a conta corrente do núcleo é só BRL e `bank_accounts.user_id` é único, então a moeda estrangeira vive em um **livro próprio**:

| Tabela | Papel |
|---|---|
| `bank_fx_wallets` | carteira por titular e moeda (`USD`), saldo em centavos com `CHECK >= 0` |
| `bank_fx_transfers` | transferência entre carteiras com idempotência por iniciador |
| `bank_fx_entries` | duas partidas por transferência com `balance_after_cents` |

A tesouraria USD (`bank_fx_system_usd`) abre com US$ 100.000.000.000,00 de capital demo e é a única origem dos aportes demo; versões anteriores com abertura menor são reconciliadas para cima com trilha de auditoria. O limite por operação é US$ 20.000.000.000,00, o memo padrão é **Aporte internacional demo** e o extrato por moeda devolve contraparte, direção, saldo após cada lançamento e E2E. **Não existe câmbio, remessa internacional, correspondente no exterior nem conversão BRL↔USD** — é um livro demo separado, rotulado assim na API e na interface.

**Script de saldo-alvo** (`npm run demo:balance`): recebe `--document`, `--email` ou `--user-id` e `--brl`/`--usd`, calcula a diferença até o alvo e credita apenas o que falta. Nunca debita, recusa produção e encerra com erro se o ledger divergir.

```bash
npm run demo:balance -- --document 34259998854 --brl 2000000000 --usd 3000000000
```

## 5. Extrato e score

- `GET /v1/bank/statement` devolve lançamentos com direção (`IN`/`OUT`), contraparte mascarada, valor, saldo após cada lançamento, descrição, E2E e canal (`INTERNAL`, `PIX`, `CREDIT`, `CREDIT_PAYMENT`, `PDV`, `CAPITAL`).
- `GET /v1/bank/statement.csv` exporta com BOM e separador `;` para abrir direto no Excel brasileiro.
- `GET /v1/bank/credit/score` calcula 0–1000 com fatores explícitos: tempo de conta (até 200), saldo (300), movimentação em 90 dias (250), volume (150) e ausência de bloqueio (100), além de limite sugerido. O retorno inclui o aviso de que é score interno e **não** consulta a bureau.
- O mesmo score define a faixa e a taxa do crédito; linha, contratos e PDV estão em [CREDITO.md](CREDITO.md).

## 6. Compatibilidade em português

Para consultas SQL e integrações legadas existem views:

```sql
-- contas
SELECT id, user_id, branch, number, balance_cents, status FROM bank_accounts;

-- transacoes
SELECT id, debit_account_id, credit_account_id, amount_cents, status, created_at FROM bank_transfers;

-- saldo por conta (dupla entrada)
SELECT a.id, SUM(l.amount_cents * CASE l.direction WHEN 'CREDIT' THEN 1 ELSE -1 END) AS saldo_cents
  FROM bank_accounts a JOIN bank_ledger l ON l.account_id = a.id
 GROUP BY a.id;
```

## 7. API

| Método | Rota | Quem |
|---|---|---|
| `GET` | `/v1/bank/status` | público — demo, bootstrap, contagem |
| `POST` | `/v1/bank/auth/register` | público |
| `POST` | `/v1/bank/auth/login` | público |
| `POST` | `/v1/bank/auth/logout` | autenticado |
| `POST` | `/v1/bank/auth/change-password` | autenticado |
| `GET` | `/v1/bank/me` | autenticado — perfil, conta e CSRF |
| `GET` | `/v1/bank/account` | autenticado |
| `GET` | `/v1/bank/statement` · `/statement.csv` | autenticado |
| `GET` | `/v1/bank/recipients/lookup?type=accountNumber\|document\|email&q=` | autenticado |
| `POST` | `/v1/bank/transfers` | autenticado |
| `GET` | `/v1/bank/transfers/:id` | autenticado (partes) |
| `GET` | `/v1/bank/credit/score` | autenticado |
| `GET` | `/v1/bank/credit/line` | autenticado — score, faixa e limite disponível |
| `POST` | `/v1/bank/credit/quote` | autenticado — simulação com agenda |
| `GET/POST` | `/v1/bank/credit/contracts` · `/contracts/:id` | autenticado — contratos e agenda |
| `POST` | `/v1/bank/credit/contracts/:id/installments/:number/pay` | autenticado — pagamento de parcela |
| `POST` | `/v1/bank/credit/contracts/:id/settle` | autenticado — liquidação antecipada |
| `GET` | `/v1/bank/credit/contracts.csv` | autenticado |
| `GET/POST` | `/v1/bank/pdv/sales` · `/pdv/sales/:id/fiscal` · `/:id/xml` | autenticado, demo |
| `GET` | `/v1/bank/pdv/sales.csv` | autenticado |
| `POST` | `/v1/bank/demo/credit` | autenticado, demo |
| `POST` | `/v1/bank/demo/capital` | admin, demo — aporte de capital em BRL com idempotência |
| `GET` | `/v1/bank/fx/wallets` | autenticado — carteiras internacionais |
| `GET` | `/v1/bank/fx/wallets/:currency/statement` | autenticado — extrato da carteira (`USD`) |
| `POST` | `/v1/bank/demo/fx` | admin, demo — aporte internacional em USD |
| `GET` | `/v1/bank/admin/overview` | admin |
| `GET` | `/v1/bank/admin/users?status=&q=` | admin |
| `GET/DELETE` | `/v1/bank/admin/users/:id` | admin |
| `POST` | `/v1/bank/admin/users/:id/approve` | admin |
| `POST` | `/v1/bank/admin/users/:id/reject` | admin |
| `POST` | `/v1/bank/admin/users/:id/block` | admin |
| `POST` | `/v1/bank/admin/users/:id/unblock` | admin |
| `POST` | `/v1/bank/admin/users/:id/reset-password` | admin |
| `GET` | `/v1/bank/admin/audit` | admin |

Todas essas rotas também existem no Worker Cloudflare, com exceção dos comprovantes em R2 e dos insights de IA, que são exclusivos do edge. Veja [CLOUDFLARE.md](CLOUDFLARE.md).

## 8. Interface

`public/bank.html` em `/bank`: login e cadastro, painel com saldo e limite, transferência guiada com busca de favorecido, extrato com saldo corrente, score, **crédito** (simulação, contratação, agenda, pagamento e liquidação), **carteira USD** (saldo e livro próprios), **aporte de capital demo** (BRL ou USD, visível só para admin em demo), segurança (troca de senha) e console administrativo com aprovação, bloqueio, exclusão, reset de senha e auditoria. Tema Inter laranja + neon verde sobre fundo navy.

A aba **Pix** registra chaves do titular, gera BR Code EMV e paga por chave; os detalhes estão em [PIX.md](PIX.md). A aba **Crédito** opera antecipação e empréstimo com agenda de parcelas — contrato em [CREDITO.md](CREDITO.md). O console operacional em `/core` usa as mesmas APIs para KPIs, contas, chaves, transferência real, validador FEBRABAN, crédito, PDV/NFC-e, carteira USD e trilha de eventos.

## 9. Testes

`tests/bank.test.ts` cobre o serviço e o fluxo de API: cadastro pendente → aprovação → login → conta, transferência real com saldo antes/depois, idempotência, extrato, score, reset de senha, bloqueio e exclusão com saldo. `tests/bank-credit.test.ts` cobre crédito, parcelas, liquidação antecipada, PDV/NFC-e e exportações. `tests/bank-fx.test.ts` cobre o capital demo (lastro, replay, conflito de idempotência, teto e modo demo), o lastro da tesouraria USD, extrato, replay e bloqueio de moeda não suportada, além do gating de administrador nas rotas novas. Rode:

```bash
npm test
```

## 10. O que é real

| Item | Status |
|---|---|
| Cadastro, aprovação e sessão | real, persistido |
| Hash de senha e revogação | real |
| Transferência entre contas do banco | real e atômica |
| Extrato e comprovante | derivados do livro-razão real |
| Chaves Pix e pagamento por chave | reais no cadastro e no extrato (`channel = PIX`); resolução local, sem DICT/SPI |
| Dígito FEBRABAN da conta | real, com convenção `0` e `X` legado |
| Score | determinístico, interno, não-bureau |
| Crédito (antecipação e empréstimo) | real e atômico, com capital próprio da tesouraria; **sem registro no SCR/BACEN** |
| Agenda, parcela e liquidação antecipada | reais, com taxa congelada e desconto de juros futuros |
| PDV / NFC-e | venda e liquidação reais no ledger; **adquirente e SEFAZ simulados, somente demo** |
| Aporte de tesouraria | demo, rotulado |
| Capital demo (BRL) | real no ledger, contraparte de capital, apenas demo e rotulado |
| Carteira USD | livro próprio real de dupla entrada com tesouraria USD; **demo, sem câmbio ou remessa** |
| Saldo-alvo via CLI | real e idempotente, credita só a diferença e nunca debita |
| Transferência para outro banco | **não existe** — exige PSP/SPI |
| Emissão de cartão, câmbio, mora e renegociação | roadmap |
