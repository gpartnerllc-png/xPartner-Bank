import type { Env } from './types.ts';
import { HttpError } from './http.ts';
import { audit } from './repo.ts';
import { PURGE_CONFIRM_PHRASE, QA_EMAIL_DOMAIN } from '../../src/modules/demo-purge.ts';

export { PURGE_CONFIRM_PHRASE, QA_EMAIL_DOMAIN };

/**
 * Limpeza da demonstração no D1. Mesma intenção do purge do núcleo local:
 * sobra a estrutura (titulares, contas, trilha de auditoria) e desaparece
 * tudo que o xPartner inventou para a vitrine.
 */

/**
 * Tabelas de movimento — nada aqui é cadastro do cliente.
 * A ordem importa: nenhuma chave estrangeira do D1 é ON DELETE CASCADE, então
 * o filho precisa sair antes do pai ou o lote inteiro falha.
 */
export const ACTIVITY_TABLES = [
  // conta digital do cliente
  'bank_ledger',
  'bank_rsfn_messages',
  'bank_transfers',
  'bank_fx_entries',
  'bank_fx_transfers',
  'bank_credit_installments',
  'bank_credit_contracts',
  'bank_pdv_sales',
  'bank_pix_keys',
  'bank_sessions',
  'edge_events',
  'edge_anchor_chain',
  // Web3
  'web3_holdings',
  'web3_oracle_prices',
  'web3_dvp_trades',
  'web3_dvp_offers',
  'web3_agro_contracts',
  'web3_oracle_feeds',
  'web3_zk_nullifiers',
  'web3_paymaster_ops',
  'web3_paymaster_budgets',
  'web3_agent_actions',
  'web3_agent_sessions',
  'web3_agent_policies',
  'web3_networks',
  // Aladdin (usa as attestações ZK como pai)
  'aladdin_credit_events',
  'aladdin_loans',
  'web3_zk_attestations',
  'aladdin_risk_metrics',
  // Cross-chain
  'ccip_messages',
  'crosschain_quotes',
  'crosschain_intents',
  'ccip_liquidity',
  'ccip_lanes',
  'zk_snark_proofs',
] as const;

export interface EdgePurgePreview {
  tables: Record<string, number>;
  rows: number;
  qaUsers: string[];
  accountsWithBalance: number;
  walletsWithBalance: number;
}

export interface EdgePurgeResult {
  deleted: Record<string, number>;
  zeroedAccounts: number;
  zeroedWallets: number;
  removedQaUsers: string[];
}

async function countByTable(env: Env): Promise<Record<string, number>> {
  const sql = ACTIVITY_TABLES.map((table) => `SELECT '${table}' AS table_name, COUNT(*) AS rows_count FROM ${table}`).join(
    ' UNION ALL ',
  );
  const { results } = await env.DB.prepare(sql).all<{ table_name: string; rows_count: number }>();
  const counts: Record<string, number> = {};
  for (const row of results ?? []) if (row.rows_count > 0) counts[row.table_name] = row.rows_count;
  return counts;
}

export async function previewEdgePurge(env: Env): Promise<EdgePurgePreview> {
  const tables = await countByTable(env);
  const qa = await env.DB.prepare('SELECT name FROM bank_users WHERE email LIKE ? AND role <> ?')
    .bind(`%${QA_EMAIL_DOMAIN}`, 'SYSTEM')
    .all<{ name: string }>();
  const accounts = await env.DB.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE balance_cents <> 0')
    .first<{ n: number }>();
  const wallets = await env.DB.prepare('SELECT COUNT(*) AS n FROM bank_fx_wallets WHERE balance_cents <> 0')
    .first<{ n: number }>();
  return {
    tables,
    rows: Object.values(tables).reduce((sum, value) => sum + value, 0),
    qaUsers: (qa.results ?? []).map((row) => row.name),
    accountsWithBalance: accounts?.n ?? 0,
    walletsWithBalance: wallets?.n ?? 0,
  };
}

