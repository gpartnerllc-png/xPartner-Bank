-- xPartner Bank · Edge ledger (Cloudflare D1)
-- Autoridade de escrita no edge. O núcleo Node continua sendo a referência
-- para adquirência/Pix/fiscal; este schema espelha a conta digital e o
-- livro-razão de dupla entrada com postagem atômica via trigger.
--
-- Regras:
--   • valores em centavos (INTEGER)
--   • toda transferência gera duas partidas na mesma transação
--   • saldo negativo é impossível: o UPDATE condicional + RAISE aborta tudo
--   • nenhuma tabela existente é removida (migração aditiva)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bank_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  document TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN', 'SYSTEM')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'BLOCKED', 'DELETED')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  approved_by TEXT,
  approved_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES bank_users(id),
  branch TEXT NOT NULL,
  number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'CHECKING' CHECK (kind IN ('CHECKING', 'SYSTEM')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED', 'CLOSED')),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  per_transfer_limit_cents INTEGER NOT NULL DEFAULT 5000000,
  daily_limit_cents INTEGER NOT NULL DEFAULT 10000000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES bank_users(id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS bank_transfers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (kind IN ('INTERNAL', 'FUNDING')),
  debit_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  credit_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  end_to_end_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT,
  request_hash TEXT,
  initiator_id TEXT NOT NULL REFERENCES bank_users(id),
  recipient_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (debit_account_id <> credit_account_id)
);

CREATE TABLE IF NOT EXISTS bank_ledger (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES bank_transfers(id),
  account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_after_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (transfer_id, direction)
);

CREATE TABLE IF NOT EXISTS bank_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edge_events (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_transfers_idempotency
  ON bank_transfers (initiator_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS bank_transfers_debit_time
  ON bank_transfers (debit_account_id, created_at);
CREATE INDEX IF NOT EXISTS bank_transfers_credit_time
  ON bank_transfers (credit_account_id, created_at);
CREATE INDEX IF NOT EXISTS bank_ledger_account_time
  ON bank_ledger (account_id, created_at);
CREATE INDEX IF NOT EXISTS bank_sessions_user
  ON bank_sessions (user_id);
CREATE INDEX IF NOT EXISTS bank_users_status
  ON bank_users (status);
CREATE INDEX IF NOT EXISTS bank_audit_time
  ON bank_audit (created_at);

-- Postagem atômica: INSERT em bank_transfers move o saldo e grava as duas
-- partidas dentro da mesma transação implícita do SQLite/D1.
CREATE TRIGGER IF NOT EXISTS bank_transfers_post
AFTER INSERT ON bank_transfers
WHEN NEW.status = 'POSTED'
BEGIN
  UPDATE bank_accounts
     SET balance_cents = balance_cents - NEW.amount_cents,
         updated_at = NEW.created_at
   WHERE id = NEW.debit_account_id
     AND status = 'ACTIVE'
     AND balance_cents >= NEW.amount_cents;

  SELECT RAISE(ABORT, 'DEBIT_ACCOUNT_INACTIVE')
   WHERE (SELECT status FROM bank_accounts WHERE id = NEW.debit_account_id) <> 'ACTIVE';

  SELECT RAISE(ABORT, 'INSUFFICIENT_FUNDS')
   WHERE (SELECT balance_cents FROM bank_accounts WHERE id = NEW.debit_account_id) < NEW.amount_cents;

  UPDATE bank_accounts
     SET balance_cents = balance_cents + NEW.amount_cents,
         updated_at = NEW.created_at
   WHERE id = NEW.credit_account_id
     AND status = 'ACTIVE';

  SELECT RAISE(ABORT, 'CREDIT_ACCOUNT_INACTIVE')
   WHERE (SELECT status FROM bank_accounts WHERE id = NEW.credit_account_id) <> 'ACTIVE';

  INSERT INTO bank_ledger (id, transfer_id, account_id, direction, amount_cents, balance_after_cents, created_at)
  VALUES (
    NEW.id || '-D', NEW.id, NEW.debit_account_id, 'DEBIT', NEW.amount_cents,
    (SELECT balance_cents FROM bank_accounts WHERE id = NEW.debit_account_id),
    NEW.created_at
  );

  INSERT INTO bank_ledger (id, transfer_id, account_id, direction, amount_cents, balance_after_cents, created_at)
  VALUES (
    NEW.id || '-C', NEW.id, NEW.credit_account_id, 'CREDIT', NEW.amount_cents,
    (SELECT balance_cents FROM bank_accounts WHERE id = NEW.credit_account_id),
    NEW.created_at
  );
END;

-- Visões de compatibilidade em português (mesmo contrato do núcleo Node).
CREATE VIEW IF NOT EXISTS contas AS
SELECT a.id,
       a.user_id AS usuario_id,
       u.name AS titular,
       a.branch AS agencia,
       a.number AS numero,
       a.kind AS tipo,
       a.status AS status,
       a.balance_cents AS saldo_centavos,
       a.created_at AS criada_em
  FROM bank_accounts a
  JOIN bank_users u ON u.id = a.user_id;

CREATE VIEW IF NOT EXISTS transacoes AS
SELECT id,
       debit_account_id AS conta_origem_id,
       credit_account_id AS conta_destino_id,
       amount_cents AS valor_centavos,
       description AS descricao,
       status AS status,
       end_to_end_id,
       created_at AS criada_em
  FROM bank_transfers;

-- Tesouraria: conta de sistema usada apenas para aportes em modo demo.
INSERT OR IGNORE INTO bank_sequences (name, value) VALUES ('account', 1000000);

INSERT OR IGNORE INTO bank_users
  (id, name, document, email, phone, password_hash, role, status, must_change_password, created_at, updated_at)
VALUES
  ('bank_user_system', 'Tesouraria xPartner', '00000000000000', 'tesouraria@xpartner.internal', NULL,
   '!system-account-no-login!', 'SYSTEM', 'ACTIVE', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO bank_accounts
  (id, user_id, branch, number, kind, status, balance_cents, opening_balance_cents, created_at, updated_at)
VALUES
  ('bank_acc_system', 'bank_user_system', '0000', '00000000', 'SYSTEM', 'ACTIVE',
   1000000000, 1000000000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
