import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ACTIVITY_TABLES } from '../src/demo-purge.ts';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ISO = '2026-11-03T00:00:00.000Z';

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function buildSchema(upTo?: string): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const name of migrationFiles()) {
    if (upTo && name > upTo) break;
    database.exec(readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8'));
  }
  return database;
}

/** Pai declarado por chave estrangeira em cada tabela do D1. */
function parentsOf(database: DatabaseSync, table: string): string[] {
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  if (!exists?.name) return [];
  const rows = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>;
  return [...new Set(rows.map((row) => row.table))];
}

function childFirstViolations(database: DatabaseSync, order: readonly string[]): string[] {
  const index = new Map(order.map((table, position) => [table, position]));
  const violations: string[] = [];
  for (const table of order) {
    for (const parent of parentsOf(database, table)) {
      const parentPosition = index.get(parent);
      if (parentPosition !== undefined && parentPosition < index.get(table)!) {
        violations.push(`${table} aponta para ${parent}, que sai antes`);
      }
    }
  }
  return violations;
}

function count(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Vitrine de mentira com todos os vínculos que a limpeza precisa atravessar. */
function seedVitrine(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO bank_users (id, name, document, email, password_hash, role, status, created_at, updated_at)
       VALUES ('usr_qa', 'Boneco de Teste', '23456789092', 'boneco@xpartner.test', 'x', 'USER', 'ACTIVE', ?, ?)`,
    )
    .run(ISO, ISO);
  database
    .prepare(
      `INSERT INTO bank_accounts (id, user_id, branch, number, status, balance_cents, opening_balance_cents, created_at, updated_at)
       VALUES ('acc_qa', 'usr_qa', '0001', '10000999', 'ACTIVE', 0, 0, ?, ?)`,
    )
    .run(ISO, ISO);
  database
    .prepare(
      `INSERT INTO bank_sessions (id, user_id, token_hash, csrf_token, created_at, expires_at)
       VALUES ('ses_qa', 'usr_qa', 'hash-qa', 'csrf-qa', ?, ?)`,
    )
    .run(ISO, ISO);
  database
    .prepare(
      `INSERT INTO bank_fx_wallets (id, user_id, currency, status, balance_cents, opening_balance_cents, created_at, updated_at)
       VALUES ('fx_qa', 'usr_qa', 'USD', 'ACTIVE', 0, 0, ?, ?)`,
    )
    .run(ISO, ISO);

  const treasury = database
    .prepare(
      `SELECT a.id, a.user_id AS owner FROM bank_accounts a
        WHERE a.status = 'ACTIVE' AND a.id <> 'acc_qa' ORDER BY a.balance_cents DESC LIMIT 1`,
    )
    .get() as { id: string; owner: string };
  const systemWallet = database
    .prepare("SELECT id FROM bank_fx_wallets WHERE id <> 'fx_qa' ORDER BY balance_cents DESC LIMIT 1")
    .get() as { id: string };

  database
    .prepare(
      `INSERT INTO bank_transfers
         (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
          end_to_end_id, request_hash, initiator_id, recipient_name, created_at)
       VALUES ('trf_qa', 'FUNDING', ?, 'acc_qa', 5_000, 'Aporte de vitrine', 'POSTED',
               'E2E-QA', 'hash', ?, 'Boneco de Teste', ?)`,
    )
    .run(treasury.id, treasury.owner, ISO);
  database
    .prepare(
      `INSERT INTO bank_rsfn_messages
         (id, num_ctrl_if, ispb_emissor, ispb_destinatario, dt_movto, cod_cli_emissor, documento_emissor,
          nome_emissor, agencia_destinatario, conta_destinatario, documento_destinatario, nome_destinatario,
          vlr_cents, transfer_id, xml, xml_sha256, created_by, created_at, updated_at)
       VALUES ('rsfn_qa', 'CTRL-QA', '12345678', '87654321', '2026-11-03', 'cli', '123', 'Emissor',
               '0001', '10000999', '23456789092', 'Boneco', 5000, 'trf_qa', '<x/>', 'sha', 'usr_qa', ?, ?)`,
    )
    .run(ISO, ISO);
  database
    .prepare(
      `INSERT INTO bank_fx_transfers
         (id, currency, kind, debit_wallet_id, credit_wallet_id, amount_cents, memo, status, initiator_id, created_at)
       VALUES ('fxtrf_qa', 'USD', 'FUNDING', ?, 'fx_qa', 4_000, 'Aporte internacional de vitrine', 'POSTED', 'usr_qa', ?)`,
    )
    .run(systemWallet.id, ISO);
}

const schema = buildSchema('0005_web3_aladdin.sql');

test('limpeza do edge apaga sempre o filho antes do pai', () => {
  assert.deepEqual(childFirstViolations(schema, ACTIVITY_TABLES), [], 'ACTIVITY_TABLES');
});

test('migração 0006 segue a mesma ordem de chaves estrangeiras', () => {
  const sql = readFileSync(new URL('0006_real_data_baseline.sql', MIGRATIONS_DIR), 'utf8');
  const order = [...sql.matchAll(/DELETE FROM (\w+);/g)].map((match) => match[1]);
  assert.ok(order.length > 25, 'a migração precisa cobrir os lançamentos de vitrine');
  assert.deepEqual(childFirstViolations(schema, order), [], '0006');
});

test('0006 atravessa a vitrine com dados e deixa tudo em zero', () => {
  const database = buildSchema('0005_web3_aladdin.sql');
  seedVitrine(database);

  assert.ok(count(database, 'bank_ledger') > 0, 'o aporte de vitrine deixou partidas');
  assert.ok(count(database, 'bank_fx_entries') > 0);

  database.exec(readFileSync(new URL('0006_real_data_baseline.sql', MIGRATIONS_DIR), 'utf8'));

  for (const table of ['bank_ledger', 'bank_transfers', 'bank_rsfn_messages', 'bank_fx_entries', 'bank_fx_transfers', 'bank_sessions']) {
    assert.equal(count(database, table), 0, `${table} ficou vazia`);
  }

  const boneco = database.prepare('SELECT COUNT(*) AS n FROM bank_users WHERE id = ?').get('usr_qa') as { n: number };
  assert.equal(boneco.n, 0, 'o boneco de teste sai da rede com a conta');
  const contaBoneco = database.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE id = ?').get('acc_qa') as { n: number };
  assert.equal(contaBoneco.n, 0);
  const carteiraBoneca = database.prepare('SELECT COUNT(*) AS n FROM bank_fx_wallets WHERE id = ?').get('fx_qa') as { n: number };
  assert.equal(carteiraBoneca.n, 0);

  const funded = database
    .prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE balance_cents <> 0')
    .get() as { n: number };
  assert.equal(funded.n, 0, 'nenhum saldo de mentira sobrevive');
  const fundedWallets = database
    .prepare('SELECT COUNT(*) AS n FROM bank_fx_wallets WHERE balance_cents <> 0')
    .get() as { n: number };
  assert.equal(fundedWallets.n, 0);

  const capital = database.prepare('SELECT name FROM bank_users WHERE id = ?').get('bank_user_capital') as
    | { name: string }
    | undefined;
  if (capital) assert.equal(capital.name, 'Tesouraria de capital xPartner', 'a vitrine não pode aparecer no nome');
});
