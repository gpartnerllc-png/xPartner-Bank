# Pix · chaves, BR Code e pagamento por chave

O xPartner Bank registra **chaves Pix reais no cadastro do cliente**, gera **BR Code EMV com CRC16** e executa **pagamento por chave** com liquidação interna em partidas dobradas. A chave não é um adorno de tela: ela resolve para uma conta ativa, e a transferência iniciada por chave entra no extrato como **Pix enviado/recebido** (`channel = PIX`).

O que ainda **não** existe: conexão com o **DICT** e o **SPI** do Banco Central. A resolução de chave é local e o dinheiro circula entre contas do xPartner Bank. Para sair para outro banco, veja [GO_LIVE](GO_LIVE.md).

## 1. Chaves Pix

| Tipo | Normalização | Regra de titularidade |
|---|---|---|
| `CPF` | só dígitos | precisa ser **exatamente** o CPF do titular, com módulo 11 válido |
| `CNPJ` | só dígitos | precisa ser **exatamente** o CNPJ do titular, com módulo 11 válido |
| `EMAIL` | minúsculas, até 77 caracteres | e-mail válido; sem OTP nesta versão |
| `PHONE` | `+55` + DDD + número (10/11 dígitos) | celular/fixo válido; sem OTP nesta versão |
| `EVP` | UUID v4 gerado pelo servidor | chave aleatória; valor informado pelo cliente é ignorado |

Regras aplicadas pelo `BankPixService`:

- **Máximo de 5 chaves ativas** por usuário (`MAX_ACTIVE_PIX_KEYS`). A sexta retorna `PIX_KEY_LIMIT` (409).
- **Unicidade** por `(key_type, key_value)` entre chaves não excluídas. Duplicata retorna `PIX_KEY_EXISTS` (409).
- **Remoção é lógica** (`status = DELETED`, `deleted_at`), preservando histórico; a chave pode ser recriada depois.
- **Titularidade**: chave de outro usuário não pode ser removida (`FORBIDDEN`); chave CPF/CNPJ de terceiro é recusada com `PIX_KEY_OWNERSHIP`.
- **Mascaramento**: a API devolve `masked` (ex.: `342.***.***-54`, `an**@xpartner.test`, `+55 ** *****-5432`). O valor completo só aparece para o próprio titular.
- **Limite por chave**: não há limite próprio; valem os limites da conta (por transferência e diário em janela de 24 h).
- **Auditoria**: criação, remoção e uso da chave geram trilha em `bank_audit`.

## 2. BR Code (EMV® QRCPS)

O payload segue o padrão EMV de QR Code de pagamento:

| Tag | Conteúdo |
|---|---|
| `00` | `01` (formato) |
| `26` | conta Pix: GUI `br.gov.bcb.pix`, chave e descrição opcional |
| `52` | `5499` (MCC) |
| `53` | `986` (BRL) |
| `54` | valor em reais, **opcional** (ausente = código estático, quem paga informa o valor) |
| `58` | `BR` |
| `59` | nome do titular (sem acentos, até 25) |
| `60` | cidade (`SAO PAULO`) |
| `62` | `05` + txid (`XP` + 22 caracteres do UUID) |
| `63` | CRC16/CCITT-FALSE calculado sobre todo o payload anterior |

Exemplo real gerado para o CPF `342.599.988-54` com R$ 123,45:

```
00020126330014br.gov.bcb.pix0111342599988545204549953039865406123.455802BR5925CRISTIAN RIBEIRO FLORENCI6009SAO PAULO62260522XP0A2DEAA71ECB4F9CB51363041138
```

O CRC (`1138`) é o último campo e pode ser conferido com `crc16(payload.slice(0, -4))`. O endpoint de validação do domínio Pix (`validatePixPayload`) aceita esse payload e recomputa o CRC.

Gerar BR Code **não movimenta saldo**: é apenas uma instrução de pagamento. A liquidação acontece quando alguém paga pela chave dentro do banco.

## 3. Pagamento por chave

```
1. Usuário informa a chave do favorecido
2. resolveRecipient(chave) → conta ativa + titular (mascarado)
3. bank.transfer({ recipient, channel: 'PIX' })
4. BEGIN IMMEDIATE: débito + crédito + comprovante + evento outbox
5. Extrato mostra channel PIX e rótulo “Pix enviado” / “Pix recebido”
```

