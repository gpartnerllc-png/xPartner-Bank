# Segurança · xPartner Bank

Este documento separa explicitamente **o que a implementação faz hoje**, **o que é simulado** e **o que é obrigatório antes de operar dinheiro real**.

## 1. Escopo e postura

- O sistema foi desenhado para reduzir o escopo PCI: o servidor **não recebe, não processa e não armazena PAN**.
- Todas as decisões de segurança são centralizadas no kernel (`src/kernel/crypto.ts`) e na borda (`src/api/security.ts`).
- O modo demo é bloqueado em `NODE_ENV=production` por configuração: sem simuladores, sem token de desenvolvimento, sem seed.

## 2. Captura e P2PE

### Hoje (referência executável)

- A API aceita somente tokens no formato `tok_<bandeira>_<final4>_<hash>`.
- Qualquer entrada que se pareça com PAN (`4111 1111 1111 1111`) é recusada com `422 PAN_NOT_ACCEPTED`.
- O token é resolvido para bandeira, final4 e um fingerprint HMAC-SHA-256 truncado; o identificador do cartão não é reversível.
- `devTokenFor` existe exclusivamente para o simulador demo e deriva o hash de um segredo fixo de desenvolvimento.

### Produção obrigatória

1. **Apple Tap to Pay / Google POS SDK** no dispositivo, com leitura isolada no Secure Enclave / Android Keystore.
2. **DUKPT**: chave única por transação derivada no HSM; o app nunca vê a chave mestra.
3. **HSM homologado PCI** para descriptografia dos blocos e tradução para ISO 8583 junto à adquirente.
4. Token de rede (network tokenization) quando a bandeira oferecer; reduz ainda mais o escopo.
5. Atestação de dispositivo (Play Integrity / DeviceCheck) antes de aceitar a captura.

> O servidor desta entrega jamais deve ser apontado para um adquirente real enquanto o caminho de captura não for substituído por SDK + HSM.

## 3. Identidade do terminal

### HMAC de dispositivo

Cada requisição de venda envia:

```
x-device-id, x-timestamp, x-nonce, x-signature
x-signature = HMAC-SHA256(deviceSecret, `${timestamp}.${nonce}.${rawBody}`)
```

Controles aplicados:

- Janela de tempo configurável (`HMAC_WINDOW_SECONDS`, padrão 300s).
- Nonce de uso único em cache com TTL; replay devolve `401`.
- Comparação em tempo constante.
- Corpo bruto assinado (não o JSON re-serializado), impedindo divergência de canonicalização.
- Terminal precisa existir e estar `ACTIVE`.

### mTLS

- Em produção, a ausência de `x-client-cert-fingerprint` é rejeitada.
- O fingerprint apresentado é comparado ao `cert_fingerprint` cadastrado no terminal; divergência devolve `403`.
- A terminação TLS deve ocorrer em load balancer/ingress que propague o fingerprint do certificado do cliente de forma confiável (não aceitar header de cliente externo sem sanitização no proxy).

## 4. Sessões e tokens

- Tokens Bearer no formato `v1.<payload>.<assinatura>`, HMAC-SHA-256 com segredo derivado da chave mestra.
- Escopos (`demo:read`, `demo:write`) validados por rota.
- TTL configurável; expiração verificada no servidor.
- Token de estabelecimento não acessa recursos de outro estabelecimento (`assertMerchantScope`).

## 5. Proteções de API

| Controle | Implementação |
|---|---|
| Rate limiting | janela deslizante por dispositivo/IP, configurável |
| Corpo máximo | 256 KB |
| Idempotência | chave + hash do corpo; replay seguro e conflito explícito |
| Headers | `nosniff`, `DENY`, `no-referrer`, CSP restritiva, `no-store` em `/v1` |
| Erros | mensagens sem stack trace para o cliente; stack apenas em log interno |
| Logs | redaction de `authorization`, `token`, `pan`, `signature`, segredos |
| Auditoria | `audit_log` para venda, recusa, nota e antecipação |

CSP do dashboard permite `inline` scripts/estilos porque a UI é single-file; em produção com assets separados, remover `unsafe-inline`.

## 6. Segredos e criptografia

