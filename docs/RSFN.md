# RSFN · PAG0004 — remessa interbancária com XML validado

O xPartner Bank emite e recebe mensagens no subconjunto **PAG0004** da RSFN (Rede do Sistema Financeiro Nacional). A mensagem é gerada em XML no namespace `http://bcb.gov.br`, validada contra um XSD fechado, conferida campo a campo e **contabilizada em partidas dobradas** no mesmo livro-razão das transferências internas.

O que existe aqui é o contrato e a contabilidade. O que **não** existe: transmissão real ao Banco Central. Isso exige participação na RSFN, certificado ICP-Brasil e um conector mTLS homologado — nenhum desses três está implementado neste repositório, e a interface diz isso em toda tela.

## 1. Estrutura da mensagem

```
DOC                                   (xmlns="http://bcb.gov.br")
├── BC                                (bloco de controle)
│   ├── CodMsg            PAG0004
│   ├── NumCtrlIF         E + ISPB(8) + AAAAMMDD(8) + HHMMSS(6) + sequência(3) = 26 caracteres
│   ├── ISPBEmissor       8 dígitos
│   ├── ISPBDestinatario  8 dígitos, diferente do emissor
│   └── DtMovto           AAAA-MM-DD, data de calendário válida
└── SIS
    └── PAG0004
        ├── CodCliEmissor           código do cliente no emissor
        ├── CNPJ_CPFEmissor         CPF (11) ou CNPJ (14) com dígito verificador
        ├── NomCliEmissor           1 a 80 caracteres
        ├── ContaDestinatario       1 a 12 dígitos
        ├── AgenciaDestinatario     1 a 6 dígitos
        ├── CNPJ_CPFDestinatario    CPF ou CNPJ com dígito verificador
        ├── NomCliDestinatario      1 a 80 caracteres
        ├── VlrLanc                 decimal com duas casas (ex.: 1500.00)
        └── FinalidadeTransacao     0001
```

O XSD publicado pelo próprio serviço fica em `GET /v1/bank/rsfn/pag0004.xsd` e o arquivo de referência em [`db/rsfn-pag0004.xsd`](../db/rsfn-pag0004.xsd). Todos os elementos são obrigatórios, na ordem declarada, sem atributos além do namespace.

## 2. Módulo 11 nos documentos

CPF e CNPJ passam pelo mesmo validador do cadastro de clientes (`src/domain/documents.ts`): pesos do módulo 11, resto `10` ou `11` tratado como `0`. Documento com dígito errado, tamanho diferente de 11/14 ou sequência repetida (`111.111.111-11`) é recusado com `RSFN_INVALID` e a lista de problemas por campo.

O `NumCtrlIF` também é estrutural: o parser confere o formato e exige que os 8 dígitos embutidos correspondam ao `ISPBEmissor` e que a data embutida seja a mesma do `DtMovto`. Mensagem com controle forjado não passa.

## 3. Parser seguro

`parsePag0004Xml` (`src/domain/rsfn.ts`) não usa parser XML genérico com resolução de entidades. Ele tokeniza um subconjunto fechado e recusa:

| Ataque / desvio | Resultado |
|---|---|
| DOCTYPE, ENTITY, CDATA, comentário ou instrução de processamento extra | `XML_PROIBIDO` |
| Elemento fora da whitelist (`DOC`, `BC`, `SIS`, `PAG0004` e campos) | `XML_ELEMENTO_DESCONHECIDO` |
| Atributo em qualquer elemento | `XML_ATRIBUTO_PROIBIDO` |
| Namespace errado ou ausente | `XML_NAMESPACE` |
| Elemento duplicado ou fora do pai correto | `XML_DUPLICADO` / `XML_ESTRUTURA` |
| Elemento auto-fechado | `XML_ESTRUTURA` |
| Entidade fora da whitelist (`amp`, `lt`, `gt`, `quot`, `apos`) | `XML_ENTIDADE` |
| Caractere de controle no texto | `XML_CARACTERE` |
| Raiz diferente de `DOC` | `XML_RAIZ` |
| `VlrLanc` fora de `^\d{1,12}\.\d{2}$` | `RSFN_INVALID` |

O SHA-256 do XML é calculado antes de qualquer validação e guardado com a mensagem. O mesmo hash aparece no comprovante, no evento `bank.rsfn.sent` e na auditoria, então dá para provar que o XML contabilizado é o XML recebido.

## 4. Ciclo contábil

```
cliente ──débito──► câmara RSFN (bank_acc_rsfn)      status SENT
                                         │
                        aceite da câmara │ recusa da câmara
                                         ▼
                              SETTLED              REJECTED
                              (valor fica         (câmara devolve:
                               liquidado)          débito câmara →
                                                   crédito cliente)
```

- **Débito do cliente** e **crédito da câmara**: duas partidas no mesmo `bank_transfers`, com `kind = INTERNAL` e `end_to_end_id = NumCtrlIF`. A coluna `bank_rsfn_messages.transfer_id` amarra a mensagem ao lançamento.
- **Recusa**: novo par de partidas devolve o valor ao cliente e cria uma segunda transferência com descrição `Estorno RSFN <NumCtrlIF> · <código>`. Nada é apagado; o histórico mostra a ida e a volta.
- **Limites**: limite por transferência e limite diário da conta valem antes do débito, iguais aos da transferência interna. O teto por mensagem é R$ 1.000.000,00 (`RSFN_MAX_CENTS`).
- **Idempotência**: `Idempotency-Key` de 8 a 120 caracteres; o serviço guarda o hash do payload. Repetir com o mesmo payload devolve `200` com `x-idempotent-replayed: true`; repetir com payload diferente devolve `409`.
- **Extrato**: os lançamentos vinculados aparecem com `kind = RSFN`, rótulo `RSFN · PAG0004` e a contraparte real (nome, documento, agência e conta de destino), não a câmara.