- Auto-transferência é recusada (a própria conta não é destino válido).
- A chave precisa estar `ACTIVE`; chave de usuário bloqueado, pendente ou excluído não resolve.
- O comprovante inclui o bloco `pix` com `keyMasked`, `keyType`, `name` e `documentMasked`.
- Idempotência por `idempotencyKey` (ou cabeçalho `Idempotency-Key`) impede débito duplicado.
- O destinatário vê o lançamento como **Pix recebido** com o mesmo valor e saldo após a partida.

## 4. Dígito verificador FEBRABAN (módulo 11)

O número da conta tem **7 dígitos de base + 1 dígito verificador**:

- pesos 2..9 da direita para a esquerda;
- `DV = 11 - (soma % 11)`;
- resultado `10` ou `11` vira `0` (é o caso que o console antigo tratava como `X`);
- `X` continua aceito como forma **legada** somente quando o DV esperado é `0`.

`validateAccountNumber(base, digit)` retorna `{ base, expectedDigit, providedDigit, valid, legacyX }`. Exemplos:

| Entrada | Esperado | Observação |
|---|---|---|
| base `1000004` + DV `6` | válido | conta 0001 / 1000004-6 |
| base `123456` + `X` | válido, `legacyX: true` | DV esperado é `0` |
| base `123456` + `9` | inválido | DV correto é `0` |

## 5. API

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/v1/bank/pix/keys` | Chaves do titular com `masked`, limite e dados do titular |
| `POST` | `/v1/bank/pix/keys` | Registra chave `{ type?, value, label? }` |
| `POST` | `/v1/bank/pix/keys/evp` | Gera chave aleatória (UUID v4) |
| `DELETE` | `/v1/bank/pix/keys/:id` | Remove (soft delete) chave do titular |
| `GET` | `/v1/bank/pix/keys/:id/brcode?amountCents=` | BR Code EMV com valor opcional |
| `GET` | `/v1/bank/pix/lookup?key=` | Consulta chave ativa e devolve dados mascarados |
| `GET` | `/v1/bank/accounts/validate?number=` ou `?base=&digit=` | Valida DV FEBRABAN |
| `POST` | `/v1/bank/transfers` com `recipient.pixKey` | Transfere por chave e marca `channel: PIX` |
| `GET` | `/v1/bank/admin/pix/keys` | Todas as chaves com titular mascarado (admin) |

Erros relevantes: `PIX_KEY_EXISTS` (409), `PIX_KEY_LIMIT` (409), `PIX_KEY_OWNERSHIP` (422), `PIX_KEY_NOT_FOUND` (404), `PIX_SELF_TRANSFER` (422), `INVALID_AMOUNT` (422), `PASSWORD_CHANGE_REQUIRED` (403).

## 6. Interface

- **`/bank` → Pix**: lista de chaves com mascaramento, formulário CPF/CNPJ/e-mail/telefone/EVP, geração de BR Code com valor opcional, cópia do código e remoção.
- **`/bank` → Transferir → Chave Pix**: consulta o favorecido pela chave e mostra o comprovante com selo **PIX · chave**.
- **`/core`**: console operacional conectado às mesmas APIs — KPIs, contas, chaves Pix, transferência real, validador de DV e trilha de eventos.

## 7. O que falta para produção

| Item | Situação |
|---|---|
| DICT / SPI | **não conectados**; resolução de chave e liquidação são internas |
| Validação de e-mail/telefone | sem OTP nesta versão |
| Portabilidade e reivindicação de chave | não implementadas |
| Devolução (MED) e bloqueio cautelar | não implementados |
| QR Code renderizado | a API entrega o payload EMV; a imagem fica a cargo do cliente |
| Conciliação com PSP | depende de contrato e credenciais (`PIX_PSP_*` em [GO_LIVE](GO_LIVE.md)) |

A fronteira é explícita: tudo o que está acima é **contabilidade e pagamento internos reais**, não uma simulação de tela. Nenhum valor sai do xPartner Bank enquanto não houver PSP/SPI homologado.
