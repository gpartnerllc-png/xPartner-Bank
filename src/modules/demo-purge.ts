import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';

/**
 * Limpeza dos dados de demonstração. Existe porque a rede passou a mostrar
 * apenas fatos reais: nada de venda, cobrança, consentimento ou saldo de
 * laboratório pode sobreviver ao lado do que o cliente realmente lançou.
 */

/** Usuários criados por testes/QA de interface, nunca pelo dono da conta. */
export const QA_EMAIL_DOMAIN = '@xpartner.test';

/** Frase que precisa ser digitada igual — ninguém apaga por engano. */
export const PURGE_CONFIRM_PHRASE = 'APAGAR DADOS DE DEMONSTRACAO';

/**
 * Ordem de apagamento: folha antes de pai. Nenhuma chave estrangeira do núcleo
 * é ON DELETE CASCADE, então apagar um pai com filho vivo aborta a transação.
 * Os quatro conjuntos abaixo são percorridos nesta exata sequência.
 */

/** Conta digital do cliente. */
const BANK_ACTIVITY = [
  'bank_fx_entries',
  'bank_fx_transfers',
  'bank_ledger',
  'bank_rsfn_messages',
  'bank_credit_installments',
  'bank_credit_contracts',
  'bank_pdv_sales',
  'bank_pix_keys',
  'bank_sessions',
  'bank_transfers',
];

/** Open Finance e investimentos de vitrine (apontam para transações e clientes). */
const RELATIONSHIP_ACTIVITY = [
  'of_external_debits',
  'of_payments',
  'of_consents',
  'of_accounts',
  'investment_proventos',
  'investment_positions',
  'investment_products',
];

/** Movimentos do lojista (aquisição, cobrança, fiscal, risco). */
const MERCHANT_ACTIVITY = [
  'subscription_invoices',
  'payment_links',
  'boletos',
  'subscriptions',
  'pix_charges',
  'settlements',
  'fiscal_documents',
  'transactions',
  'customers',
  'ledger_entries',
  'risk_links',
  'idempotency_keys',
  'outbox',
  'processed_events',
  'dead_letters',
];

/** Tokenização, Web3, Aladdin e CCIP demonstrativos. */
const PLATFORM_ACTIVITY = [
  'token_events',
  'token_holdings',
  'token_assets',
  'anchor_chain',
  'edge_anchor_chain',
  'bio_royalties',
  'bio_assets',
  'depin_rewards',
  'depin_devices',
  'dao_votes',
  'dao_proposals',
  'agent_decisions',
  'web3_agent_actions',
  'web3_agent_sessions',
  'agent_policies',
  'web3_agent_policies',
  'bridge_intents',
  'web3_dvp_trades',
  'web3_dvp_offers',
  'web3_agro_contracts',
  'web3_oracle_prices',
  'web3_oracle_feeds',
  'web3_paymaster_ops',
  'web3_paymaster_budgets',
  'web3_zk_nullifiers',
  'web3_zk_attestations',
  'aladdin_credit_events',
  'aladdin_loans',
  'zk_snark_proofs',
  'aladdin_risk_metrics',
  'ccip_messages',
  'crosschain_quotes',
  'crosschain_intents',
  'ccip_liquidity',
  'ccip_lanes',
  'web3_holdings',
  'web3_networks',
];

/** Sequência única de apagamento, respeitando as chaves estrangeiras. */
const PURGE_TABLES = [...BANK_ACTIVITY, ...RELATIONSHIP_ACTIVITY, ...MERCHANT_ACTIVITY, ...PLATFORM_ACTIVITY];


export interface PurgeResult {
  deleted: Record<string, number>;
  zeroedAccounts: number;
  zeroedWallets: number;
  removedQaUsers: string[];
}

export interface PurgePreview {
  tables: Record<string, number>;
  rows: number;
  qaUsers: string[];
  accountsWithBalance: number;
  walletsWithBalance: number;
}

function countRows(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function countFunded(db: Db, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE balance_cents <> 0`)
    .get() as { n: number };
  return row.n;
}

/** O que a limpeza vai alcançar — mostrado antes de qualquer escrita. */
export function previewPurge(db: Db): PurgePreview {
  const tables: Record<string, number> = {};
  for (const table of PURGE_TABLES) {
    if (!tableExists(db, table)) continue;
    const n = countRows(db, table);
    if (n > 0) tables[table] = n;
  }
  const qaUsers = tableExists(db, 'bank_users')
    ? (
        db
          .prepare('SELECT name FROM bank_users WHERE email LIKE ? AND role <> ?')
          .all(`%${QA_EMAIL_DOMAIN}`, 'SYSTEM') as Array<{ name: string }>
      ).map((row) => row.name)
    : [];
  return {
    tables,
    rows: Object.values(tables).reduce((sum, value) => sum + value, 0),
    qaUsers,
    accountsWithBalance: countFunded(db, 'bank_accounts'),
    walletsWithBalance: countFunded(db, 'bank_fx_wallets'),
  };
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function deleteFrom(db: Db, table: string, counts: Record<string, number>): void {
  if (!tableExists(db, table)) return;
  const changes = Number(db.prepare(`DELETE FROM ${table}`).run().changes);
  if (changes > 0) counts[table] = changes;
}
export function purgeDemoData(db: Db, options: { actor?: string } = {}): PurgeResult {
  const actor = options.actor ?? 'system';
  const deleted: Record<string, number> = {};
  let zeroedAccounts = 0;
  let zeroedWallets = 0;
  let removedQaUsers: string[] = [];

  tx(db, () => {
    for (const table of PURGE_TABLES) {
      deleteFrom(db, table, deleted);
    }

    // Os usuários de teste só podem sair depois de apagados os movimentos que
    // apontam para as contas deles — as chaves estrangeiras não têm cascade.
    if (tableExists(db, 'bank_users')) {
      const qa = db
        .prepare('SELECT id, name FROM bank_users WHERE email LIKE ? AND role <> ?')
        .all(`%${QA_EMAIL_DOMAIN}`, 'SYSTEM') as Array<{ id: string; name: string }>;
      removedQaUsers = qa.map((row) => row.name);
      for (const user of qa) {
        if (tableExists(db, 'bank_fx_wallets')) {
          db.prepare('DELETE FROM bank_fx_wallets WHERE user_id = ?').run(user.id);
        }
        if (tableExists(db, 'bank_accounts')) {
          db.prepare('DELETE FROM bank_accounts WHERE user_id = ?').run(user.id);
        }
        db.prepare('DELETE FROM bank_users WHERE id = ?').run(user.id);
      }
    }

    if (tableExists(db, 'bank_accounts')) {
      zeroedAccounts = Number(
        db.prepare('UPDATE bank_accounts SET balance_cents = 0, opening_balance_cents = 0').run().changes,
      );
    }
    if (tableExists(db, 'bank_fx_wallets')) {
      zeroedWallets = Number(
        db.prepare('UPDATE bank_fx_wallets SET balance_cents = 0, opening_balance_cents = 0').run().changes,
      );
    }

    audit(db, actor, 'DEMO_DATA_PURGED', 'network', {
      tables: Object.keys(deleted).length,
      rows: Object.values(deleted).reduce((sum, value) => sum + value, 0),
      zeroedAccounts,
      zeroedWallets,
      removedQaUsers,
      at: nowIso(),
    });
  });

  return { deleted, zeroedAccounts, zeroedWallets, removedQaUsers };
}
