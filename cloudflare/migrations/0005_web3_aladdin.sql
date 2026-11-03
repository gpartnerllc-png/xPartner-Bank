-- xPartner Bank · Edge v5 (Camada Web3 institucional + Aladdin + CCIP)
-- Migração aditiva: nenhuma tabela anterior é alterada ou removida.
-- O titular no edge é o usuário bancário (bank_users.id). Valores em centavos
-- circulam pelo ledger de dupla entrada via bank_transfers; ativos tokenizados
-- vivem em web3_holdings com escrows explícitos.

PRAGMA foreign_keys = ON;

-- ── Redes e oráculo ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS web3_networks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  chain_id INTEGER NOT NULL UNIQUE CHECK (chain_id > 0),
  kind TEXT NOT NULL CHECK (kind IN ('APPCHAIN','SUBNET','L2','L1')),
  rpc_url TEXT NOT NULL,
  explorer_url TEXT,
  native_symbol TEXT NOT NULL DEFAULT 'BRLT',
  bridge_contract TEXT,
  token_contract TEXT,
  dvp_contract TEXT,
  paymaster_contract TEXT,
  finality_seconds INTEGER NOT NULL DEFAULT 2 CHECK (finality_seconds > 0),
  governance TEXT NOT NULL DEFAULT 'XPARTNER_COUNCIL',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web3_oracle_feeds (
  symbol TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('CHAINLINK','BAND','XPARTNER')),
  decimals INTEGER NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 8),
  max_age_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (max_age_seconds > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web3_oracle_prices (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL REFERENCES web3_oracle_feeds(symbol),
  price_units INTEGER NOT NULL CHECK (price_units > 0),
  round_id INTEGER NOT NULL CHECK (round_id > 0),
  source TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (symbol, round_id)
);
CREATE INDEX IF NOT EXISTS idx_web3_oracle_prices_symbol
  ON web3_oracle_prices(symbol, published_at DESC);

-- ── Posições tokenizadas (unidades inteiras por titular) ──────────────────
CREATE TABLE IF NOT EXISTS web3_holdings (
  asset_symbol TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_symbol, holder_id)
);
CREATE INDEX IF NOT EXISTS idx_web3_holdings_holder
  ON web3_holdings(holder_id, asset_symbol);

