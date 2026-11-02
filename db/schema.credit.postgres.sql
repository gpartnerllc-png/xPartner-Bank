-- xPartner Bank · crédito, parcelas e PDV/NFC-e para PostgreSQL 16+
--
-- Espelha a migração v8 do SQLite (src/kernel/db.ts):
--   * bank_credit_contracts com produto, taxa congelada, principal, saldo devedor,
--     desembolso, liquidação antecipada e idempotência por titular;
--   * bank_credit_installments com agenda Price/antecipação e baixa por parcela;
--   * bank_pdv_sales com venda presencial, NFC-e, taxa e liquidação do líquido;
--   * bank_transfers.channel passa a aceitar CREDIT, CREDIT_PAYMENT e PDV.
--
-- Aplicar depois do schema principal, do ledger e das chaves Pix:
--   psql "$DATABASE_URL" -f db/schema.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.ledger.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.pix.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.credit.postgres.sql
--
-- Diferenças intencionais em relação ao SQLite:
--   * timestamps em TIMESTAMPTZ (o runtime grava ISO-8601 em UTC);
--   * valores sempre em centavos inteiros (BIGINT), nunca ponto flutuante;
--   * CHECKs fechados para produto, status e número de parcelas;
--   * idempotência garantida por índice único parcial por titular.

BEGIN;

-- O canal da transferência deixa de ser apenas INTERNAL/PIX.
ALTER TABLE bank_transfers DROP CONSTRAINT IF EXISTS bank_transfers_channel_check;
ALTER TABLE bank_transfers
  ADD CONSTRAINT bank_transfers_channel_check
  CHECK (channel IN ('INTERNAL', 'PIX', 'CREDIT', 'CREDIT_PAYMENT', 'PDV'));

CREATE TABLE IF NOT EXISTS bank_credit_contracts (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES bank_users(id),
  account_id              TEXT NOT NULL REFERENCES bank_accounts(id),
  contract_number         TEXT NOT NULL UNIQUE,
  product                 TEXT NOT NULL
                          CHECK (product IN ('ANTECIPACAO', 'EMPRESTIMO')),
  status                  TEXT NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN', 'PAID')),
  requested_cents         BIGINT NOT NULL CHECK (requested_cents > 0),
  principal_cents         BIGINT NOT NULL CHECK (principal_cents > 0),
  total_due_cents         BIGINT NOT NULL CHECK (total_due_cents >= principal_cents),
  paid_cents              BIGINT NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  outstanding_cents       BIGINT NOT NULL CHECK (outstanding_cents >= 0),
  monthly_rate_bps        INTEGER NOT NULL CHECK (monthly_rate_bps > 0),
  installments            INTEGER NOT NULL CHECK (installments BETWEEN 1 AND 12),
  score                   INTEGER NOT NULL CHECK (score BETWEEN 0 AND 1000),
  disbursement_transfer_id TEXT REFERENCES bank_transfers(id),
  settled_early           BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key         TEXT,
  request_hash            TEXT,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  closed_at               TIMESTAMPTZ,
  CHECK (paid_cents + outstanding_cents <= total_due_cents)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_credit_idem
  ON bank_credit_contracts (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_credit_user
  ON bank_credit_contracts (user_id, status, created_at DESC);

-- Exposição aberta por titular: base do limite disponível.
CREATE INDEX IF NOT EXISTS idx_bank_credit_open
  ON bank_credit_contracts (user_id)
  WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS bank_credit_installments (
  id                  TEXT PRIMARY KEY,
  contract_id         TEXT NOT NULL REFERENCES bank_credit_contracts(id),
  number              INTEGER NOT NULL CHECK (number > 0),
  due_date            DATE NOT NULL,
  principal_cents     BIGINT NOT NULL CHECK (principal_cents >= 0),
  interest_cents      BIGINT NOT NULL CHECK (interest_cents >= 0),
  total_cents         BIGINT NOT NULL CHECK (total_cents > 0),
  status              TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'PAID')),
  paid_at             TIMESTAMPTZ,
  payment_transfer_id TEXT REFERENCES bank_transfers(id),
  UNIQUE (contract_id, number),
  CHECK (principal_cents + interest_cents = total_cents)
);

CREATE INDEX IF NOT EXISTS idx_bank_credit_installments_contract
  ON bank_credit_installments (contract_id, number);

CREATE INDEX IF NOT EXISTS idx_bank_credit_installments_open
  ON bank_credit_installments (status, due_date)
  WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS bank_pdv_sales (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES bank_users(id),
  transaction_id         TEXT NOT NULL UNIQUE,
  merchant_id            TEXT NOT NULL,
  amount_cents           BIGINT NOT NULL CHECK (amount_cents > 0),
  fee_cents              BIGINT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  net_cents              BIGINT NOT NULL CHECK (net_cents >= 0),
  method                 TEXT NOT NULL,
  description            TEXT NOT NULL,
  fiscal_status          TEXT,
  access_key             TEXT,
  fiscal_id              TEXT,
  settlement_transfer_id TEXT REFERENCES bank_transfers(id),
  settled_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL,
  CHECK (fee_cents + net_cents = amount_cents)
);

CREATE INDEX IF NOT EXISTS idx_bank_pdv_user
  ON bank_pdv_sales (user_id, created_at DESC);

COMMIT;
