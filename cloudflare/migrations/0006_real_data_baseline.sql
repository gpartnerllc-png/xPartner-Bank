-- 0006 — Baseline de fatos reais no edge.
--
-- A rede passou a mostrar apenas o que o titular realmente lançou. Esta
-- migração apaga os lançamentos de demonstração e zera todos os saldos
-- (inclusive os das contas de sistema que serviam de lastro para a vitrine),
-- preservando cadastros, estrutura de contas e a trilha de auditoria.
-- Não remove nem altera nenhuma tabela.

DELETE FROM bank_ledger;
DELETE FROM bank_rsfn_messages;
DELETE FROM bank_transfers;
DELETE FROM bank_fx_entries;
DELETE FROM bank_fx_transfers;
DELETE FROM bank_credit_installments;
DELETE FROM bank_credit_contracts;
DELETE FROM bank_pdv_sales;
DELETE FROM bank_pix_keys;
DELETE FROM bank_sessions;
DELETE FROM edge_events;
DELETE FROM edge_anchor_chain;

DELETE FROM web3_holdings;
DELETE FROM web3_oracle_prices;
DELETE FROM web3_dvp_trades;
DELETE FROM web3_dvp_offers;
DELETE FROM web3_agro_contracts;
DELETE FROM web3_oracle_feeds;
DELETE FROM web3_zk_nullifiers;
DELETE FROM web3_paymaster_ops;
DELETE FROM web3_paymaster_budgets;
DELETE FROM web3_agent_actions;
DELETE FROM web3_agent_sessions;
DELETE FROM web3_agent_policies;
DELETE FROM web3_networks;

-- Aladdin usa as attestações ZK como pai: os contratos saem antes delas.
DELETE FROM aladdin_credit_events;
DELETE FROM aladdin_loans;
DELETE FROM web3_zk_attestations;
DELETE FROM aladdin_risk_metrics;

-- Cross-chain: cotações apontam para intents e todos apontam para as lanes.
DELETE FROM ccip_messages;
DELETE FROM crosschain_quotes;
DELETE FROM crosschain_intents;
DELETE FROM ccip_liquidity;
DELETE FROM ccip_lanes;
DELETE FROM zk_snark_proofs;

-- Contas de teste/QA da interface: saem da rede com a conta e a carteira.
DELETE FROM bank_ledger WHERE account_id IN (
  SELECT id FROM bank_accounts
   WHERE user_id IN (
     SELECT id FROM bank_users WHERE email LIKE '%@xpartner.test' AND role <> 'SYSTEM'
   )
);
DELETE FROM bank_accounts WHERE user_id IN (
  SELECT id FROM bank_users WHERE email LIKE '%@xpartner.test' AND role <> 'SYSTEM'
);
DELETE FROM bank_fx_wallets WHERE user_id IN (
  SELECT id FROM bank_users WHERE email LIKE '%@xpartner.test' AND role <> 'SYSTEM'
);
DELETE FROM bank_users WHERE email LIKE '%@xpartner.test' AND role <> 'SYSTEM';

-- Todo saldo recomeça em zero; o que entrar a partir daqui é lançamento real.
UPDATE bank_accounts SET balance_cents = 0, opening_balance_cents = 0;
UPDATE bank_fx_wallets SET balance_cents = 0, opening_balance_cents = 0;

UPDATE bank_users SET name = 'Tesouraria de capital xPartner' WHERE id = 'bank_user_capital';
