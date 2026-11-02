-- xPartner Bank · ledger unificado para PostgreSQL 16+
--
-- Complementa db/schema.postgres.sql sem alterar as tabelas operacionais.
-- O schema `ledger_core` preserva os nomes pedidos (accounts,
-- financial_transactions, fiscal_documents) sem colidir com public.accounts
-- e public.fiscal_documents, que continuam sendo o modelo do núcleo.
--
-- Valores: NUMERIC(15,4) para saldo e NUMERIC(12,2) para valor, conforme o
-- contrato unificado. O núcleo executável em SQLite usa centavos BIGINT;
-- a view transactions_bridge converte centavos em reais para conciliação.
--
-- Aplicar depois do schema principal:
--   psql "$DATABASE_URL" -f db/schema.postgres.sql
--   psql "$DATABASE_URL" -f db/schema.ledger.postgres.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA IF NOT EXISTS ledger_core;

CREATE OR REPLACE FUNCTION ledger_core.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. Contas do ledger unificado
CREATE TABLE IF NOT EXISTS ledger_core.accounts (
  account_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id VARCHAR(50) UNIQUE NOT NULL,
  balance     NUMERIC(15,4) NOT NULL DEFAULT 0.0000,
  currency    VARCHAR(3) NOT NULL DEFAULT 'BRL',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT check_positive_balance CHECK (balance >= 0),
  CONSTRAINT check_account_currency CHECK (currency ~ '^[A-Z]{3}$')
);

DROP TRIGGER IF EXISTS trg_ledger_accounts_updated ON ledger_core.accounts;
CREATE TRIGGER trg_ledger_accounts_updated
  BEFORE UPDATE ON ledger_core.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_core.touch_updated_at();

-- 2. Transações unificadas (pagamento + contexto comercial)
CREATE TABLE IF NOT EXISTS ledger_core.financial_transactions (
  transaction_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID REFERENCES ledger_core.accounts(account_id),
  nsu             VARCHAR(32) UNIQUE NOT NULL,
  payment_method  VARCHAR(20) NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  status          VARCHAR(20) NOT NULL,
  terminal_serial VARCHAR(64) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT check_transaction_amount CHECK (amount > 0),
  CONSTRAINT check_payment_method CHECK (payment_method IN ('credit_card','debit_card','pix','voucher')),
  CONSTRAINT check_transaction_status CHECK (status IN ('PENDING','APPROVED','DECLINED','FAILED','CANCELED','REFUNDED'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_account
  ON ledger_core.financial_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_terminal_created
  ON ledger_core.financial_transactions(terminal_serial, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_status
  ON ledger_core.financial_transactions(status) WHERE status IN ('PENDING','FAILED');

-- 3. Documentos fiscais vinculados em nível de banco
CREATE TABLE IF NOT EXISTS ledger_core.fiscal_documents (
  fiscal_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      UUID REFERENCES ledger_core.financial_transactions(transaction_id) ON DELETE RESTRICT,
  invoice_number      INT NOT NULL,
  invoice_series      INT NOT NULL,
  access_key          VARCHAR(44) UNIQUE,
  sefaz_status        VARCHAR(20) NOT NULL,
  fiscal_payload_json JSONB NOT NULL,
  xml_url_storage     VARCHAR(512),
  authorized_at       TIMESTAMPTZ,
  CONSTRAINT check_access_key CHECK (access_key IS NULL OR access_key ~ '^[0-9]{44}$'),
  CONSTRAINT check_sefaz_status CHECK (sefaz_status IN ('EMITIDA','CONTINGENCIA','REJEITADA')),
  CONSTRAINT check_invoice_numbers CHECK (invoice_number > 0 AND invoice_series > 0)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_transaction
  ON ledger_core.fiscal_documents(transaction_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_items
  ON ledger_core.fiscal_documents USING gin (fiscal_payload_json jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_fiscal_authorized
  ON ledger_core.fiscal_documents(authorized_at DESC) WHERE authorized_at IS NOT NULL;

-- Ponte somente-leitura com o modelo operacional em centavos.
CREATE OR REPLACE VIEW ledger_core.transactions_bridge AS
SELECT t.id                        AS transaction_id,
       t.merchant_id,
       t.terminal_id               AS terminal_serial,
       t.nsu,
       lower(t.method)             AS payment_method,
       (t.amount_cents::numeric / 100)::numeric(12,2) AS amount,
       t.status,
       t.created_at,
       f.access_key,
       f.status                    AS fiscal_status,
       f.issued_at                 AS fiscal_authorized_at
  FROM public.transactions t
  LEFT JOIN public.fiscal_documents f ON f.transaction_id = t.id;

COMMENT ON SCHEMA ledger_core IS 'Ledger unificado e documentos fiscais; complementa public.* sem substituí-lo.';
COMMENT ON VIEW ledger_core.transactions_bridge IS 'Leitura conciliada: public.transactions (centavos) + fiscal_documents.';

COMMIT;
