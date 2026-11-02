# Checkout mTLS · maquininhas com certificado

O xPartner Bank aceita vendas de terminais autenticados por **TLS mutual**: a maquininha apresenta um certificado emitido pela CA do banco, o servidor valida a cadeia, lê o **CN = serial do terminal**, confere o **fingerprint SHA-256** registrado e só então autoriza a venda pelo mesmo pipeline de risco, roteamento, ledger e NFC-e do `/v1/transactions`.

O listener mTLS é **separado** do HTTP principal. Sem os certificados configurados, o banco sobe normalmente em HTTP e o secure checkout fica desligado — não existe modo “meio mTLS”.

## 1. Como funciona

```
Maquininha ──TLS 1.3 com certificado de cliente──► :8443 /v1/secure-checkout
                                                        │
                                    CA do banco valida a cadeia
                                                        │
                                    CN = serial do terminal
                                                        │
                                    fingerprints SHA-256 conferem
                                                        │
                                    terminal ACTIVE + merchant dono
                                                        │
                                    idempotência + createSale
                                                        │
                                    risco · roteamento · ledger · NFC-e
```

- **Sem certificado**: o handshake é recusado pelo servidor (`rejectUnauthorized: true`). A requisição nem chega à aplicação.
- **Certificado de outra CA**: handshake recusado.
- **CN desconhecido**: HTTP 401 `UNAUTHORIZED`.
- **CN de terminal bloqueado**: HTTP 403 `FORBIDDEN`.
- **Fingerprint divergente**: HTTP 403 `FORBIDDEN`.
- **Terminal sem fingerprint cadastrado**: aceito em desenvolvimento; em produção (`NODE_ENV=production`) é recusado até o cadastro do fingerprint.

## 2. Configuração

```ini
MTLS_KEY_PATH=./certs/server-key.pem
MTLS_CERT_PATH=./certs/server-cert.pem
MTLS_CA_PATH=./certs/bank-ca-cert.pem
MTLS_PORT=8443
MTLS_REQUEST_CERT=true
MTLS_REJECT_UNAUTHORIZED=true
```

| Variável | Função |
|---|---|
| `MTLS_KEY_PATH` | chave privada do servidor |
| `MTLS_CERT_PATH` | certificado do servidor assinado pela CA do banco |
| `MTLS_CA_PATH` | CA que assinou os certificados das maquininhas |
| `MTLS_PORT` | porta HTTPS (padrão 8443) |
| `MTLS_HOST` | interface (padrão igual a `HOST`) |
| `MTLS_REQUEST_CERT` | exige certificado de cliente (padrão `true`) |
| `MTLS_REJECT_UNAUTHORIZED` | derruba handshake inválido (padrão `true`) |

Os três caminhos são obrigatórios em conjunto. Informar apenas um deles faz o processo falhar na inicialização — de propósito.

**Nunca versione `.pem`, `.key` ou a pasta `certs/`.** O `.gitignore` já bloqueia. Em produção, as chaves vão para KMS/HSM ou secret manager e o processo recebe apenas o caminho montado.

## 3. Gerando uma cadeia de teste

```bash
mkdir -p certs && cd certs

# CA do banco
openssl req -x509 -newkey rsa:2048 -nodes -keyout bank-ca-key.pem \
  -out bank-ca-cert.pem -days 365 -subj "/CN=XPARTNER Bank CA"

# Servidor
openssl req -newkey rsa:2048 -nodes -keyout server-key.pem \
  -out server.csr -subj "/CN=localhost"
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA bank-ca-cert.pem -CAkey bank-ca-key.pem \
  -CAcreateserial -out server-cert.pem -days 365 -extfile server.ext

# Terminal (CN = serial cadastrado na tabela terminals)
openssl req -newkey rsa:2048 -nodes -keyout terminal-key.pem \
  -out terminal.csr -subj "/CN=XP-TAP-0001"
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in terminal.csr -CA bank-ca-cert.pem -CAkey bank-ca-key.pem \
  -CAcreateserial -out terminal-cert.pem -days 365 -extfile client.ext

# Fingerprint que deve ser gravado no terminal
openssl x509 -in terminal-cert.pem -noout -fingerprint -sha256
```