- `XPARTNER_MASTER_KEY` é a raiz: dela derivam segredo de token, segredo de webhook e segredo por terminal.
- Produção exige ≥ 32 caracteres e rejeita o valor padrão de desenvolvimento.
- Em nuvem: KMS/Secrets Manager com rotação; nunca variável em texto no repositório.
- Chaves de dispositivo devem migrar para HSM; o ideal é que nem a aplicação consiga exportá-las.
- Certificado fiscal A1 deve residir em KMS/HSM com uso auditado; a assinatura de desenvolvimento gera chave RSA efêmera em memória e **não é válida na SEFAZ**.

## 7. Webhooks Pix

- Assinatura `HMAC-SHA256(providerSecret, `${timestamp}.${rawBody}`)`.
- Janela de 300 segundos e comparação em tempo constante.
- O processamento é idempotente no domínio: pagamento repetido devolve o mesmo estado.

## 8. Modelo de ameaças (resumo)

| Ameaça | Mitigação atual | Endurecimento de produção |
|---|---|---|
| PAN interceptado no app | token P2PE; servidor recusa PAN | SDK de captura + DUKPT + HSM |
| Replay de requisição assinada | nonce + janela de tempo | nonce distribuído (Redis) |
| Requisição duplicada por retry | idempotência com hash do corpo | mesma lógica com TTL e storage durável |
| Terminal clonado | HMAC derivado por terminal | atestação + mTLS + rotação de chave |
| Token vazado | TTL curto, escopo e merchant scope | rotação, audience, revogação central |
| Ataque de força bruta / flood | rate limit por chave | WAF + rate limit distribuído na borda |
| Fraude por cartão testado em vários terminais | grafo de fan-out e links sinalizados | feature store + Neo4j em tempo real |
| Nota fiscal adulterada | XML assinado e chave com DV | XMLDSig ICP-Brasil + certificado em HSM |
| Webhook forjado | HMAC + janela | mTLS com o PSP + allowlist de IP |
| Boleto ou linha digitável adulterados | DV geral mod-11 e DVs de campo mod-10 validados na entrada | mesma checagem + registro/baixa no PSP |
| Cobrança paga em duplicidade | transação única por cobrança, baixa idempotente e `409` quando já paga | idempotência durável e conciliação automática |
| Link público enumerado | código alfanumérico de 10 posições, escopo restrito ao próprio link e rate limit | código com entropia maior e WAF |
| Checkout demo usado em produção | `POST /pay` público exige `DEMO_MODE=true` e a UI sinaliza o ambiente | desligar demo e usar captura real do PSP |
| Documento pessoal exposto | apenas máscara na API/UI; íntegra restrita à conciliação | tokenização de PII e criptografia em repouso |
| Consentimento usado fora do escopo | tipo exato exigido por operação (`CONSENT_SCOPE_MISMATCH`) | escopos assinados no diretório e validação por operação |
| Conta externa exposta | agência/número e documento do titular mascarados | tokenização de conta e PII com criptografia em repouso |
| Débito externo forjado | liquidação restrita ao demo, consentimento ativo e auditoria | webhook assinado do PSP + conciliação SPI |
| Revogação não propaga | revogação cancela débitos agendados e pagamentos pendentes na mesma transação | revogação por evento no diretório |
| Aporte/resgate sem lastro | toda movimentação é grupo de dupla entrada contra `MERCHANT_AVAILABLE` | custódia segregada e conciliação diária |
| IR de provento não recolhido | retenção calculada e provisionada em `TAX_PAYABLE` com auditoria | apuração fiscal e obrigações acessórias |
| Vazamento em log | redaction de chaves sensíveis | DLP e retenção mínima |
| Royalty pago sem consentimento | bioativo `PENDING`/`REVOKED` bloqueia licença | consentimento jurídico e revogação propagada |
| Biometria ou genoma exposto | não há coleta nem armazenamento | manter fora de escopo por decisão de produto |
| Agente executa acima do limite | allowlist, limite por ação, limite diário e revisão humana | executor separado com aprovação e limites de exposição |
| Âncora adulterada | recálculo integral da cadeia detecta e aponta a altura | ancoragem periódica em rede pública com quórum |
| Contrato de referência usado em produção | não compilado, não auditado, não implantado | Foundry, auditoria, multisig e timelock |

## 9. Tokenização, bioativos e agentes

