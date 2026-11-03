/**
 * Zera a rede para o modo de fatos reais.
 *
 *   npm run purge:demo -- --dry-run
 *   npm run purge:demo -- --confirm "APAGAR DADOS DE DEMONSTRACAO"
 *
 * Apaga lançamentos de demonstração (vendas, cobranças, fiscal, tokens,
 * Open Finance, investimentos, conta digital) e os usuários de teste criados
 * pela interface. Não remove a estrutura: comerciantes, terminais, adquirentes,
 * contas contábeis, usuários reais e a trilha de auditoria continuam.
 * Antes de qualquer escrita, o script grava uma cópia do banco em
 * .data/backups e exige a frase de confirmação.
 */
import { loadConfig } from '../src/config.ts';
import { closeDb, migrate } from '../src/kernel/db.ts';
import { openDb } from '../src/kernel/db-node.ts';
import { purgeDemoData, previewPurge, QA_EMAIL_DOMAIN, PURGE_CONFIRM_PHRASE } from '../src/modules/demo-purge.ts';
import { ledgerTrialBalance } from '../src/modules/bank.ts';
import { formatBRL } from '../src/kernel/money.ts';

const CONFIRM_PHRASE = PURGE_CONFIRM_PHRASE;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const hasFlag = (name: string) => process.argv.includes(`--${name}`);
const dbPath = arg('db') ?? process.env.DB_PATH ?? '.data/xpartner.db';

const config = loadConfig({ ...process.env, DB_PATH: dbPath, SEED_DEMO: 'false' });
const db = openDb(config.dbPath);
migrate(db);

console.log(`Banco: ${config.dbPath}`);
const preview = previewPurge(db);
console.log(`Linhas de demonstração na mira: ${preview.rows}`);
console.log(`Saldos que serão zerados: ${preview.accountsWithBalance} conta(s) corrente(s) · ${preview.walletsWithBalance} carteira(s) internacional(is).`);
if (preview.qaUsers.length) console.log(`Usuários de teste que saem da rede: ${preview.qaUsers.join(', ')}.`);
for (const [table, rows] of Object.entries(preview.tables)) console.log(`  ${table.padEnd(28)} ${rows}`);

const titular = db
  .prepare(
    `SELECT u.name, u.email, a.balance_cents
       FROM bank_users u
       LEFT JOIN bank_accounts a ON a.user_id = u.id
      WHERE u.role <> 'SYSTEM'
      ORDER BY u.created_at`,
  )
  .all() as Array<{ name: string; email: string | null; balance_cents: number | null }>;
console.log('Titulares da conta digital:');
for (const row of titular) {
  console.log(
    `  ${row.name} · ${row.email ?? '-'} · ${formatBRL(row.balance_cents ?? 0)}` +
      (row.email?.endsWith(QA_EMAIL_DOMAIN) ? ' · USUÁRIO DE TESTE (será removido)' : ''),
  );
}

if (hasFlag('dry-run')) {
  console.log('\nNada foi alterado (--dry-run).');
  closeDb(db);
  process.exit(0);
}

if (arg('confirm') !== CONFIRM_PHRASE) {
  console.error(
    `\nConfirmação obrigatória. Rode com --confirm "${CONFIRM_PHRASE}".\nNenhum dado foi alterado.`,
  );
  closeDb(db);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `.data/backups/xpartner-pre-purge-${stamp}.db`;
db.prepare(`VACUUM INTO ?`).run(backupPath);
console.log(`\nCópia de segurança: ${backupPath}`);

const result = purgeDemoData(db, { actor: 'script:purge-demo' });

console.log('\nLinhas removidas:');
for (const [table, rows] of Object.entries(result.deleted)) console.log(`  ${table.padEnd(28)} ${rows}`);
console.log(`\nContas correntes zeradas: ${result.zeroedAccounts}`);
console.log(`Carteiras em moeda estrangeira zeradas: ${result.zeroedWallets}`);
console.log(`Usuários de teste removidos: ${result.removedQaUsers.length}`);

const ledger = ledgerTrialBalance(db);
console.log(
  `Ledger bancário ${ledger.balanced ? 'balanceado' : 'DIVERGENTE'} · débito ${formatBRL(ledger.debitCents)} · crédito ${formatBRL(ledger.creditCents)}.`,
);
if (!ledger.balanced) process.exitCode = 1;

closeDb(db);
