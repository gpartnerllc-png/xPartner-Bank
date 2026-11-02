-- xPartner Bank · chaves Pix e canal da transferência para PostgreSQL 16+
--
-- Espelha a migração v7 do SQLite (src/kernel/db.ts):
--   * bank_pix_keys com unicidade parcial entre chaves não excluídas;
--   * coluna channel em bank_transfers para distinguir INTERNAL de PIX.
--
-- Aplicar depois do schema principal e do ledger de referência:
--   psql "$DATABASE_URL" -f db/schema.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.ledger.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.pix.postgres.sql
--
-- Diferenças intencionais em relação ao SQLite:
--   * timestamps em TIMESTAMPTZ (o runtime grava ISO-8601 em UTC);
--   * CHECKs fechados para tipo e status, iguais ao runtime;
--   * unicidade de chave garantida por índice parcial que ignora DELETED.

BEGIN;

ALTER TABLE bank_transfers
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'INTERNAL'
  CHECK (channel IN ('INTERNAL', 'PIX'));

CREATE TABLE IF NOT EXISTS bank_pix_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES bank_users(id),
  key_type    TEXT NOT NULL CHECK (key_type IN ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP')),
  key_value   TEXT NOT NULL,
  key_masked  TEXT NOT NULL,
  label       TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('ACTIVE', 'BLOCKED', 'DELETED')),
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_pix_keys_value
  ON bank_pix_keys (key_type, key_value)
  WHERE status <> 'DELETED';

CREATE INDEX IF NOT EXISTS idx_bank_pix_keys_user
  ON bank_pix_keys (user_id, status, created_at DESC);

-- Consulta de DICT local: resolução de chave ativa para conta do titular.
-- Em produção, a resolução oficial vem do DICT via PSP participante.
CREATE INDEX IF NOT EXISTS idx_bank_pix_keys_lookup
  ON bank_pix_keys (key_value)
  WHERE status = 'ACTIVE';

COMMIT;
