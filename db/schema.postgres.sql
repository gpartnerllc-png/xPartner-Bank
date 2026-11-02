-- xPartner Bank · schema de referência para PostgreSQL 16+
-- A implementação executável da fase 1 usa SQLite (node:sqlite) com o mesmo modelo lógico.
-- Migração de produção: executar este schema, trocar src/kernel/db.ts por um repositório
-- PostgreSQL (pg / Postgres.js) e mover o outbox para Kafka. Todos os valores monetários
-- são BIGINT em centavos — nunca NUMERIC/FLOAT para saldo.

BEGIN;

CREATE TABLE merchants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  trade_name    TEXT NOT NULL,
  document      TEXT NOT NULL UNIQUE,
  mcc           TEXT NOT NULL,
  ie            TEXT,
  crt           TEXT NOT NULL DEFAULT '1' CHECK (crt IN ('1','2','3')),
  city          TEXT NOT NULL DEFAULT 'SAO PAULO',
  uf            TEXT NOT NULL DEFAULT 'SP',
  pix_key       TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE terminals (
  id               TEXT PRIMARY KEY,
  merchant_id      TEXT NOT NULL REFERENCES merchants(id),
  serial           TEXT NOT NULL UNIQUE,
  model            TEXT NOT NULL,
  cert_fingerprint TEXT,
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','RETIRED')),
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_terminals_merchant ON terminals (merchant_id);

CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('PLATFORM','MERCHANT')),
  owner_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN (
    'ACQUIRER_RECEIVABLE','MERCHANT_PAYABLE','MERCHANT_AVAILABLE',
    'FEE_REVENUE','ANTICIPATION_REVENUE','CASH'
  )),
  currency   TEXT NOT NULL DEFAULT 'BRL',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, kind, currency)
);

CREATE TABLE ledger_entries (
  id             TEXT PRIMARY KEY,
  entry_group    TEXT NOT NULL,
  group_kind     TEXT NOT NULL,
  transaction_id TEXT,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  direction      TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
  currency       TEXT NOT NULL DEFAULT 'BRL',
  memo           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_group ON ledger_entries (entry_group);
CREATE INDEX idx_ledger_account ON ledger_entries (account_id, created_at);
CREATE INDEX idx_ledger_tx ON ledger_entries (transaction_id);

CREATE TABLE acquirers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  debit_bps         INTEGER NOT NULL,
  credit_bps        INTEGER NOT NULL,
  pix_bps           INTEGER NOT NULL,
  installments_bps  INTEGER NOT NULL DEFAULT 0,
  fixed_fee_cents   BIGINT NOT NULL DEFAULT 0,
  brands            JSONB NOT NULL,
  success_rate      REAL NOT NULL DEFAULT 0.98,
  priority          INTEGER NOT NULL DEFAULT 100,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  terminal_id         TEXT NOT NULL REFERENCES terminals(id),
  amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0),
  currency            TEXT NOT NULL DEFAULT 'BRL',
  method              TEXT NOT NULL CHECK (method IN ('CREDIT','DEBIT','PIX','VOUCHER')),
  installments        INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','DECLINED','CANCELED','REFUNDED')),
  nsu                 TEXT,
  authorization_code  TEXT,
  acquirer_id         TEXT,
  brand               TEXT,
  last4               TEXT,
  card_fingerprint    TEXT,
  risk_score          INTEGER NOT NULL DEFAULT 0,
  risk_decision       TEXT,
  risk_reasons        JSONB,
  fee_cents           BIGINT NOT NULL DEFAULT 0,
  net_cents           BIGINT NOT NULL DEFAULT 0,
  idempotency_key     TEXT,
  description         TEXT,
  items               JSONB,
  settlement_at       TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  fiscal_status       TEXT,
  failure_reason      TEXT,
  source              TEXT NOT NULL DEFAULT 'CARD',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tx_merchant_created ON transactions (merchant_id, created_at DESC);
