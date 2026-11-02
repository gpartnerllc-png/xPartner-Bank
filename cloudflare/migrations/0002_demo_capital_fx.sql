-- xPartner Bank · Edge v2 (migração aditiva)
-- Capital de laboratório em BRL e carteira internacional em USD, com o mesmo
-- contrato do núcleo Node. Nenhuma tabela existente é removida ou alterada.

PRAGMA foreign_keys = ON;

-- Conta de capital de laboratório: lastro contábil dos saldos de demonstração.
INSERT OR IGNORE INTO bank_users
  (id, name, document, email, phone, password_hash, role, status, must_change_password, created_at, updated_at)
VALUES
  ('bank_user_capital', 'Capital de laboratório (demo)', '00000000000002', 'capital@xpartner.internal',
   NULL, '!system-account-no-login!', 'SYSTEM', 'ACTIVE', 0,
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO bank_accounts
  (id, user_id, branch, number, kind, status, balance_cents, opening_balance_cents, created_at, updated_at)
VALUES
  ('bank_acc_capital', 'bank_user_capital', '0000', '99999999', 'SYSTEM', 'ACTIVE',
   10000000000000, 10000000000000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

-- Carteiras internacionais: livro próprio de dupla entrada, separado do BRL.
CREATE TABLE IF NOT EXISTS bank_fx_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES bank_users(id),
  currency TEXT NOT NULL CHECK (currency IN ('USD')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED')),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, currency)
);

CREATE TABLE IF NOT EXISTS bank_fx_transfers (
  id TEXT PRIMARY KEY,
  currency TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'FUNDING' CHECK (kind IN ('FUNDING', 'INTERNAL')),
  debit_wallet_id TEXT NOT NULL REFERENCES bank_fx_wallets(id),
  credit_wallet_id TEXT NOT NULL REFERENCES bank_fx_wallets(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  initiator_id TEXT NOT NULL REFERENCES bank_users(id),
  created_at TEXT NOT NULL,
  CHECK (debit_wallet_id <> credit_wallet_id)
);

CREATE TABLE IF NOT EXISTS bank_fx_entries (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES bank_fx_transfers(id),
  wallet_id TEXT NOT NULL REFERENCES bank_fx_wallets(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_after_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (transfer_id, direction)
);

CREATE INDEX IF NOT EXISTS bank_fx_wallets_user
  ON bank_fx_wallets (user_id);
CREATE INDEX IF NOT EXISTS bank_fx_entries_wallet_time
  ON bank_fx_entries (wallet_id, created_at);

-- Postagem atômica da carteira: saldo nunca fica negativo.
CREATE TRIGGER IF NOT EXISTS bank_fx_transfers_post
AFTER INSERT ON bank_fx_transfers
WHEN NEW.status = 'POSTED'
BEGIN
  UPDATE bank_fx_wallets
     SET balance_cents = balance_cents - NEW.amount_cents,
         updated_at = NEW.created_at
   WHERE id = NEW.debit_wallet_id
     AND status = 'ACTIVE'
     AND balance_cents >= NEW.amount_cents;

  SELECT RAISE(ABORT, 'FX_DEBIT_INACTIVE')
   WHERE (SELECT status FROM bank_fx_wallets WHERE id = NEW.debit_wallet_id) <> 'ACTIVE';

  SELECT RAISE(ABORT, 'FX_INSUFFICIENT_FUNDS')
   WHERE (SELECT balance_cents FROM bank_fx_wallets WHERE id = NEW.debit_wallet_id) < NEW.amount_cents;

  UPDATE bank_fx_wallets
     SET balance_cents = balance_cents + NEW.amount_cents,
         updated_at = NEW.created_at
   WHERE id = NEW.credit_wallet_id
     AND status = 'ACTIVE';

  SELECT RAISE(ABORT, 'FX_CREDIT_INACTIVE')
   WHERE (SELECT status FROM bank_fx_wallets WHERE id = NEW.credit_wallet_id) <> 'ACTIVE';

  INSERT INTO bank_fx_entries (id, transfer_id, wallet_id, direction, amount_cents, balance_after_cents, created_at)
  VALUES (
    NEW.id || '-D', NEW.id, NEW.debit_wallet_id, 'DEBIT', NEW.amount_cents,
    (SELECT balance_cents FROM bank_fx_wallets WHERE id = NEW.debit_wallet_id),
    NEW.created_at
  );

  INSERT INTO bank_fx_entries (id, transfer_id, wallet_id, direction, amount_cents, balance_after_cents, created_at)
  VALUES (
    NEW.id || '-C', NEW.id, NEW.credit_wallet_id, 'CREDIT', NEW.amount_cents,
    (SELECT balance_cents FROM bank_fx_wallets WHERE id = NEW.credit_wallet_id),
    NEW.created_at
  );
END;

-- Tesouraria internacional (USD) com capital demo de US$ 100 bilhões.
INSERT OR IGNORE INTO bank_fx_wallets
  (id, user_id, currency, status, balance_cents, opening_balance_cents, created_at, updated_at)
VALUES
  ('bank_fx_system_usd', 'bank_user_system', 'USD', 'ACTIVE',
   10000000000000, 10000000000000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
