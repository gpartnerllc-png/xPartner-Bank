-- xPartner Bank · mensagens RSFN/PAG0004 para PostgreSQL 16+
--
-- Espelha a tabela bank_rsfn_messages criada pela migração v6 do SQLite
-- (src/kernel/db.ts). Não substitui o ledger: cada mensagem aponta para a
-- transferência que debitou o cliente e creditou a câmara de compensação.
--
-- Aplicar depois do schema principal e do ledger de referência:
--   psql "$DATABASE_URL" -f db/schema.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.ledger.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.rsfn.postgres.sql
--
-- Diferenças intencionais em relação ao SQLite:
--   * vlr_cents continua BIGINT (centavos inteiros), contrato do núcleo.
--   * xml e xml_sha256 são guardados como texto para auditoria e reenvio.
--   * status e transport são enums fechados por CHECK, iguais ao runtime.
--   * idempotência é garantida por índice único parcial.

BEGIN;

CREATE TABLE IF NOT EXISTS bank_rsfn_messages (
  id                     TEXT PRIMARY KEY,
  num_ctrl_if            TEXT NOT NULL UNIQUE,
  cod_msg                TEXT NOT NULL DEFAULT 'PAG0004',
  ispb_emissor           CHAR(8) NOT NULL,
  ispb_destinatario      CHAR(8) NOT NULL,
  dt_movto               DATE NOT NULL,
  cod_cli_emissor        TEXT NOT NULL,
  documento_emissor      TEXT NOT NULL,
  nome_emissor           TEXT NOT NULL,
  agencia_destinatario   TEXT NOT NULL,
  conta_destinatario     TEXT NOT NULL,
  documento_destinatario TEXT NOT NULL,
  nome_destinatario      TEXT NOT NULL,
  vlr_cents              BIGINT NOT NULL CHECK (vlr_cents > 0),
  finalidade             CHAR(4) NOT NULL DEFAULT '0001',
  status                 TEXT NOT NULL DEFAULT 'SENT'
                         CHECK (status IN ('SENT', 'ACCEPTED', 'REJECTED', 'SETTLED')),
  transport              TEXT NOT NULL DEFAULT 'SIMULATED'
                         CHECK (transport IN ('SIMULATED', 'LIVE')),
  transfer_id            TEXT NOT NULL,
  xml                    TEXT NOT NULL,
  xml_sha256             CHAR(64) NOT NULL,
  idempotency_key        TEXT,
  request_hash           CHAR(64),
  rejection_code         TEXT,
  rejection_reason       TEXT,
  acknowledged_at        TIMESTAMPTZ,
  acknowledged_by        TEXT,
  created_by             TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL,
  CONSTRAINT bank_rsfn_num_ctrl_if_fmt
    CHECK (num_ctrl_if ~ '^[A-Z][0-9]{25}$'),
  CONSTRAINT bank_rsfn_ispb_fmt
    CHECK (ispb_emissor ~ '^[0-9]{8}$' AND ispb_destinatario ~ '^[0-9]{8}$'),
  CONSTRAINT bank_rsfn_ispb_distinto
    CHECK (ispb_emissor <> ispb_destinatario)
);

-- Uma chave de idempotência pertence a um único remetente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_rsfn_idem
  ON bank_rsfn_messages (created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_rsfn_created_by
  ON bank_rsfn_messages (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bank_rsfn_status
  ON bank_rsfn_messages (status, created_at);

CREATE INDEX IF NOT EXISTS idx_bank_rsfn_transfer
  ON bank_rsfn_messages (transfer_id);

-- Em produção, aponte as FKs para as tabelas reais do banco:
-- ALTER TABLE bank_rsfn_messages
--   ADD CONSTRAINT bank_rsfn_transfer_fk FOREIGN KEY (transfer_id) REFERENCES bank_transfers (id),
--   ADD CONSTRAINT bank_rsfn_created_by_fk FOREIGN KEY (created_by) REFERENCES bank_users (id);

COMMIT;
