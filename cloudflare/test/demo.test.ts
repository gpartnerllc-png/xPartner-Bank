import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrations = [
  '0001_bank.sql',
  '0002_demo_capital_fx.sql',
  '0003_edge_parity.sql',
  '0004_fix_transfer_trigger.sql',
].map((file) =>
  readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
);

function db(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrations) database.exec(migration);
  return database;
}

function seedCustomer(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `INSERT INTO bank_users (id, name, document, email, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'x', 'ADMIN', 'ACTIVE', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    )
    .run(id, `Titular ${id}`, `doc-${id}`, `${id}@test.local`);
  database
    .prepare(
      `INSERT INTO bank_accounts (id, user_id, branch, number, kind, status, balance_cents, opening_balance_cents, created_at, updated_at)
       VALUES (?, ?, '0001', ?, 'CHECKING', 'ACTIVE', 0, 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    )
    .run(`acc_${id}`, id, `1000${id.slice(-4)}`);
}

test('capital de laboratório nasce com R$ 100 bi e financia R$ 2 bi', () => {
  const database = db();
  seedCustomer(database, 'user_a');

  const capital = database
    .prepare("SELECT balance_cents AS value FROM bank_accounts WHERE id = 'bank_acc_capital'")
    .get() as { value: number };
  assert.equal(capital.value, 10_000_000_000_000);

  database
    .prepare(
      `INSERT INTO bank_transfers
        (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
         end_to_end_id, initiator_id, recipient_name, created_at)
       VALUES ('trf_cap', 'FUNDING', 'bank_acc_capital', 'acc_user_a', 200000000000,
               'Capital inicial de demonstração', 'POSTED', 'E2E-CAP', 'user_a', 'user_a',
               '2026-11-01T12:00:00.000Z')`,
    )
    .run();

  const account = database
    .prepare("SELECT balance_cents AS value, opening_balance_cents AS opening FROM bank_accounts WHERE id = 'acc_user_a'")
    .get() as { value: number; opening: number };
  assert.equal(account.value, 200_000_000_000);
  assert.equal(account.opening, 0, 'saldo vem do aporte, não de número fabricado');

  const entries = (
    database
      .prepare("SELECT direction, amount_cents FROM bank_ledger WHERE transfer_id = 'trf_cap' ORDER BY direction")
      .all() as Array<{ direction: string; amount_cents: number }>
  ).map((row) => ({ ...row }));
  assert.deepEqual(entries, [
    { direction: 'CREDIT', amount_cents: 200_000_000_000 },
    { direction: 'DEBIT', amount_cents: 200_000_000_000 },
  ]);
});