-- ── DVP atômico ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS web3_dvp_offers (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES web3_networks(id),
  maker_id TEXT NOT NULL,
  taker_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('CASH_FOR_TOKEN','TOKEN_FOR_TOKEN')),
  sell_symbol TEXT NOT NULL,
  sell_units INTEGER NOT NULL CHECK (sell_units > 0),
  buy_symbol TEXT,
  buy_units INTEGER,
  cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_cents >= 0),
  fee_bps INTEGER NOT NULL DEFAULT 0 CHECK (fee_bps BETWEEN 0 AND 1000),
  nonce TEXT NOT NULL,
  digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FILLED','CANCELLED','EXPIRED')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (maker_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_web3_dvp_offers_status
  ON web3_dvp_offers(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_web3_dvp_offers_maker
  ON web3_dvp_offers(maker_id, created_at DESC);

CREATE TABLE IF NOT EXISTS web3_dvp_trades (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL UNIQUE REFERENCES web3_dvp_offers(id),
  network_id TEXT NOT NULL,
  maker_id TEXT NOT NULL,
  taker_id TEXT NOT NULL,
  sell_symbol TEXT NOT NULL,
  sell_units INTEGER NOT NULL CHECK (sell_units > 0),
  buy_symbol TEXT,
  buy_units INTEGER,
  cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_cents >= 0),
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  cash_transfer_id TEXT,
  fee_transfer_id TEXT,
  tx_digest TEXT NOT NULL,
  anchor_height INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web3_dvp_trades_created
  ON web3_dvp_trades(created_at DESC);

-- ── Crédito agro com colateral tokenizado ──────────────────────────────────
CREATE TABLE IF NOT EXISTS web3_agro_contracts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES web3_networks(id),
  holder_id TEXT NOT NULL,
  collateral_symbol TEXT NOT NULL,
  collateral_units INTEGER NOT NULL CHECK (collateral_units > 0),
  principal_cents INTEGER NOT NULL CHECK (principal_cents > 0),
  outstanding_cents INTEGER NOT NULL CHECK (outstanding_cents >= 0),
  interest_bps INTEGER NOT NULL CHECK (interest_bps BETWEEN 0 AND 20000),
  ltv_bps INTEGER NOT NULL CHECK (ltv_bps BETWEEN 1 AND 9000),
  liquidation_ltv_bps INTEGER NOT NULL CHECK (liquidation_ltv_bps BETWEEN 1 AND 10000),
  oracle_symbol TEXT NOT NULL REFERENCES web3_oracle_feeds(symbol),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REPAID','LIQUIDATED')),
  disbursement_transfer_id TEXT,
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_web3_agro_holder
  ON web3_agro_contracts(holder_id, status, created_at DESC);

-- ── Atestações de conformidade (modelo de emissor + nullifier) ─────────────
CREATE TABLE IF NOT EXISTS web3_zk_attestations (
  id TEXT PRIMARY KEY,
  commitment TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  predicate TEXT NOT NULL CHECK (predicate IN ('GTE','LTE','EQ')),
  threshold INTEGER NOT NULL,
  issuer TEXT NOT NULL,
  attestation_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web3_zk_attestations_commitment
  ON web3_zk_attestations(commitment, claim_type, status);

CREATE TABLE IF NOT EXISTS web3_zk_nullifiers (
  nullifier TEXT PRIMARY KEY,
  attestation_id TEXT NOT NULL REFERENCES web3_zk_attestations(id),
  purpose TEXT NOT NULL,
  relying_party TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web3_zk_nullifiers_attestation
  ON web3_zk_nullifiers(attestation_id, created_at DESC);

-- Prova Groth16 registrada no edge; a verificação criptográfica roda no core Node.
CREATE TABLE IF NOT EXISTS zk_snark_proofs (
  id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  circuit TEXT NOT NULL,
  commitment TEXT NOT NULL,
  threshold_cents INTEGER NOT NULL CHECK (threshold_cents > 0),
  proof_hash TEXT NOT NULL UNIQUE,
  public_signals TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK (verified IN (0,1)),
  verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_zk_snark_proofs_holder
  ON zk_snark_proofs(holder_id, created_at DESC);

-- ── ERC-4337: políticas, sessões de agente e paymaster ─────────────────────
CREATE TABLE IF NOT EXISTS web3_agent_policies (
  id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  label TEXT NOT NULL,
  per_action_max_cents INTEGER NOT NULL CHECK (per_action_max_cents > 0),
  daily_cap_cents INTEGER NOT NULL CHECK (daily_cap_cents > 0),
  allowed_symbols TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  created_at TEXT NOT NULL,
  UNIQUE (holder_id, label)
);

CREATE TABLE IF NOT EXISTS web3_agent_sessions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES web3_agent_policies(id),
  holder_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES web3_networks(id),
  agent TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  allowed_selectors TEXT NOT NULL,
  spend_cap_cents INTEGER NOT NULL CHECK (spend_cap_cents > 0),
  spent_cents INTEGER NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_web3_agent_sessions_holder
  ON web3_agent_sessions(holder_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS web3_agent_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES web3_agent_sessions(id),
  selector TEXT NOT NULL,
  symbol TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REVIEW','BLOCK')),
  reason TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web3_agent_actions_session
  ON web3_agent_actions(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS web3_paymaster_budgets (
  id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES web3_networks(id),
  label TEXT NOT NULL,
  cap_cents INTEGER NOT NULL CHECK (cap_cents > 0),
  spent_cents INTEGER NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  per_op_max_cents INTEGER NOT NULL CHECK (per_op_max_cents > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web3_paymaster_budgets_holder
  ON web3_paymaster_budgets(holder_id, status);

CREATE TABLE IF NOT EXISTS web3_paymaster_ops (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES web3_paymaster_budgets(id),
  user_op_hash TEXT NOT NULL UNIQUE,
  payer_id TEXT NOT NULL,
  gas_cents INTEGER NOT NULL CHECK (gas_cents > 0),
  anchor_height INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web3_paymaster_ops_budget
  ON web3_paymaster_ops(budget_id, created_at DESC);

-- ── Aladdin: risco quantitativo e crédito algorítmico ──────────────────────
CREATE TABLE IF NOT EXISTS aladdin_risk_metrics (
  id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  var_bps INTEGER NOT NULL CHECK (var_bps BETWEEN 0 AND 10000),
  volatility_bps INTEGER NOT NULL CHECK (volatility_bps BETWEEN 0 AND 100000),
  credit_score INTEGER NOT NULL CHECK (credit_score BETWEEN 0 AND 10000),
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('MONTE_CARLO','ORACLE_FUSION','OPERATOR')),
  sample_size INTEGER NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aladdin_risk_metrics_holder
  ON aladdin_risk_metrics(holder_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS aladdin_loans (
  id TEXT PRIMARY KEY,
  borrower_id TEXT NOT NULL,
  principal_cents INTEGER NOT NULL CHECK (principal_cents > 0),
  outstanding_cents INTEGER NOT NULL CHECK (outstanding_cents >= 0),
  interest_bps INTEGER NOT NULL CHECK (interest_bps BETWEEN 0 AND 20000),
  risk_metric_id TEXT NOT NULL REFERENCES aladdin_risk_metrics(id),
  attestation_id TEXT NOT NULL UNIQUE REFERENCES web3_zk_attestations(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10000),
  var_bps INTEGER NOT NULL CHECK (var_bps BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REPAID')),
  disbursement_transfer_id TEXT,
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_aladdin_loans_borrower
  ON aladdin_loans(borrower_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS aladdin_credit_events (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES aladdin_loans(id),
  kind TEXT NOT NULL CHECK (kind IN ('DISBURSEMENT','REPAYMENT','CLOSE')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  transfer_id TEXT,
  created_at TEXT NOT NULL
);

-- ── CCIP, liquidez P2P e intents cross-chain ───────────────────────────────
CREATE TABLE IF NOT EXISTS ccip_lanes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_chain_id INTEGER NOT NULL CHECK (source_chain_id > 0),
  dest_chain_id INTEGER NOT NULL CHECK (dest_chain_id > 0),
  source_selector TEXT NOT NULL,
  dest_selector TEXT NOT NULL,
  router TEXT NOT NULL,
  receiver TEXT NOT NULL,
  fee_bps INTEGER NOT NULL DEFAULT 0 CHECK (fee_bps BETWEEN 0 AND 1000),
  max_units INTEGER NOT NULL CHECK (max_units > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  created_at TEXT NOT NULL,
  UNIQUE (source_chain_id, dest_chain_id)
);

CREATE TABLE IF NOT EXISTS ccip_liquidity (
  holder_id TEXT NOT NULL,
  lane_id TEXT NOT NULL REFERENCES ccip_lanes(id),
  symbol TEXT NOT NULL,
  available_units INTEGER NOT NULL CHECK (available_units >= 0),
  rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (rate_bps BETWEEN 0 AND 2000),
  risk_tier TEXT NOT NULL DEFAULT 'B' CHECK (risk_tier IN ('A','B','C')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (holder_id, lane_id, symbol)
);

CREATE TABLE IF NOT EXISTS crosschain_intents (
  id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  lane_id TEXT NOT NULL REFERENCES ccip_lanes(id),
  symbol TEXT NOT NULL,
  amount_units INTEGER NOT NULL CHECK (amount_units > 0),
  min_dest_units INTEGER NOT NULL CHECK (min_dest_units > 0),
  fee_budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_budget_cents >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','QUOTED','SETTLED','CANCELLED','EXPIRED')),
  selected_quote_id TEXT,
  ai_model TEXT,
  deadline TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_crosschain_intents_holder
  ON crosschain_intents(holder_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS crosschain_quotes (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES crosschain_intents(id),
  solver_id TEXT NOT NULL,
  provider_holder_id TEXT NOT NULL,
  dest_units INTEGER NOT NULL CHECK (dest_units > 0),
  fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
  eta_seconds INTEGER NOT NULL CHECK (eta_seconds > 0),
  risk_bps INTEGER NOT NULL CHECK (risk_bps BETWEEN 0 AND 10000),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'OFFERED' CHECK (status IN ('OFFERED','SELECTED','REJECTED')),
  created_at TEXT NOT NULL,
  UNIQUE (intent_id, solver_id)
);
CREATE INDEX IF NOT EXISTS idx_crosschain_quotes_intent
  ON crosschain_quotes(intent_id, score DESC);

CREATE TABLE IF NOT EXISTS ccip_messages (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES crosschain_intents(id),
  quote_id TEXT NOT NULL REFERENCES crosschain_quotes(id),
  lane_id TEXT NOT NULL REFERENCES ccip_lanes(id),
  message_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL UNIQUE,
  sender_id TEXT NOT NULL,
  receiver TEXT NOT NULL,
  symbol TEXT NOT NULL,
  amount_units INTEGER NOT NULL CHECK (amount_units > 0),
  dest_units INTEGER NOT NULL CHECK (dest_units > 0),
  fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
  status TEXT NOT NULL DEFAULT 'SETTLED' CHECK (status IN ('SENT','SETTLED')),
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ccip_messages_lane
  ON ccip_messages(lane_id, sequence DESC);

-- ── Cadeia de âncoras do edge (integridade das mutações Web3) ──────────────
CREATE TABLE IF NOT EXISTS edge_anchor_chain (
  height INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  prev_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Contador de sequência das mensagens CCIP por lane.
CREATE TABLE IF NOT EXISTS web3_sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO web3_sequences (name, value) VALUES ('ccip', 0);
