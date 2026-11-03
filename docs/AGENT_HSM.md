# Agente de IA autônomo com HSM · guia de empacotamento

Este guia descreve como empacotar o agente quantitativo (Python) e o verificador zk-SNARK do xPartner em containers sem colocar chaves privadas na imagem, no ambiente ou no disco do host. Ele complementa [`docs/WEB3.md`](WEB3.md) e os contratos de referência em [`contracts/`](../contracts/README.md).

> **Limite honesto:** o agente deste repositório é o motor TypeScript `AladdinEngine` + `CrossChainHub`. O runtime Python abaixo é o formato de empacotamento para um agente externo que assina atestações de risco e envia transações. Nada aqui movimenta dinheiro real sem um HSM provisionado, uma lane CCIP real e auditoria independente.

## 1. Princípios

1. **A chave nunca sai do HSM.** O agente envia o digest EIP-712 para o HSM e recebe de volta `r`, `s`, `v` (ou uma assinatura PKCS#11). A chave privada não é exportável, não é lida pelo processo e não aparece em log.
2. **Segredos não entram na imagem.** Use Docker secrets, tmpfs ou variáveis injetadas por orquestrador com suporte a secret store. `.env` com chave privada é proibido.
3. **Menor privilégio.** Container non-root, sistema de arquivos read-only, `cap_drop: ALL`, `no-new-privileges`, seccomp padrão, rede de saída restrita ao RPC/HSM/observabilidade.
4. **Reprodutibilidade.** Build multi-stage com lockfile, dependências fixadas e SBOM. A imagem não contém `.zkey` de produção nem chave de assinatura.
5. **Auditoria.** Toda assinatura registra `keyId`, `digest`, `nonce`, `intentId`, horário e resultado, sem o material secreto.

## 2. Arquitetura

```
┌─────────────────────────────── host / Kubernetes ───────────────────────────────┐
│  ┌────────────────────┐      PKCS#11 / gRPC      ┌───────────────────────────┐  │
│  │ agent (Python)     │ ───────────────────────▶ │ HSM / KMS gerenciado      │  │
│  │  - quant engine    │ ◀─────────────────────── │ chave não exportável      │  │
│  │  - CCIP relayer    │        assinatura        │ auditoria + rotação       │  │
│  └─────────┬──────────┘                          └───────────────────────────┘  │
│            │ RPC allowlist (HTTPS)                                              │
│            ▼                                                                    │
│  AppChain / L2 / Chainlink CCIP router                                          │
│                                                                                 │
│  ┌────────────────────┐    HTTP interno     ┌────────────────────────────────┐  │
│  │ xPartner core      │ ◀────────────────── │ verificador Groth16 (snarkjs)  │  │
│  │ ledger + intents   │                     │ circuits/build/*               │  │
│  └────────────────────┘                     └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

O agente **assina** atestações de risco EIP-712 (struct `RiskAttestation` em `AladdinRiskEngine.sol`) e **propõe/settle** intents. O HSM só assina digests previamente validados pelo agente; o verificador Groth16 roda no core (ou no cliente) e não tem acesso a chave alguma.

## 3. Escolha do HSM

| Opção | Uso | Observação |
|---|---|---|
| AWS KMS (ECC_SECG_P256K1) | assinatura gerenciada, baixo atrito | chave não exportável; `Sign` devolve DER, convertir para `r/s/v` |
| AWS CloudHSM | PKCS#11 dedicado | cluster por AZ, alto custo, exige client da AWS |
| Azure Key Vault Managed HSM | PKCS#11/rest | FIPS 140-2 Level 3 |
| GCP Cloud HSM | PKCS#11 | chaves protegidas por hardware |
| YubiHSM 2 | on-premise, baixo custo | ótimo para testnet e chaves de operação |
| SoftHSM2 | **somente desenvolvimento** | software, não é HSM real; nunca em produção |

Requisitos mínimos de produção: FIPS 140-2/3 (nível 2+), backup/restore com quorum, rotação documentada, MFA para operações administrativas e trilha de auditoria imutável.

## 4. Dockerfile do agente (multi-stage, sem segredos)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS build
WORKDIR /build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.txt .
# Segredo de índice privado (se houver) via BuildKit; nunca em ARG/ENV
RUN --mount=type=secret,id=pip_token,required=false \
    pip install --prefix=/install -r requirements.txt

FROM python:3.12-slim AS runtime
RUN useradd --system --uid 10001 --home /app agent \
 && apt-get update && apt-get install -y --no-install-recommends pkcs11-helper \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /install /usr/local
COPY agent ./agent
COPY circuits/verification_key.json ./circuits/verification_key.json
USER 10001:10001
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# Sem ENV com chave, senha, token ou URL com credencial.
ENTRYPOINT ["python", "-m", "agent.main"]
```

Regras:

- `COPY` explícito; nunca `COPY . .` com `.env`/chaves no contexto.
- O `.dockerignore` deve excluir `.env*`, `*.pem`, `*.key`, `.data`, `secrets/`.
- Não inclua `circuits/build/*.zkey` na imagem do **verificador**; o verificador precisa apenas da `verification_key.json` e do wasm (se provar no cliente). O `.zkey` de produção fica no cliente/prover isolado.
- Assine a imagem (cosign) e publique o digest, não a tag móvel.

## 5. Execução com Docker secrets

```yaml
services:
  agent:
    image: registry.example/xpartner-agent@sha256:<digest>
    read_only: true
    user: "10001:10001"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    tmpfs:
      - /tmp:size=64m,noexec,nosuid
    secrets:
      - hsm_pin
      - rpc_url
    environment:
      HSM_PKCS11_LIB: /usr/lib/softhsm/libsofthsm2.so   # troque pelo lib do HSM real
      HSM_KEY_LABEL: xpartner-agent-signer
      HSM_PIN_FILE: /run/secrets/hsm_pin
      RPC_URL_FILE: /run/secrets/rpc_url
    networks: [egress]

secrets:
  hsm_pin:
    external: true
  rpc_url:
    external: true

networks:
  egress:
    driver: bridge
```

- O processo lê o PIN do arquivo (`/run/secrets/...`) e o mantém apenas em memória; nunca imprime nem envia por HTTP.
- Em Kubernetes, use `secretKeyRef` montado como volume, `readOnlyRootFilesystem: true`, `runAsNonRoot`, `allowPrivilegeEscalation: false` e `NetworkPolicy` de saída.
- Para HSM de rede, monte o socket/proxy PKCS#11 em volume read-only e restrinja por mTLS.

## 6. Assinatura via PKCS#11 (esqueleto)

```python
# agent/signer.py — nunca loga a chave, apenas o digest e o keyId
import pkcs11
from pkcs11 import KeyType, Mechanism
from eth_account.messages import encode_typed_data

class HsmSigner:
    def __init__(self, lib_path: str, slot: int, label: str, pin: str):
        self.lib = pkcs11.lib(lib_path)
        self.slot = self.lib.get_slot(token_label=label)
        self.pin = pin  # mantenha em memória; não persista

    def sign_risk(self, attestation: dict) -> bytes:
        domain = {
            "name": "xPartner Aladdin Risk",
            "version": "1",
            "chainId": int(attestation["chainId"]),
            "verifyingContract": attestation["engine"],
        }
        types = {
            "RiskAttestation": [
                {"name": "borrower", "type": "address"},
                {"name": "varBps", "type": "uint16"},
                {"name": "creditScore", "type": "uint16"},
                {"name": "nonce", "type": "uint64"},
                {"name": "issuedAt", "type": "uint64"},
                {"name": "expiresAt", "type": "uint64"},
            ]
        }
        message = {k: attestation[k] for k in ("borrower", "varBps", "creditScore", "nonce", "issuedAt", "expiresAt")}
        digest = encode_typed_data(domain, types, message).body  # 32 bytes EIP-712
        with self.slot.open(token_pin=self.pin) as token:
            key = token.get_key(label="xpartner-agent-signer", key_type=KeyType.EC)
            signature = key.sign(digest, mechanism=Mechanism.ECDSA)
        # HSM pode devolver r||s em raw ou DER; normalize para 65 bytes (r,s,v) antes de enviar on-chain.
        return signature
```

Checklist da assinatura:

- Valide `borrower == carteira do tomador`, `creditScore >= 7000`, `varBps <= 2500` e janela de validade **antes** de chamar o HSM.
- Use nonce monotônico por tomador e persista o nonce já usado no banco do agente; o contrato também rejeita replay.
- Limite o número de assinaturas por minuto e alerte em picos.
- Se o HSM devolver DER, converta para `(r, s, v)` com `v ∈ {27, 28}` e `s <= secp256k1n/2`.
- Nunca assine payload arbitrário recebido de HTTP; apenas a struct tipada após validação.

## 7. Circom / SnarkJS

Artefatos versionados em `circuits/build/`:

| Arquivo | Uso | Pode ir para produção? |
|---|---|---|
| `NetWorthProof.circom` | fonte do circuito | sim, é público |
| `NetWorthProof.wasm` | prova no cliente/agente | sim, é público |
| `NetWorthProof.zkey` | chave de prova | **trate como material sensível de cerimônia**; não sirva por HTTP |
| `verification_key.json` | verificação | sim, é público |

Rebuild e verificação:

```bash
npm run zk:build                     # circom2 + snarkjs, cerimônia de demonstração
sha256sum circuits/build/NetWorthProof.zkey circuits/build/NetWorthProof.wasm
node -e "const v=require('./circuits/build/verification_key.json'); console.log(v.nPublic, v.protocol)"
```

Produção:

- Faça uma cerimônia multi-participante (powers of tau + fase 2) com transcript público; a cerimônia deste repositório é **de demonstração**.
- Publique os hashes dos artefatos e valide no boot: se o wasm/zkey divergir do esperado, o serviço deve recusar provar.
- Prove no cliente (wasm) para que o patrimônio nunca chegue ao servidor; o servidor só verifica.
- Rotacione o verificador com timelock e mantenha o verificador antigo aceito durante a migração.

## 8. CCIP e intents em produção

1. Registre a lane no router oficial (source/destination chain selector, receiver address) e configure no `IntentReceiver` via `setLane`.
2. Pré-financie a liquidez de destino do solver (`depositLiquidity` no receiver) e a liquidez de origem no `IntentVault`.
3. O relayer só chama `IntentVault.settleIntent` com um `messageId` único devolvido pelo CCIP; mensagens sem confirmação de finality não devem liquidar.
4. Monitore `IntentFilled` e `IntentSettled`; divergência entre as pernas é incidente crítico.
5. Limite valor por intent, por lane e por dia; pause a lane em caso de anomalia.
6. O core atual **simula** a entrega: `ccip_messages` nasce `SETTLED` com `messageId` sha256. Não confunda o ledger interno com entrega on-chain real.

## 9. Checklist de endurecimento

- [ ] Chave de assinatura criada no HSM, não exportável, com backup/quorum documentado.
- [ ] PIN/senha apenas via secret; nunca em `ENV`, `ARG`, imagem, log ou telemetria.
- [ ] Container non-root, read-only, `cap_drop: ALL`, `no-new-privileges`, seccomp.
- [ ] Egress allowlist: RPC, HSM proxy, observabilidade. Nada de internet aberta.
- [ ] Redaction de logs para `authorization`, `cookie`, `pin`, `privateKey`, `mnemonic`, `seed`.
- [ ] Rate limit e circuit breaker na assinatura e no settle.
- [ ] Rotação de chave com janela de sobreposição e revogação no contrato (`setRiskSigner`).
- [ ] Hashes dos artefatos ZK verificados no boot.
- [ ] Alertas para: falha de assinatura, replay, `ProofRejected`, lane pausada, saldo de liquidez abaixo do mínimo.
- [ ] Auditoria independente dos contratos e do fluxo de chaves antes de mainnet.

## 10. Limites explícitos

- Este guia não provisiona HSM, KMS, lane CCIP nem contrato em mainnet; é o formato correto de empacotamento e operação.
- SoftHSM e a cerimônia de demonstração **não** oferecem segurança de produção.
- O agente Python é um esqueleto de integração; o motor quantitativo auditável deste repositório é o TypeScript (`src/domain/aladdin.ts`), com Monte Carlo determinístico, não um modelo preditivo validado.
- zk-SNARK prova o predicado de patrimônio, não identidade, KYC, faturamento ou idoneidade. A decisão de crédito continua humana e regulada.