export async function purgeEdgeDemoData(env: Env, actorId: string, confirm?: string): Promise<EdgePurgeResult> {
  if (confirm !== PURGE_CONFIRM_PHRASE) {
    throw new HttpError(
      422,
      'CONFIRMATION_REQUIRED',
      `Digite exatamente "${PURGE_CONFIRM_PHRASE}" para apagar os lançamentos de demonstração.`,
    );
  }

  const before = await countByTable(env);
  const qa = await env.DB.prepare("SELECT id FROM bank_users WHERE email LIKE ? AND role <> 'SYSTEM'")
    .bind(`%${QA_EMAIL_DOMAIN}`)
    .all<{ id: string }>();
  const qaIds = (qa.results ?? []).map((row) => row.id);
  const qaNames = await env.DB.prepare('SELECT name FROM bank_users WHERE email LIKE ? AND role <> ?')
    .bind(`%${QA_EMAIL_DOMAIN}`, 'SYSTEM')
    .all<{ name: string }>();

  const statements = ACTIVITY_TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`));
  for (const id of qaIds) {
    statements.push(
      env.DB.prepare('DELETE FROM bank_ledger WHERE account_id IN (SELECT id FROM bank_accounts WHERE user_id = ?)').bind(id),
      env.DB.prepare('DELETE FROM bank_accounts WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM bank_fx_wallets WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM bank_users WHERE id = ?').bind(id),
    );
  }
  statements.push(
    env.DB.prepare('UPDATE bank_accounts SET balance_cents = 0, opening_balance_cents = 0'),
    env.DB.prepare('UPDATE bank_fx_wallets SET balance_cents = 0, opening_balance_cents = 0'),
  );
  await env.DB.batch(statements);

  const zeroedAccounts = await env.DB.prepare('SELECT COUNT(*) AS n FROM bank_accounts').first<{ n: number }>();
  const zeroedWallets = await env.DB.prepare('SELECT COUNT(*) AS n FROM bank_fx_wallets').first<{ n: number }>();

  await audit(env, {
    actorId,
    action: 'bank.demo.purged',
    resource: 'network',
    details: {
      rows: Object.values(before).reduce((sum, value) => sum + value, 0),
      tables: Object.keys(before).length,
      accounts: zeroedAccounts?.n ?? 0,
      wallets: zeroedWallets?.n ?? 0,
      qaUsers: (qaNames.results ?? []).map((row) => row.name),
    },
  });

  return {
    deleted: before,
    zeroedAccounts: zeroedAccounts?.n ?? 0,
    zeroedWallets: zeroedWallets?.n ?? 0,
    removedQaUsers: (qaNames.results ?? []).map((row) => row.name),
  };
}

/** O Durable Object guarda os dados do lojista; o Worker só sabe o endereço interno dele. */
export async function purgeMerchantDemoData(
  env: Env,
  actorId: string,
  confirm: string | undefined,
): Promise<Record<string, unknown>> {
  const stub = env.MERCHANT.get(env.MERCHANT.idFromName('demo'));
  const response = await stub.fetch(
    new Request('https://merchant.internal/internal/admin/demo-data/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm, actor: actorId }),
    }),
  );
  const payload = (await response.json()) as { error?: { code?: string; message?: string } } & Record<string, unknown>;
  if (!response.ok) {
    throw new HttpError(
      response.status === 422 ? 422 : 502,
      payload.error?.code ?? 'MERCHANT_PURGE_FAILED',
      payload.error?.message ?? 'Núcleo do lojista não completou a limpeza.',
    );
  }
  return payload;
}

export async function previewMerchantDemoData(env: Env): Promise<Record<string, unknown>> {
  const stub = env.MERCHANT.get(env.MERCHANT.idFromName('demo'));
  const response = await stub.fetch(new Request('https://merchant.internal/internal/admin/demo-data'));
  return (await response.json()) as Record<string, unknown>;
}