CREATE INDEX idx_tx_terminal_created ON transactions (terminal_id, created_at DESC);
CREATE INDEX idx_tx_fingerprint ON transactions (card_fingerprint, created_at DESC);
CREATE INDEX idx_tx_status ON transactions (status);

CREATE TABLE idempotency_keys (
  scope         TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  response_json JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Transactional outbox: o evento é gravado na MESMA transação do fato de negócio.
CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  partition_key TEXT,
  payload       JSONB NOT NULL,
  headers       JSONB,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX idx_outbox_pending ON outbox (published_at, created_at) WHERE published_at IS NULL;

CREATE TABLE processed_events (
  group_id     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, event_id)
);

CREATE TABLE dead_letters (
  id         TEXT PRIMARY KEY,
  topic      TEXT NOT NULL,
  payload    JSONB,
  error      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Grafo de risco materializado: em escala, espelhar estas arestas no Neo4j/Neptune.
CREATE TABLE risk_links (
  id            TEXT PRIMARY KEY,
  entity_a      TEXT NOT NULL,
  entity_a_type TEXT NOT NULL,
  entity_b      TEXT NOT NULL,
  entity_b_type TEXT NOT NULL,
  relation      TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_a, entity_b, relation)
);
CREATE INDEX idx_risk_links_a ON risk_links (entity_a, relation);
CREATE INDEX idx_risk_links_b ON risk_links (entity_b, relation);

CREATE TABLE fiscal_counters (
  merchant_id TEXT NOT NULL,
  serie       INTEGER NOT NULL,
  last_number INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, serie)
);

CREATE TABLE fiscal_documents (
  id               TEXT PRIMARY KEY,
  transaction_id   TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  merchant_id      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('AUTHORIZED','CONTINGENCY','REJECTED')),
  serie            INTEGER NOT NULL,
  number           INTEGER NOT NULL,
  access_key       TEXT NOT NULL UNIQUE CHECK (length(access_key) = 44),
  protocol         TEXT,
  qr_code_url      TEXT,
  rejection_reason TEXT,
  contingency      BOOLEAN NOT NULL DEFAULT false,
  xml              TEXT NOT NULL,
  danfe_text       TEXT NOT NULL,
  escpos           TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 1,
  issued_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fiscal_merchant_created ON fiscal_documents (merchant_id, created_at DESC);

CREATE TABLE pix_charges (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  merchant_id    TEXT NOT NULL,
  txid           TEXT NOT NULL UNIQUE,
  amount_cents   BIGINT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ACTIVE','PAID','EXPIRED','CANCELED')),
  emv_payload    TEXT NOT NULL,
  end_to_end_id  TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  paid_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settlements (
  id                 TEXT PRIMARY KEY,
  transaction_id     TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  merchant_id        TEXT NOT NULL,
  gross_cents        BIGINT NOT NULL,
  acquirer_fee_cents BIGINT NOT NULL,
  advance_fee_cents  BIGINT NOT NULL DEFAULT 0,
  net_cents          BIGINT NOT NULL,
  scheduled_at       TIMESTAMPTZ NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('PENDING','PAID','CANCELED')),
  mode               TEXT NOT NULL DEFAULT 'STANDARD' CHECK (mode IN ('STANDARD','ANTICIPATION')),
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_settlements_due ON settlements (status, scheduled_at);

CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  resource   TEXT NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_resource ON audit_log (resource, created_at DESC);

-- Invariantes recomendadas (aplicar como constraint trigger ou job de reconciliação):
-- 1. Para cada entry_group, SUM(DEBIT) = SUM(CREDIT).
-- 2. transações APPROVED possuem exatamente um fiscal_document e um settlement.
-- 3. settlements.net_cents = gross_cents - acquirer_fee_cents (ou - advance_fee_cents).
-- 4. ledger_entries nunca são UPDATE/DELETE; correções são novos lançamentos.

COMMIT;