- **Nenhum dado biológico é coletado.** O core persiste somente `consentHash` e `datasetHash` SHA-256; o consentimento em texto existe apenas no payload de registro e não é armazenado.
- **Admissão obrigatória.** PENDING ou REVOKED não paga royalty (`BIO_NOT_ADMITTED`); a aprovação é uma proposta DAO com quórum e maioria, ancorada.
- **Royalty limitado.** Teto de 30% (3000 bps) definido em validação e schema, sem promessa de renda.
- **Agentes sem execução.** A avaliação devolve `APPROVE`, `REVIEW` ou `BLOCK`; não existe chamada que mova dinheiro a partir dessa decisão sem um fluxo humano/operacional.
- **Provas honestas.** Credenciais usam compromisso com salt não persistido e Merkle de inclusão seletiva; o motor Aladdin acrescenta **Groth16/BN254 real** para `patrimônio ≥ limiar`, com verificador gerado e cerimônia de demonstração. Nenhum dos dois caminhos prova identidade ou KYC.
- **Contratos.** `contracts/` é referência sem toolchain, auditoria ou deploy; não trate como código de produção.
- **Escopo regulatório.** Token lastreado, royalty e ponte não constituem oferta pública; operar exige validação jurídica e autorização aplicável.

## 10. Open Finance e investimentos

- **Escopo estrito.** O consentimento só habilita a operação do seu tipo; `DATA_SHARING` não movimenta dinheiro. O servidor valida o tipo no momento da operação, não apenas na criação.
- **Expiração e revogação** são verificadas antes de cada operação e encerram a conta vinculada; a revogação cancela débitos agendados e pagamentos pendentes.
- **Minimização de conta externa**: somente agência, número mascarado e documento mascarado do titular são devolvidos. O saldo informado é um retrato declarado, não consultado em tempo real.
- **Liquidação demo explícita**: `settle` de débito e de iniciação Pix exige `DEMO_MODE=true`; em produção depende de confirmação assinada do PSP/SPI.
- **Iniciação Pix com saldo**: a liquidação exige `MERCHANT_AVAILABLE` suficiente para valor + tarifa; não existe cheque especial implícito.
- **Investimentos sem saldo paralelo**: aporte, resgate e provento movimentam contas do ledger; o principal é conferido antes de cada resgate.
- **IR como provisão**: o valor retido é registrado em `TAX_PAYABLE` e auditado; não substitui apuração fiscal nem informe de rendimentos.

## 11. Privacidade e LGPD

- Minimização: o servidor guarda bandeira, final4 e fingerprint, não o número do cartão.
- Clientes: CPF/CNPJ é armazenado para validação e conciliação, mas a API e a interface devolvem somente a versão mascarada (`529.***.***-25`); exportações herdam o escopo do estabelecimento e o período consultado.
- Checkout público: a página `/pay/:code` expõe apenas valor, descrição, estabelecimento e o payload de pagamento; não revela base de clientes, documentos completos ou outros links.
- Open Finance: o documento do titular é validado e armazenado para conciliação, mas a API/UI devolvem apenas a máscara; agência e conta nunca são devolvidas em claro.
- Finalidade: dados de transação para autorização, antifraude, fiscal e conciliação.
- Retenção: definir por tipo (fiscal tem prazo legal próprio; risco e auditoria seguem política aprovada).
- Titular: canal de requisição e processo de anonimização para dados que não tenham base legal de retenção.

## 12. Conta digital: credenciais, aprovação e transferências

A conta digital tem superfície de ataque própria, separada do token de estabelecimento:

- **Senha nunca em claro**: `scrypt` com N=16384, r=8, p=1 e 64 bytes; salt aleatório por usuário; comparação em tempo constante. No edge Cloudflare, onde `scrypt` não existe, PBKDF2-HMAC-SHA256 com 210.000 iterações.
- **Sessão opaca**: token aleatório de 32 bytes; o banco guarda apenas o SHA-256. Cookie `HttpOnly` + `SameSite=Strict` + `Secure` fora de local, TTL configurável (padrão 8 h) e revogação por linha.
- **CSRF**: escrita autenticada por cookie exige o token exato da sessão. Bearer para integração não usa cookie e não sofre CSRF.
- **Força bruta**: 5 falhas bloqueiam a conta por 15 minutos; login tem rate limit por IP e por identificador.
- **Aprovação obrigatória**: cadastro nasce `PENDING` sem conta e sem sessão. Só o administrador ativa. O primeiro admin exige `BANK_BOOTSTRAP_TOKEN` em produção.
- **Administração destrutiva com guarda**: exclusão é lógica e recusa saldo diferente de zero; reset de senha gera senha temporária exibida uma vez, revoga todas as sessões e força troca.
- **Transferência atômica**: débito condicionado ao saldo (`balance_cents >= valor`) na mesma transação do crédito e das duas partidas do razão; falha desfaz tudo.
- **Idempotência**: chave única por conta + hash da requisição; replay idêntico devolve o original, conteúdo divergente é recusado.
- **Comprovante**: hash de integridade sobre as partes e as partidas; `balanced` conferido.
- **Auditoria**: toda ação administrativa e toda transferência gravam ator, alvo e timestamp em `bank_audit`.
- **Edge**: no D1 não há transação interativa; a atomicidade é imposta por trigger `AFTER INSERT` com `RAISE(ABORT)`. Testes provam que saldo insuficiente aborta a operação inteira.
- **mTLS de maquininha**: listener HTTPS separado que exige certificado de cliente assinado pela CA do banco. O `CN` é o serial do terminal; o fingerprint SHA-256 é pinado contra `terminals.cert_fingerprint`. Sem certificado o handshake é derrubado; CN desconhecido, terminal bloqueado ou fingerprint divergente não autorizam venda. O CN também é conferido no `/v1/transactions` quando o HMAC chega por conexão TLS, impedindo usar o certificado de um terminal com o ID de outro.

Limites padrão da conta: R$ 50.000,00 por transferência e R$ 100.000,00 por dia móvel. O aporte de tesouraria é exclusivo de demonstração, limitado a R$ 10.000,00 por operação e R$ 50.000,00 por dia, e rotulado como demo.

## 13. Checklist antes de produção

- [ ] Substituir captura demo por SDK Tap to Pay/SmartPOS + HSM.
- [ ] Migrar banco para PostgreSQL/Aurora com backup point-in-time e réplica.
- [ ] Mover outbox para Kafka com schema registry e DLQ monitorada.
- [ ] Emitir NFC-e com XMLDSig completo e certificado A1 real homologado na SEFAZ.
- [ ] Registrar webhooks Pix com PSP real e validar mTLS/IP.
- [ ] Registrar boletos em PSP/banco real e ativar baixa automática conciliada.
- [ ] Homologar Open Finance no Banco Central: diretório, mTLS, DICT/SPI e papel de ITP.
- [ ] Substituir liquidações demo de débito/pagamento por webhooks assinados e conciliação diária.
- [ ] Contratar custódia/corretora, registrar os produtos e apurar IR/informe de rendimentos.
- [ ] Configurar KMS, rotação de chaves e política de menor privilégio.
- [ ] Ativar WAF, DDoS, rate limit distribuído e alertas de fraude.
- [ ] Passar por avaliação PCI (SAQ adequado ao modelo tokenizado).
- [ ] Conciliar diariamente `TOKEN_RESERVE` com custódia segregada e teto de emissão.
- [ ] Validar juridicamente lastro, royalty de bioativo, governança DAO e ausência de oferta pública.
- [ ] Compilar e auditar os contratos de `contracts/`, com timelock e multisig antes de qualquer deploy.
- [ ] Substituir prova DePIN demonstrativa por atestação de hardware/TEE do fabricante.
- [ ] Definir política de senha, rotação e bloqueio para a conta digital antes de abrir cadastro público.
- [ ] Publicar o Worker Cloudflare com D1/KV/R2/fila próprios e segredos via `wrangler secret put`; nunca versionar `.dev.vars`.
- [ ] Mover chaves mTLS para HSM/KMS, configurar CRL/OCSP e rotação da CA antes de emitir certificados em escala.
- [ ] Configurar alerta para `bank_audit` (múltiplos resets, aprovações em lote, exclusões) e revisão periódica de acessos admin.
- [ ] Integrar transferência externa somente com PSP/SPI autorizado, mantendo o ledger interno como trilha de conciliação.
- [ ] Auditar o circuito Groth16 (`NetWorthProof`), realizar cerimônia multi-participante e mover a chave de assinatura do oráculo de risco para HSM/KMS; manter Merkle rotulado como inclusão seletiva.
- [ ] Revisar base legal, retenção e revogação de consentimento dos bioativos com o DPO.
- [ ] Definir plano de continuidade, RTO/RPO e testes de caos.
- [ ] Formalizar licenças e contratos: Banco Central, bandeiras, adquirente/PSP.
