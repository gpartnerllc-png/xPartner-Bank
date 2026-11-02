import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(new URL('../migrations/0001_bank.sql', import.meta.url), 'utf8');

function db(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(migration);
  return database;
}

function seedAccount(database: DatabaseSync, id: string, userId: string, number: string, balance: number): void {
  database
    .prepare(
      `INSERT INTO bank_users (id, name, document, email, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'x', 'USER', 'ACTIVE', '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z')`,
    )
    .run(userId, `Cliente ${id}`, `doc-${id}`, `${id}@test.local`);
  database
    .prepare(
      `INSERT INTO bank_accounts (id, user_id, branch, number, status, balance_cents, opening_balance_cents, created_at, updated_at)
       VALUES (?, ?, '0001', ?, 'ACTIVE', ?, ?, '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z')`,
    )
    .run(id, userId, number, balance, balance);
}

function transfer(database: DatabaseSync, input: { id: string; debit: string; credit: string; amount: number; key?: string }): void {
  database
    .prepare(
      `INSERT INTO bank_transfers
        (id, kind, debit_account_id, credit_account_id, amount_cents, description, status, end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at)
       VALUES (?, 'INTERNAL', ?, ?, ?, 'teste', 'POSTED', ?, ?, 'hash', (SELECT user_id FROM bank_accounts WHERE id = ?), 'Favorecido', '2026-10-31T12:00:00.000Z')`,
    )
    .run(input.id, input.debit, input.credit, input.amount, `E2E-${input.id}`, input.key ?? null, input.debit);
}

function balance(database: DatabaseSync, id: string): number {
  return (database.prepare('SELECT balance_cents AS value FROM bank_accounts WHERE id = ?').get(id) as { value: number }).value;
}

test('trigger posta débito e crédito com saldo após cada partida', () => {
  const database = db();
  seedAccount(database, 'acc_a', 'user_a', '10000010', 100_000);
  seedAccount(database, 'acc_b', 'user_b', '10000020', 0);
  transfer(database, { id: 'trf_1', debit: 'acc_a', credit: 'acc_b', amount: 25_000 });

  assert.equal(balance(database, 'acc_a'), 75_000);
  assert.equal(balance(database, 'acc_b'), 25_000);
  const entries = (
    database
      .prepare('SELECT direction, account_id, amount_cents, balance_after_cents FROM bank_ledger WHERE transfer_id = ? ORDER BY direction')
      .all('trf_1') as Array<{ direction: string; account_id: string; amount_cents: number; balance_after_cents: number }>
  ).map((row) => ({ ...row }));
  assert.deepEqual(entries, [
    { direction: 'CREDIT', account_id: 'acc_b', amount_cents: 25_000, balance_after_cents: 25_000 },
    { direction: 'DEBIT', account_id: 'acc_a', amount_cents: 25_000, balance_after_cents: 75_000 },
  ]);

  const trial = database.prepare('SELECT SUM(amount_cents) AS total FROM bank_ledger').get() as { total: number };
  assert.equal(trial.total, 50_000, 'duas partidas de mesmo valor');
});

test('saldo insuficiente aborta a transferência inteira', () => {
  const database = db();
  seedAccount(database, 'acc_a', 'user_a', '10000010', 1_000);
  seedAccount(database, 'acc_b', 'user_b', '10000020', 0);
  assert.throws(() => transfer(database, { id: 'trf_x', debit: 'acc_a', credit: 'acc_b', amount: 5_000 }), /INSUFFICIENT_FUNDS/);
  assert.equal(balance(database, 'acc_a'), 1_000);
  assert.equal(balance(database, 'acc_b'), 0);
  const count = database.prepare('SELECT COUNT(*) AS n FROM bank_transfers').get() as { n: number };
  assert.equal(count.n, 0, 'nenhum rastro parcial');
});

test('transferência para si é bloqueada pelo CHECK', () => {
  const database = db();
  seedAccount(database, 'acc_a', 'user_a', '10000010', 1_000);
  assert.throws(() => transfer(database, { id: 'trf_self', debit: 'acc_a', credit: 'acc_a', amount: 100 }), /CHECK/);
});

test('idempotência é única por iniciador', () => {
  const database = db();
  seedAccount(database, 'acc_a', 'user_a', '10000010', 10_000);
  seedAccount(database, 'acc_b', 'user_b', '10000020', 0);
  transfer(database, { id: 'trf_1', debit: 'acc_a', credit: 'acc_b', amount: 100, key: 'idem-1' });
  assert.throws(
    () => transfer(database, { id: 'trf_2', debit: 'acc_a', credit: 'acc_b', amount: 100, key: 'idem-1' }),
    /UNIQUE/,
  );
});

test('views contas e transacoes expõem o contrato em português', () => {
  const database = db();
  seedAccount(database, 'acc_a', 'user_a', '10000010', 10_000);
  seedAccount(database, 'acc_b', 'user_b', '10000020', 0);
  transfer(database, { id: 'trf_1', debit: 'acc_a', credit: 'acc_b', amount: 2_500 });

  const conta = database.prepare('SELECT titular, numero, saldo_centavos FROM contas WHERE id = ?').get('acc_a') as {
    titular: string;
    numero: string;
    saldo_centavos: number;
  };
  assert.equal(conta.titular, 'Cliente acc_a');
  assert.equal(conta.numero, '10000010');
  assert.equal(conta.saldo_centavos, 7_500);

  const transacao = database
    .prepare('SELECT valor_centavos, conta_origem_id, conta_destino_id FROM transacoes WHERE id = ?')
    .get('trf_1') as { valor_centavos: number; conta_origem_id: string; conta_destino_id: string };
  assert.equal(transacao.valor_centavos, 2_500);
  assert.equal(transacao.conta_origem_id, 'acc_a');
  assert.equal(transacao.conta_destino_id, 'acc_b');
});
