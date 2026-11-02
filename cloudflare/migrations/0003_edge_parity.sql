-- xPartner Bank · Edge v3 (migração aditiva)
-- Paridade do app bancário no edge: chaves Pix, crédito e RSFN PAG0004.
-- Nenhuma tabela existente é removida. O ledger continua postando saldo e
-- partidas dobradas pelo trigger bank_transfers_post.

PRAGMA foreign_keys = ON;

-- Canal da transferência (INTERNAL, CREDIT, CREDIT_PAYMENT, RSFN).
ALTER TABLE bank_transfers ADD COLUMN channel TEXT NOT NULL DEFAULT 'INTERNAL';

CREATE TABLE IF NOT EXISTS bank_pix_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES bank_users(id),
  key_type TEXT NOT NULL CHECK (key_type IN ('CPF','CNPJ','EMAIL','PHONE','EVP')),
  key_value TEXT NOT NULL,
  key_masked TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','DELETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_pix_keys_value
  ON bank_pix_keys(key_type, key_value) WHERE status <> 'DELETED';
CREATE INDEX IF NOT EXISTS bank_pix_keys_user
  ON bank_pix_keys(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS bank_credit_contracts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES bank_users(id),
  account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  contract_number TEXT NOT NULL UNIQUE,
  product TEXT NOT NULL CHECK (product IN ('ANTECIPACAO','EMPRESTIMO')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID')),
  requested_cents INTEGER NOT NULL CHECK (requested_cents > 0),
  principal_cents INTEGER NOT NULL CHECK (principal_cents > 0),
  total_due_cents INTEGER NOT NULL CHECK (total_due_cents >= principal_cents),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  outstanding_cents INTEGER NOT NULL CHECK (outstanding_cents >= 0),
  monthly_rate_bps INTEGER NOT NULL CHECK (monthly_rate_bps > 0),
  installments INTEGER NOT NULL CHECK (installments BETWEEN 1 AND 24),
  score INTEGER NOT NULL,
  disbursement_transfer_id TEXT,
  settled_early INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_credit_idempotency
  ON bank_credit_contracts(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_credit_user
  ON bank_credit_contracts(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS bank_credit_installments (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES bank_credit_contracts(id),
  number INTEGER NOT NULL CHECK (number > 0),
  due_date TEXT NOT NULL,
  principal_cents INTEGER NOT NULL CHECK (principal_cents >= 0),
  interest_cents INTEGER NOT NULL CHECK (interest_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID')),
  paid_at TEXT,
  payment_transfer_id TEXT,
  UNIQUE (contract_id, number)
);
CREATE INDEX IF NOT EXISTS bank_credit_installments_contract
  ON bank_credit_installments(contract_id, number);

CREATE TABLE IF NOT EXISTS bank_rsfn_messages (
  id TEXT PRIMARY KEY,
  num_ctrl_if TEXT NOT NULL UNIQUE,
  cod_msg TEXT NOT NULL DEFAULT 'PAG0004',
  ispb_emissor TEXT NOT NULL,
  ispb_destinatario TEXT NOT NULL,
  dt_movto TEXT NOT NULL,
  cod_cli_emissor TEXT NOT NULL,
  documento_emissor TEXT NOT NULL,
  nome_emissor TEXT NOT NULL,
  agencia_destinatario TEXT NOT NULL,
  conta_destinatario TEXT NOT NULL,
  documento_destinatario TEXT NOT NULL,
  nome_destinatario TEXT NOT NULL,
  vlr_cents INTEGER NOT NULL CHECK (vlr_cents > 0),
  finalidade TEXT NOT NULL DEFAULT '0001',
  status TEXT NOT NULL DEFAULT 'SENT'
    CHECK (status IN ('SENT','ACCEPTED','REJECTED','SETTLED')),
  transport TEXT NOT NULL DEFAULT 'SIMULATED' CHECK (transport IN ('SIMULATED','LIVE')),
  transfer_id TEXT NOT NULL REFERENCES bank_transfers(id),
  xml TEXT NOT NULL,
  xml_sha256 TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash TEXT,
  rejection_code TEXT,
  rejection_reason TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  created_by TEXT NOT NULL REFERENCES bank_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_rsfn_idempotency
  ON bank_rsfn_messages(created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_rsfn_created_by
  ON bank_rsfn_messages(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS bank_rsfn_status
  ON bank_rsfn_messages(status, created_at);
CREATE INDEX IF NOT EXISTS bank_rsfn_transfer
  ON bank_rsfn_messages(transfer_id);

-- Base do PDV/NFC-e no edge (mesmo contrato do núcleo Node, sem dados seed).
CREATE TABLE IF NOT EXISTS bank_pdv_sales (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES bank_users(id),
  transaction_id TEXT NOT NULL UNIQUE,
  merchant_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  net_cents INTEGER NOT NULL CHECK (net_cents >= 0),
  method TEXT NOT NULL,
  description TEXT NOT NULL,
  fiscal_status TEXT,
  access_key TEXT,
  fiscal_id TEXT,
  settlement_transfer_id TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bank_pdv_user
  ON bank_pdv_sales(user_id, created_at DESC);

-- Câmara RSFN: conta de compensação usada enquanto a mensagem aguarda retorno.
INSERT OR IGNORE INTO bank_users
  (id, name, document, email, phone, password_hash, role, status, must_change_password, created_at, updated_at)
VALUES
  ('bank_user_rsfn', 'Câmara RSFN (compensação)', '00000000000001', 'rsfn@xpartner.internal',
   NULL, '!system-account-no-login!', 'SYSTEM', 'ACTIVE', 0,
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO bank_accounts
  (id, user_id, branch, number, kind, status, balance_cents, opening_balance_cents,
   per_transfer_limit_cents, daily_limit_cents, created_at, updated_at)
VALUES
  ('bank_acc_rsfn', 'bank_user_rsfn', '0000', '00000001', 'CHECKING', 'ACTIVE',
   0, 0, 100000000, 100000000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