Cadastre o fingerprint (hex, sem dois-pontos) no terminal:

```sql
UPDATE terminals
   SET cert_fingerprint = 'a1b2c3d4e5f60718...'
 WHERE serial = 'XP-TAP-0001';
```

O seed de demonstração já registra fingerprints fictícios para `XP-TAP-0001` e `XP-POS-0002`; para usar certificados reais, atualize esses valores.

## 4. Contrato da rota

```http
POST /v1/secure-checkout
Content-Type: application/json
Idempotency-Key: venda-2026-10-31-0001
```

```json
{
  "amountCents": 7500,
  "method": "DEBIT",
  "paymentToken": "tok_master_5123_ab12cd34ef56",
  "description": "Venda no balcão",
  "installments": 1,
  "items": [{ "name": "Café", "ncm": "09012100", "quantity": 2, "unitPriceCents": 3750 }]
}
```

Resposta `201`:

```json
{
  "status": "APPROVED",
  "secured_by": "mTLS",
  "terminal": {
    "id": "trm_tap_demo",
    "serial": "XP-TAP-0001",
    "certificate_fingerprint": "a1b2c3d4e5f60718...",
    "registered_fingerprint": "a1b2c3d4e5f60718..."
  },
  "transaction": { "id": "txn_...", "amountCents": 7500, "status": "APPROVED" },
  "payment": { "nsu": "...", "authorizationCode": "...", "feeCents": 141, "netCents": 7359 },
  "risk": { "score": 18, "decision": "APPROVE", "reasons": [] },
  "fiscal": { "status": "PENDING", "note": "NFC-e sendo emitida em segundo plano..." }
}
```

- `paymentToken` é obrigatório para cartão; PAN em claro continua recusado com `PAN_NOT_ACCEPTED`.
- `Idempotency-Key` de 8 a 128 caracteres. Replay idêntico devolve a resposta original com `x-idempotent-replayed: true`; payload diferente com a mesma chave retorna `CONFLICT`.
- O CN do certificado pode vir como `XP-TAP-0001`, `terminal:XP-TAP-0001` ou `device:XP-TAP-0001`.

## 5. Testes

`tests/mtls.test.ts` cobre:

1. configuração parcial de mTLS falha;
2. CN → serial, normalização de fingerprint e resolução do terminal;
3. checkout real com idempotência e recusa de payload divergente;
4. handshake TLS real: certificado válido aprova, certificado de CN desconhecido recebe 401 e conexão **sem** certificado é derrubada no handshake.

O teste 4 gera CA, servidor e clientes temporários com `openssl`; se o binário não existir, o teste é marcado como `skip` em vez de falhar.

```bash
node --test tests/mtls.test.ts
```

## 6. Limites e produção

- **Revogação**: não há CRL/OCSP configurado. A retirada de um terminal deve ser feita por `UPDATE terminals SET status='BLOCKED'` (a rota passa a devolver 403) e pela rotação da CA.
- **Rotação**: troque a CA com sobreposição (`ca` aceita lista) e atualize os certificados dos terminais antes de remover a antiga.
- **HSM**: em produção a chave do servidor deve viver em HSM/KMS; o arquivo local é aceitável apenas em desenvolvimento.
- **Proxy**: se o TLS for terminado antes do Node, o certificado do cliente precisa chegar por header confiável e o proxy deve ser a única origem aceita. Este projeto **não** confia em header para decidir mTLS: quando configurado, exige o handshake no próprio listener.
- **Escopo**: o secure checkout autoriza vendas no xPartner Bank; não substitui certificação PCI nem conexão real com adquirentes.
