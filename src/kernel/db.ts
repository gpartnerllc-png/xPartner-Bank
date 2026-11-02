import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trade_name TEXT NOT NULL,
  document TEXT NOT NULL UNIQUE,
  mcc TEXT NOT NULL,
  ie TEXT,
  crt TEXT NOT NULL DEFAULT '1',
  city TEXT NOT NULL DEFAULT 'SAO PAULO',
  uf TEXT NOT NULL DEFAULT 'SP',
  pix_key TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  serial TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  cert_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','RETIRED')),
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terminals_merchant ON terminals(merchant_id);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('PLATFORM','MERCHANT')),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  created_at TEXT NOT NULL,
  UNIQUE (owner_type, owner_id, kind, currency)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  entry_group TEXT NOT NULL,
  group_kind TEXT NOT NULL,
  transaction_id TEXT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  memo TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_group ON ledger_entries(entry_group);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger_entries(transaction_id);

CREATE TABLE IF NOT EXISTS acquirers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  debit_bps INTEGER NOT NULL,
  credit_bps INTEGER NOT NULL,
  pix_bps INTEGER NOT NULL,
  installments_bps INTEGER NOT NULL DEFAULT 0,
  fixed_fee_cents INTEGER NOT NULL DEFAULT 0,
  brands TEXT NOT NULL,
  success_rate REAL NOT NULL DEFAULT 0.98,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  terminal_id TEXT NOT NULL REFERENCES terminals(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  method TEXT NOT NULL CHECK (method IN ('CREDIT','DEBIT','PIX','VOUCHER')),
  installments INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','DECLINED','CANCELED','REFUNDED')),
  nsu TEXT,
  authorization_code TEXT,
  acquirer_id TEXT,
  brand TEXT,
  last4 TEXT,
  card_fingerprint TEXT,
  risk_score INTEGER NOT NULL DEFAULT 0,
  risk_decision TEXT,
  risk_reasons TEXT,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  description TEXT,
  items TEXT,
  settlement_at TEXT,
  paid_at TEXT,
  fiscal_status TEXT,
  failure_reason TEXT,
  source TEXT NOT NULL DEFAULT 'CARD',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_merchant_created ON transactions(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_terminal_created ON transactions(terminal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_fingerprint ON transactions(card_fingerprint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  event_type TEXT NOT NULL,
  partition_key TEXT,
  payload TEXT NOT NULL,
  headers TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(published_at, created_at);

CREATE TABLE IF NOT EXISTS processed_events (
  group_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (group_id, event_id)
);

CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT,
  error TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_links (
  id TEXT PRIMARY KEY,
  entity_a TEXT NOT NULL,
  entity_a_type TEXT NOT NULL,
  entity_b TEXT NOT NULL,
  entity_b_type TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (entity_a, entity_b, relation)
);
CREATE INDEX IF NOT EXISTS idx_risk_links_a ON risk_links(entity_a, relation);
CREATE INDEX IF NOT EXISTS idx_risk_links_b ON risk_links(entity_b, relation);

CREATE TABLE IF NOT EXISTS fiscal_counters (
  merchant_id TEXT NOT NULL,
  serie INTEGER NOT NULL,
  last_number INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, serie)
);

CREATE TABLE IF NOT EXISTS fiscal_documents (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  merchant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('AUTHORIZED','CONTINGENCY','REJECTED')),
  serie INTEGER NOT NULL,
  number INTEGER NOT NULL,
  access_key TEXT NOT NULL,
  protocol TEXT,
  qr_code_url TEXT,
  rejection_reason TEXT,
  contingency INTEGER NOT NULL DEFAULT 0,
  xml TEXT NOT NULL,
  danfe_text TEXT NOT NULL,
  escpos TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  issued_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pix_charges (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  merchant_id TEXT NOT NULL,
  txid TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAID','EXPIRED','CANCELED')),
  emv_payload TEXT NOT NULL,
  end_to_end_id TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  merchant_id TEXT NOT NULL,
  gross_cents INTEGER NOT NULL,
  acquirer_fee_cents INTEGER NOT NULL,
  advance_fee_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','CANCELED')),
  mode TEXT NOT NULL DEFAULT 'STANDARD' CHECK (mode IN ('STANDARD','ANTICIPATION')),
  paid_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlements_due ON settlements(status, scheduled_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource, created_at);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  kind TEXT NOT NULL CHECK (kind IN ('PF','PJ')),
  name TEXT NOT NULL,
  document TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  city TEXT,
  uf TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED')),
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, document)
);
CREATE INDEX IF NOT EXISTS idx_customers_merchant ON customers(merchant_id, name);

CREATE TABLE IF NOT EXISTS boletos (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  customer_id TEXT REFERENCES customers(id),
  transaction_id TEXT UNIQUE REFERENCES transactions(id),
  our_number TEXT NOT NULL,
  barcode TEXT NOT NULL,
  digitable_line TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  due_date TEXT NOT NULL,
  description TEXT,
  payer_name TEXT NOT NULL,
  payer_document TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID','OVERDUE','CANCELED')),
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, our_number)
);
CREATE INDEX IF NOT EXISTS idx_boletos_merchant ON boletos(merchant_id, due_date);
CREATE INDEX IF NOT EXISTS idx_boletos_status ON boletos(status, due_date);

CREATE TABLE IF NOT EXISTS payment_links (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('PIX','BOLETO')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAID','CANCELED')),
  pix_charge_id TEXT REFERENCES pix_charges(id),
  boleto_id TEXT REFERENCES boletos(id),
  transaction_id TEXT REFERENCES transactions(id),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_links_merchant ON payment_links(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  period TEXT NOT NULL CHECK (period IN ('WEEKLY','MONTHLY','QUARTERLY','YEARLY')),
  method TEXT NOT NULL CHECK (method IN ('PIX','BOLETO')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','CANCELED')),
  next_due_date TEXT NOT NULL,
  cycles INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions(status, next_due_date);

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  merchant_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID','OVERDUE','CANCELED')),
  boleto_id TEXT REFERENCES boletos(id),
  pix_charge_id TEXT REFERENCES pix_charges(id),
  transaction_id TEXT REFERENCES transactions(id),
  paid_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_invoices_merchant ON subscription_invoices(merchant_id, due_date);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS token_assets (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  kind TEXT NOT NULL CHECK (kind IN ('RWA','DEBT','BIO','DEPIN','KNOWLEDGE','COMPUTE')),
  name TEXT NOT NULL,
  symbol TEXT NOT NULL UNIQUE,
  description TEXT,
  backing_per_unit_cents INTEGER NOT NULL CHECK (backing_per_unit_cents > 0),
  supply_units INTEGER NOT NULL DEFAULT 0 CHECK (supply_units >= 0),
  max_units INTEGER NOT NULL CHECK (max_units > 0),
  reserve_cents INTEGER NOT NULL DEFAULT 0 CHECK (reserve_cents >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','REDEEMED')),
  metadata_hash TEXT NOT NULL,
  maturity_at TEXT,
  coupon_bps INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_assets_merchant ON token_assets(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS token_holdings (
  asset_id TEXT NOT NULL REFERENCES token_assets(id),
  holder_id TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, holder_id)
);

CREATE TABLE IF NOT EXISTS token_events (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES token_assets(id),
  kind TEXT NOT NULL CHECK (kind IN ('MINT','TRANSFER','REDEEM')),
  from_holder TEXT,
  to_holder TEXT,
  units INTEGER NOT NULL CHECK (units > 0),
  reserve_cents INTEGER NOT NULL DEFAULT 0,
  anchor_height INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_events_asset ON token_events(asset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS anchor_chain (
  height INTEGER PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  anchor_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bio_assets (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  name TEXT NOT NULL,
  subject_pseudonym TEXT NOT NULL,
  consent_hash TEXT NOT NULL,
  consent_scope TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  royalty_bps INTEGER NOT NULL CHECK (royalty_bps >= 0 AND royalty_bps <= 3000),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ADMITTED','REVOKED')),
  admission_proposal_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bio_royalties (
  id TEXT PRIMARY KEY,
  bio_asset_id TEXT NOT NULL REFERENCES bio_assets(id),
  payer_id TEXT NOT NULL,
  gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
  royalty_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  holder_id TEXT NOT NULL,
  anchor_height INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bio_royalties_asset ON bio_royalties(bio_asset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS depin_devices (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  model TEXT NOT NULL,
  capacity_units INTEGER NOT NULL CHECK (capacity_units > 0),
  proof_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SLASHED','RETIRED')),
  last_proof_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS depin_rewards (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES depin_devices(id),
  merchant_id TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  proof_hash TEXT NOT NULL,
  anchor_height INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dao_proposals (
  id TEXT PRIMARY KEY,
  proposer_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ADMIT_BIO_SOURCE','TREASURY_SPEND','PARAMETER_CHANGE')),
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  governance_symbol TEXT NOT NULL DEFAULT 'ADLA',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED')),
  votes_for INTEGER NOT NULL DEFAULT 0,
  votes_against INTEGER NOT NULL DEFAULT 0,
  quorum_units INTEGER NOT NULL CHECK (quorum_units > 0),
  closes_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS dao_votes (
  proposal_id TEXT NOT NULL REFERENCES dao_proposals(id),
  voter_id TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  choice TEXT NOT NULL CHECK (choice IN ('FOR','AGAINST')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, voter_id)
);

CREATE TABLE IF NOT EXISTS zk_credentials (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  commitment TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_policies (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  name TEXT NOT NULL,
  allowed_symbols TEXT NOT NULL,
  max_notional_cents INTEGER NOT NULL CHECK (max_notional_cents > 0),
  daily_limit_cents INTEGER NOT NULL CHECK (daily_limit_cents > 0),
  human_approval_above_cents INTEGER NOT NULL CHECK (human_approval_above_cents >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES agent_policies(id),
  merchant_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  symbol TEXT NOT NULL,
  notional_cents INTEGER NOT NULL CHECK (notional_cents > 0),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REVIEW','BLOCK')),
  reasons TEXT NOT NULL,
  anchor_height INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_policy ON agent_decisions(policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bridge_intents (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  rail TEXT NOT NULL CHECK (rail IN ('PIX','LIGHTNING','DREX','TCA')),
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  rate TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUOTED' CHECK (status IN ('QUOTED','SETTLED','EXPIRED')),
  expires_at TEXT NOT NULL,
  settled_at TEXT,
  anchor_height INTEGER,
  created_at TEXT NOT NULL
);
`;

const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS of_accounts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  consent_id TEXT,
  provider TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('CHECKING','SAVINGS','PAYMENT')),
  branch TEXT NOT NULL,
  account_number_masked TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  holder_document TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_of_accounts_merchant ON of_accounts(merchant_id, status);

CREATE TABLE IF NOT EXISTS of_consents (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  customer_id TEXT REFERENCES customers(id),
  account_id TEXT REFERENCES of_accounts(id),
  provider TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('DATA_SHARING','EXTERNAL_DEBIT','PAYMENT_INITIATION')),
  scopes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AWAITING_AUTHORISATION'
    CHECK (status IN ('AWAITING_AUTHORISATION','AUTHORISED','REJECTED','REVOKED','EXPIRED')),
  expires_at TEXT NOT NULL,
  authorised_at TEXT,
  revoked_at TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_of_consents_merchant ON of_consents(merchant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS of_external_debits (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  consent_id TEXT NOT NULL REFERENCES of_consents(id),
  account_id TEXT NOT NULL REFERENCES of_accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description TEXT,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED','SETTLED','FAILED','CANCELED')),
  transaction_id TEXT REFERENCES transactions(id),
  settled_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_of_debits_due ON of_external_debits(status, due_date);

CREATE TABLE IF NOT EXISTS of_payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  consent_id TEXT NOT NULL REFERENCES of_consents(id),
  account_id TEXT NOT NULL REFERENCES of_accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  pix_key TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SETTLED','FAILED','CANCELED')),
  end_to_end_id TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_of_payments_merchant ON of_payments(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS investment_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CDB','LCI','LCA','TESOURO','FUNDO')),
  issuer TEXT NOT NULL,
  indexer TEXT NOT NULL CHECK (indexer IN ('CDI','PREFIXADO','IPCA')),
  rate_bps INTEGER NOT NULL CHECK (rate_bps >= 0),
  liquidity TEXT NOT NULL CHECK (liquidity IN ('D0','D1','D30','MATURITY')),
  min_cents INTEGER NOT NULL CHECK (min_cents > 0),
  maturity_date TEXT,
  tax_exempt INTEGER NOT NULL DEFAULT 0 CHECK (tax_exempt IN (0,1)),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investment_positions (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  product_id TEXT NOT NULL REFERENCES investment_products(id),
  principal_cents INTEGER NOT NULL DEFAULT 0 CHECK (principal_cents >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REDEEMED')),
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_invest_positions_merchant ON investment_positions(merchant_id, status);

CREATE TABLE IF NOT EXISTS investment_proventos (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  position_id TEXT NOT NULL REFERENCES investment_positions(id),
  product_id TEXT NOT NULL REFERENCES investment_products(id),
  kind TEXT NOT NULL CHECK (kind IN ('DIVIDENDO','JCP','RENDIMENTO')),
  gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  net_cents INTEGER NOT NULL CHECK (net_cents > 0),
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','PAID')),
  ex_date TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proventos_due ON investment_proventos(status, payment_date);
CREATE INDEX IF NOT EXISTS idx_proventos_merchant ON investment_proventos(merchant_id, payment_date DESC);
`;

const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS bank_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  document TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN','SYSTEM')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','BLOCKED','DELETED')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  approved_by TEXT,
  approved_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bank_users_status ON bank_users(status, created_at DESC);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES bank_users(id),
  branch TEXT NOT NULL DEFAULT '0001',
  number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'CHECKING' CHECK (kind IN ('CHECKING','SAVINGS')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','CLOSED')),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  opening_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_balance_cents >= 0),
  per_transfer_limit_cents INTEGER NOT NULL DEFAULT 5000000 CHECK (per_transfer_limit_cents > 0),
  daily_limit_cents INTEGER NOT NULL DEFAULT 10000000 CHECK (daily_limit_cents > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_status ON bank_accounts(status);

CREATE TABLE IF NOT EXISTS bank_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES bank_users(id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bank_sessions_user ON bank_sessions(user_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS bank_transfers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (kind IN ('INTERNAL','FUNDING')),
  debit_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  credit_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  end_to_end_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT,
  request_hash TEXT,
  initiator_id TEXT NOT NULL,
  recipient_name TEXT,
  created_at TEXT NOT NULL,
  CHECK (debit_account_id <> credit_account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_transfers_idem
  ON bank_transfers(initiator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_transfers_debit ON bank_transfers(debit_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_transfers_credit ON bank_transfers(credit_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_transfers_created ON bank_transfers(created_at DESC);

CREATE TABLE IF NOT EXISTS bank_ledger (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES bank_transfers(id),
  account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),
  memo TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (transfer_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_bank_ledger_account ON bank_ledger(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bank_sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Espelham o modelo contábil pedido (contas / transacoes) sem duplicar escrita:
-- são views sobre o mesmo livro-razão imutável bank_ledger + bank_transfers.
CREATE VIEW IF NOT EXISTS contas AS
  SELECT a.id                    AS id,
         a.user_id               AS usuario_id,
         u.name                  AS titular,
         a.branch                AS agencia,
         a.number                AS numero,
         a.kind                  AS tipo,
         a.status                AS status,
         a.balance_cents         AS saldo_centavos,
         a.created_at            AS criada_em
    FROM bank_accounts a
    JOIN bank_users u ON u.id = a.user_id;

CREATE VIEW IF NOT EXISTS transacoes AS
  SELECT t.id                    AS id,
         t.debit_account_id      AS conta_origem_id,
         t.credit_account_id     AS conta_destino_id,
         t.amount_cents          AS valor_centavos,
         t.description           AS descricao,
         t.status                AS status,
         t.end_to_end_id         AS end_to_end_id,
         t.created_at            AS criada_em
    FROM bank_transfers t;

INSERT OR IGNORE INTO bank_sequences (name, value) VALUES ('account', 1000000);
`;

const SCHEMA_V6 = `
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_rsfn_idem
  ON bank_rsfn_messages(created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_rsfn_created_by ON bank_rsfn_messages(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_rsfn_status ON bank_rsfn_messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_bank_rsfn_transfer ON bank_rsfn_messages(transfer_id);
`;

const SCHEMA_V7 = `
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_pix_keys_value
  ON bank_pix_keys(key_type, key_value) WHERE status <> 'DELETED';
CREATE INDEX IF NOT EXISTS idx_bank_pix_keys_user ON bank_pix_keys(user_id, status, created_at DESC);
`;

const SCHEMA_V8 = `
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_credit_idem
  ON bank_credit_contracts(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_credit_user ON bank_credit_contracts(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_credit_open ON bank_credit_contracts(user_id) WHERE status = 'OPEN';

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
CREATE INDEX IF NOT EXISTS idx_bank_credit_installments_contract
  ON bank_credit_installments(contract_id, number);
CREATE INDEX IF NOT EXISTS idx_bank_credit_installments_open
  ON bank_credit_installments(status, due_date) WHERE status = 'OPEN';

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
CREATE INDEX IF NOT EXISTS idx_bank_pdv_user ON bank_pdv_sales(user_id, created_at DESC);
`;

const SCHEMA_V9 = `
CREATE TABLE IF NOT EXISTS bank_fx_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES bank_users(id),
  currency TEXT NOT NULL CHECK (currency IN ('USD','EUR')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED')),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  opening_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_balance_cents >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, currency)
);

CREATE TABLE IF NOT EXISTS bank_fx_transfers (
  id TEXT PRIMARY KEY,
  currency TEXT NOT NULL CHECK (currency IN ('USD','EUR')),
  kind TEXT NOT NULL DEFAULT 'CAPITAL' CHECK (kind IN ('CAPITAL')),
  debit_wallet_id TEXT NOT NULL REFERENCES bank_fx_wallets(id),
  credit_wallet_id TEXT NOT NULL REFERENCES bank_fx_wallets(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  idempotency_key TEXT,
  request_hash TEXT,
  initiator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (debit_wallet_id <> credit_wallet_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_fx_transfers_idem
  ON bank_fx_transfers(initiator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_fx_transfers_created ON bank_fx_transfers(created_at DESC);

CREATE TABLE IF NOT EXISTS bank_fx_entries (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES bank_fx_transfers(id),
  wallet_id TEXT NOT NULL REFERENCES bank_fx_wallets(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (transfer_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_bank_fx_entries_wallet ON bank_fx_entries(wallet_id, created_at DESC);
`;

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version >= 9) return;
  db.exec('BEGIN IMMEDIATE;');
  try {
    if (version < 1) db.exec(SCHEMA);
    if (version < 2) db.exec(SCHEMA_V2);
    if (version < 3) db.exec(SCHEMA_V3);
    if (version < 4) db.exec(SCHEMA_V4);
    if (version < 5) db.exec(SCHEMA_V5);
    if (version < 6) db.exec(SCHEMA_V6);
    if (version < 7) db.exec(SCHEMA_V7);
    if (version < 8) db.exec(SCHEMA_V8);
    if (version < 9) db.exec(SCHEMA_V9);
    db.exec('PRAGMA user_version = 9;');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

export function closeDb(db: Db): void {
  try {
    db.close();
  } catch {
    // conexão já encerrada
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // rollback best-effort
    }
    throw error;
  }
}

export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export function addDays(iso: string, days: number): string {
  return addSeconds(iso, days * 86_400);
}

export function audit(db: Db, actor: string, action: string, resource: string, metadata?: unknown): void {
  db.prepare(
    'INSERT INTO audit_log (id, actor, action, resource, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    `aud_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    actor,
    action,
    resource,
    metadata === undefined ? null : JSON.stringify(metadata),
    nowIso(),
  );
}