test('carteira USD nasce com US$ 100 bi e posta US$ 3 bi com duas partidas', () => {
  const database = db();
  seedCustomer(database, 'user_a');

  database
    .prepare(
      `INSERT INTO bank_fx_wallets
        (id, user_id, currency, status, balance_cents, opening_balance_cents, created_at, updated_at)
       VALUES ('fxw_user_a', 'user_a', 'USD', 'ACTIVE', 0, 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    )
    .run();

  const treasury = database
    .prepare("SELECT balance_cents AS value FROM bank_fx_wallets WHERE id = 'bank_fx_system_usd'")
    .get() as { value: number };
  assert.equal(treasury.value, 10_000_000_000_000);

  database
    .prepare(
      `INSERT INTO bank_fx_transfers
        (id, currency, kind, debit_wallet_id, credit_wallet_id, amount_cents, memo, status, initiator_id, created_at)
       VALUES ('fxt_1', 'USD', 'FUNDING', 'bank_fx_system_usd', 'fxw_user_a', 300000000000,
               'Capital internacional de demonstração', 'POSTED', 'user_a', '2026-11-01T12:00:00.000Z')`,
    )
    .run();

  const wallet = database
    .prepare("SELECT balance_cents AS value FROM bank_fx_wallets WHERE id = 'fxw_user_a'")
    .get() as { value: number };
  assert.equal(wallet.value, 300_000_000_000);

  const entries = (
    database
      .prepare("SELECT direction, amount_cents FROM bank_fx_entries WHERE transfer_id = 'fxt_1' ORDER BY direction")
      .all() as Array<{ direction: string; amount_cents: number }>
  ).map((row) => ({ ...row }));
  assert.deepEqual(entries, [
    { direction: 'CREDIT', amount_cents: 300_000_000_000 },
    { direction: 'DEBIT', amount_cents: 300_000_000_000 },
  ]);
});

test('carteira USD sem saldo aborta a operação inteira', () => {
  const database = db();
  seedCustomer(database, 'user_a');
  database
    .prepare(
      `INSERT INTO bank_fx_wallets
        (id, user_id, currency, status, balance_cents, opening_balance_cents, created_at, updated_at)
       VALUES ('fxw_user_a', 'user_a', 'USD', 'ACTIVE', 1_000, 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    )
    .run();
  database.prepare("UPDATE bank_fx_wallets SET balance_cents = 0 WHERE id = 'bank_fx_system_usd'").run();

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO bank_fx_transfers
            (id, currency, kind, debit_wallet_id, credit_wallet_id, amount_cents, memo, status, initiator_id, created_at)
           VALUES ('fxt_x', 'USD', 'FUNDING', 'bank_fx_system_usd', 'fxw_user_a', 500,
                   'teste', 'POSTED', 'user_a', '2026-11-01T12:00:00.000Z')`,
        )
        .run(),
    /FX_INSUFFICIENT_FUNDS/,
  );

  const wallet = database
    .prepare("SELECT balance_cents AS value FROM bank_fx_wallets WHERE id = 'fxw_user_a'")
    .get() as { value: number };
  assert.equal(wallet.value, 1_000, 'nenhum rastro parcial');
});

test('migração v3 preserva o canal INTERNAL e cria a câmara RSFN sem saldo', () => {
  const database = db();
  seedCustomer(database, 'user_a');

  const rsfnUser = database
    .prepare("SELECT role, status FROM bank_users WHERE id = 'bank_user_rsfn'")
    .get() as { role: string; status: string };
  assert.deepEqual({ ...rsfnUser }, { role: 'SYSTEM', status: 'ACTIVE' });

  const rsfnAccount = database
    .prepare(
      "SELECT balance_cents AS value, per_transfer_limit_cents AS max_limit FROM bank_accounts WHERE id = 'bank_acc_rsfn'",
    )
    .get() as { value: number; max_limit: number };
  assert.equal(rsfnAccount.value, 0);
  assert.equal(rsfnAccount.max_limit, 100_000_000);

  database
    .prepare(
      `INSERT INTO bank_transfers
        (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
         end_to_end_id, initiator_id, recipient_name, created_at)
       VALUES ('trf_channel', 'FUNDING', 'bank_acc_capital', 'acc_user_a', 100_000,
               'canal padrão', 'POSTED', 'E2E-CHANNEL', 'user_a', 'user_a', '2026-11-01T12:00:00.000Z')`,
    )
    .run();
  const channel = database
    .prepare("SELECT channel FROM bank_transfers WHERE id = 'trf_channel'")
    .get() as { channel: string };
  assert.equal(channel.channel, 'INTERNAL');
});

test('chave Pix ativa é única, mas pode ser recriada depois de removida', () => {
  const database = db();
  seedCustomer(database, 'user_a');
  const insert = database.prepare(
    `INSERT INTO bank_pix_keys (id, user_id, key_type, key_value, key_masked, label, status, created_at, updated_at)
     VALUES (?, 'user_a', 'EMAIL', 'titular@test.local', 't***@test.local', 'principal', ?, '2026-11-01T12:00:00.000Z', '2026-11-01T12:00:00.000Z')`,
  );
  insert.run('pix_1', 'ACTIVE');
  assert.throws(() => insert.run('pix_2', 'ACTIVE'), /UNIQUE/);
  database
    .prepare(
      "UPDATE bank_pix_keys SET status = 'DELETED', deleted_at = '2026-11-01T13:00:00.000Z' WHERE id = 'pix_1'",
    )
    .run();
  insert.run('pix_2', 'ACTIVE');
  const active = database
    .prepare("SELECT id FROM bank_pix_keys WHERE status = 'ACTIVE'")
    .all() as Array<{ id: string }>;
  assert.deepEqual(
    active.map((row) => row.id),
    ['pix_2'],
  );
});

test('crédito e RSFN postam saldo pela dupla entrada existente', () => {
  const database = db();
  seedCustomer(database, 'user_a');

  database.exec('BEGIN');
  database
    .prepare(
      `INSERT INTO bank_credit_contracts
        (id, user_id, account_id, contract_number, product, requested_cents, principal_cents,
         total_due_cents, outstanding_cents, monthly_rate_bps, installments, score, created_at, updated_at)
       VALUES ('crd_1', 'user_a', 'acc_user_a', 'CR-1001', 'EMPRESTIMO', 50_000, 50_000,
               55_000, 55_000, 320, 2, 700, '2026-11-01T12:00:00.000Z', '2026-11-01T12:00:00.000Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO bank_credit_installments
        (id, contract_id, number, due_date, principal_cents, interest_cents, total_cents, status)
       VALUES ('crd_1_1', 'crd_1', 1, '2026-12-01', 25_000, 2_500, 27_500, 'OPEN')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO bank_transfers
        (id, kind, channel, debit_account_id, credit_account_id, amount_cents, description, status,
         end_to_end_id, initiator_id, recipient_name, created_at)
       VALUES ('trf_credit', 'FUNDING', 'CREDIT', 'bank_acc_system', 'acc_user_a', 50_000,
               'Crédito liberado', 'POSTED', 'E2E-CREDIT', 'user_a', 'user_a', '2026-11-01T12:00:00.000Z')`,
    )
    .run();
  database.exec('COMMIT');

  const funded = database
    .prepare("SELECT balance_cents AS value FROM bank_accounts WHERE id = 'acc_user_a'")
    .get() as { value: number };
  assert.equal(funded.value, 50_000);

  database
    .prepare(
      `INSERT INTO bank_transfers
        (id, kind, channel, debit_account_id, credit_account_id, amount_cents, description, status,
         end_to_end_id, initiator_id, recipient_name, created_at)
       VALUES ('trf_rsfn', 'INTERNAL', 'RSFN', 'acc_user_a', 'bank_acc_rsfn', 20_000,
               'RSFN PAG0004', 'POSTED', 'E2E-RSFN', 'user_a', 'Câmara RSFN', '2026-11-01T12:05:00.000Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO bank_rsfn_messages
        (id, num_ctrl_if, ispb_emissor, ispb_destinatario, dt_movto, cod_cli_emissor,
         documento_emissor, nome_emissor, agencia_destinatario, conta_destinatario,
         documento_destinatario, nome_destinatario, vlr_cents, transfer_id, xml, xml_sha256,
         created_by, created_at, updated_at)
       VALUES ('msg_1', 'E99999999202611011205000001', '99999999', '00000000', '2026-11-01', '1',
               '00000000000195', 'Titular user_a', '0001', '20000001', '00000000000195',
               'Favorecido', 20_000, 'trf_rsfn', '<DOC/>', 'hash', 'user_a',
               '2026-11-01T12:05:00.000Z', '2026-11-01T12:05:00.000Z')`,
    )
    .run();

  const transit = database
    .prepare("SELECT balance_cents AS value FROM bank_accounts WHERE id = 'bank_acc_rsfn'")
    .get() as { value: number };
  assert.equal(transit.value, 20_000);

  database
    .prepare(
      `INSERT INTO bank_transfers
        (id, kind, channel, debit_account_id, credit_account_id, amount_cents, description, status,
         end_to_end_id, initiator_id, recipient_name, created_at)
       VALUES ('trf_refund', 'INTERNAL', 'RSFN_REFUND', 'bank_acc_rsfn', 'acc_user_a', 20_000,
               'Estorno RSFN', 'POSTED', 'E2E-RSFN-REFUND', 'user_a', 'user_a', '2026-11-01T12:10:00.000Z')`,
    )
    .run();
  database
    .prepare(
      "UPDATE bank_rsfn_messages SET status = 'REJECTED', rejection_code = 'SIM001', rejection_reason = 'teste' WHERE id = 'msg_1'",
    )
    .run();

  const final = database
    .prepare("SELECT balance_cents AS value FROM bank_accounts WHERE id = 'acc_user_a'")
    .get() as { value: number };
  assert.equal(final.value, 50_000, 'estorno devolve exatamente o valor retido');
  const ledger = database
    .prepare("SELECT COUNT(*) AS n FROM bank_ledger WHERE transfer_id IN ('trf_credit', 'trf_rsfn', 'trf_refund')")
    .get() as { n: number };
  assert.equal(ledger.n, 6);
});

test('debitar o saldo integral é permitido pelo trigger corrigido', () => {
  const database = db();
  seedCustomer(database, 'user_a');
  database
    .prepare(
      `INSERT INTO bank_transfers
        (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
         end_to_end_id, initiator_id, recipient_name, created_at)
       VALUES ('trf_in', 'FUNDING', 'bank_acc_capital', 'acc_user_a', 7_500,
               'aporte', 'POSTED', 'E2E-IN', 'user_a', 'user_a', '2026-11-01T12:00:00.000Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO bank_transfers
        (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
         end_to_end_id, initiator_id, recipient_name, created_at)
       VALUES ('trf_out', 'INTERNAL', 'acc_user_a', 'bank_acc_system', 7_500,
               'saque total', 'POSTED', 'E2E-OUT', 'user_a', 'Tesouraria', '2026-11-01T12:05:00.000Z')`,
    )
    .run();
  const account = database
    .prepare("SELECT balance_cents AS value FROM bank_accounts WHERE id = 'acc_user_a'")
    .get() as { value: number };
  assert.equal(account.value, 0);
  const last = database
    .prepare("SELECT balance_after_cents AS value FROM bank_ledger WHERE id = 'trf_out-D'")
    .get() as { value: number };
  assert.equal(last.value, 0);
});