O `SYSTEM` da câmara não entra no total de saldo dos clientes do console administrativo. Sem isso, a compensação inflaria os KPIs.

## 5. Endpoints

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| GET | `/v1/bank/rsfn/pag0004.xsd` | público | XSD do subconjunto usado pelo banco |
| GET | `/v1/bank/rsfn/config` | sessão | ISPB, modo demo, endpoint, certificados e notas |
| POST | `/v1/bank/rsfn/validate` | sessão | Valida um XML sem movimentar nada |
| POST | `/v1/bank/rsfn/transfers` | sessão | Cria a mensagem, gera XML, debita e credita a câmara |
| GET | `/v1/bank/rsfn/messages` | sessão | Mensagens do titular |
| GET | `/v1/bank/rsfn/messages/{id}` | titular/admin | Detalhe com XML |
| GET | `/v1/bank/rsfn/messages/{id}/xml` | titular/admin | Download do XML (`application/xml`) |
| POST | `/v1/bank/rsfn/messages/{id}/ack` | admin, demo | Simula aceite ou recusa da câmara |
| GET | `/v1/bank/admin/rsfn/messages` | admin | Todas as mensagens do banco |

Exemplo de criação:

```bash
curl -s http://localhost:8080/v1/bank/rsfn/transfers \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: rsfn-demo-0001' \
  -d '{
    "amountCents": 150000,
    "description": "Pagamento de fornecedor",
    "destination": {
      "ispb": "87654321",
      "branch": "0001",
      "account": "000123456",
      "document": "98765432100",
      "name": "Fornecedor Exemplo Ltda"
    }
  }'
```

Resposta (recortada):

```json
{
  "message": {
    "numCtrlIf": "E9999999920261031...",
    "status": "SENT",
    "amountFormatted": "R$ 1.500,00",
    "xmlSha256": "…"
  },
  "xml": "<DOC xmlns=\"http://bcb.gov.br\">…</DOC>",
  "transfer": { "id": "btr_…", "status": "POSTED" },
  "account": { "balanceCents": 0 },
  "replayed": false
}
```

## 6. Retorno da câmara em demonstração

`POST /v1/bank/rsfn/messages/{id}/ack` com `{ "decision": "ACCEPT" }` marca a mensagem como `SETTLED`; com `{ "decision": "REJECT", "rejectionCode": "...", "rejectionReason": "..." }` estorna o valor ao cliente e marca `REJECTED`.

Regras do acknowledgement:

- Só existe em `DEMO_MODE`. Em produção a rota responde `RSFN_CONNECTOR_REQUIRED`.
- Exige `ADMIN`.
- A mensagem precisa estar em `SENT`; qualquer outro status devolve `409`.
- Código é sanitizado (`[A-Za-z0-9_.-]`, até 20 caracteres) e motivo perde caracteres de controle e corta em 200 caracteres.

Todo aceite e recusa grava evento (`bank.rsfn.settled` / `bank.rsfn.rejected`) e auditoria com ator, `NumCtrlIF` e transferência de estorno.

## 7. Configuração

| Variável | Obrigatória | Efeito |
|---|---|---|
| `RSFN_ISPB` | produção | ISPB de 8 dígitos. Em demo, ausente vira `99999999`. |
| `RSFN_ENDPOINT` | conector real | URL do conector RSFN (não usada nesta versão). |
| `RSFN_CERT_PATH` | conector real | Certificado ICP-Brasil (não lido nesta versão). |
| `RSFN_KEY_PATH` | conector real | Chave privada do certificado (não lida nesta versão). |
| `RSFN_CA_PATH` | conector real | Cadeia de CAs aceitas. |

`/v1/bank/rsfn/config` mostra `endpointConfigured` e `certificatesConfigured` a partir dessas variáveis. `transport` continua `SIMULATED` em qualquer cenário, porque o envio real não está implementado. O relatório `/v1/readiness` traz o item `pagamentos.rsfn` com status `PARTIAL` quando só o ISPB está definido e `MISSING` quando nem isso existe, listando exatamente o que falta.

## 8. O que falta para operar de verdade

| Bloco | Situação | Dependência |
|---|---|---|
| Mensagem PAG0004, XSD e validação | pronto | — |
| Contabilidade da remessa e do estorno | pronto | — |
| ISPB de participante | configuração | adesão à RSFN junto ao Banco Central |
| Certificado ICP-Brasil e chave privada | configuração | certificado da instituição, guardado em HSM/KMS |
| Conector mTLS homologado | **não implementado** | contrato com o Banco Central / provedor homologado |
| Retorno real da câmara | **não implementado** | conector acima |
| Reconciliação diária com a câmara | **não implementado** | arquivos de retorno da RSFN |

`db/schema.rsfn.postgres.sql` traz a tabela equivalente para PostgreSQL com os mesmos `CHECK`s da migração v6 do SQLite.
