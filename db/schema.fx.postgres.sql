-- xPartner Bank · capital demo e carteira internacional para PostgreSQL 16+
--
-- Espelha a migração v9 do SQLite (src/kernel/db.ts):
--   * bank_fx_wallets: uma carteira por titular e moeda (USD/EUR), saldo em centavos;
--   * bank_fx_transfers: transferência entre carteiras da mesma moeda, idempotente
--     por iniciador, com kind CAPITAL (aporte de laboratório);
--   * bank_fx_entries: duas partidas por transferência, com saldo após cada uma;
--   * bank_transfers.channel passa a aceitar CAPITAL (aporte de capital demo).
--
-- Aplicar depois do schema principal, do ledger, das chaves Pix e do crédito:
--   psql "$DATABASE_URL" -f db/schema.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.ledger.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.pix.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.credit.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.fx.postgres.sql
--
-- O livro FX é separado do ledger BRL de propósito: não há câmbio, remessa
-- internacional nem custódia externa. O saldo em moeda estrangeira é demo.

BEGIN;

ALTER TABLE bank_transfers DROP CONSTRAINT IF EXISTS bank_transfers_channel_check;
ALTER TABLE bank_transfers
  ADD CONSTRAINT bank_transfers_channel_check
  CHECK (channel IN ('INTERNAL', 'PIX', 'CREDIT', 'CREDIT_PAYMENT', 'PDV', 'CAPITAL'));

CREATE TABLE IF NOT EXISTS bank_fx_wallets (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES bank_users(id),
  currency               TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
  status                 TEXT NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'BLOCKED')),
  balance_cents          BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  opening_balance_cents  BIGINT NOT NULL DEFAULT 0 CHECK (opening_balance_cents >= 0),
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, currency)
);

CREATE TABLE IF NOT EXISTS bank_fx_transfers (
  id                  TEXT PRIMARY KEY,
  currency            TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
  kind                TEXT NOT NULL DEFAULT 'CAPITAL' CHECK (kind IN ('CAPITAL')),
  debit_wallet_id     TEXT NOT NULL REFERENCES bank_fx_wallets(id),
  credit_wallet_id    TEXT NOT NULL REFERENCES bank_fx_wallets(id),
  amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0),
  memo                TEXT,
  status              TEXT NOT NULL DEFAULT 'POSTED'
                      CHECK (status IN ('POSTED', 'REVERSED')),
  idempotency_key     TEXT,
  request_hash        TEXT,
  initiator_id        TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  CHECK (debit_wallet_id <> credit_wallet_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_fx_transfers_idem
  ON bank_fx_transfers(initiator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_fx_transfers_created
  ON bank_fx_transfers(created_at DESC);

CREATE TABLE IF NOT EXISTS bank_fx_entries (
  id                   TEXT PRIMARY KEY,
  transfer_id          TEXT NOT NULL REFERENCES bank_fx_transfers(id),
  wallet_id            TEXT NOT NULL REFERENCES bank_fx_wallets(id),
  direction            TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_cents         BIGINT NOT NULL CHECK (amount_cents > 0),
  balance_after_cents  BIGINT NOT NULL CHECK (balance_after_cents >= 0),
  created_at           TIMESTAMPTZ NOT NULL,
  UNIQUE (transfer_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_bank_fx_entries_wallet
  ON bank_fx_entries(wallet_id, created_at DESC);

COMMIT;
