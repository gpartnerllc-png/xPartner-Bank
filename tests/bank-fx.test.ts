import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BankService,
  DEMO_CAPITAL_ACCOUNT_ID,
  DEMO_CAPITAL_OPENING_CENTS,
  ensureCapital,
  ensureTreasury,
  ledgerTrialBalance,
} from '../src/modules/bank.ts';
import { BankAuthService } from '../src/modules/bank-auth.ts';
import {
  BankFxService,
  FX_TREASURY_OPENING_CENTS,
  FX_TREASURY_WALLET_ID,
  ensureFxTreasury,
  formatFx,
} from '../src/modules/bank-fx.ts';
import { testConfig, testDb } from './helpers.ts';
import { buildTestServer } from './test-server.ts';

const PASSWORD = 'SenhaForte#2026';
const ADMIN_CPF = '52998224725';
const CLIENT_CPF = '34259998854';
const BRL_CAPITAL = 200_000_000_000; // R$ 2.000.000.000,00
const USD_CAPITAL = 300_000_000_000; // US$ 3.000.000.000,00

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? (error as { code: string }).code : undefined;
}

function fixture() {
  const config = testConfig();
  const db = testDb();
  ensureTreasury(db);
  ensureCapital(db);
  ensureFxTreasury(db);
  const bank = new BankService(db, config);
  const auth = new BankAuthService(db, config, bank);
  const fx = new BankFxService(db, config);

  const admin = auth.register({
    name: 'Ana Capital',
    document: ADMIN_CPF,
    email: 'ana.capital@xpartner.test',
    password: PASSWORD,
  });
  const registered = auth.register({
    name: 'Cristian Ribeiro Florencio',
    document: CLIENT_CPF,
    email: 'cristian.capital@xpartner.test',
    password: PASSWORD,
  });
  const client = auth.approve(admin.user.id, registered.user.id);
  assert.ok(client.account, 'cliente aprovado precisa de conta');
  return { config, db, bank, auth, fx, admin, client };
}

test('capital demo: credita com lastro, extrato próprio e idempotência', () => {
  const { db, bank, admin, client } = fixture();

  const result = bank.demoCapital({
    actorUserId: admin.user.id,
    targetUserId: client.user.id,
    amountCents: BRL_CAPITAL,
    idempotencyKey: 'api-capital-brl-2b',
  });
  assert.equal(result.account.balanceCents, BRL_CAPITAL);
  assert.equal(result.transfer.direction, 'IN');
  assert.equal(result.transfer.counterparty.name, 'Capital de laboratório (demo)');

  const capital = db
    .prepare('SELECT balance_cents FROM bank_accounts WHERE id = ?')
    .get(DEMO_CAPITAL_ACCOUNT_ID) as { balance_cents: number };
  assert.equal(capital.balance_cents, DEMO_CAPITAL_OPENING_CENTS - BRL_CAPITAL);
  assert.equal(ledgerTrialBalance(db).balanced, true);

  const statement = bank.statement(client.account.id);
  assert.equal(statement.balanceCents, BRL_CAPITAL);
  assert.equal(statement.entries[0]?.kindLabel, 'Aporte de capital demo');
  assert.equal(statement.entries[0]?.channel, 'CAPITAL');
  assert.equal(statement.entries[0]?.balanceAfterCents, BRL_CAPITAL);

  const replay = bank.demoCapital({
    actorUserId: admin.user.id,
    targetUserId: client.user.id,
    amountCents: BRL_CAPITAL,
    idempotencyKey: 'api-capital-brl-2b',
  });
  assert.equal(replay.replayed, true);
  assert.equal(bank.statement(client.account.id).balanceCents, BRL_CAPITAL);

  assert.throws(
    () =>
      bank.demoCapital({
        actorUserId: admin.user.id,
        targetUserId: client.user.id,
        amountCents: 1,
        idempotencyKey: 'api-capital-brl-2b',
      }),
    (error: unknown) => codeOf(error) === 'CONFLICT',
  );
});

test('capital demo: recusa fora do modo demo e acima do teto', () => {
  const { config, db, admin, client } = fixture();
  const real = new BankService(db, testConfig({ DEMO_MODE: 'false' }));
  assert.throws(
    () => real.demoCapital({ actorUserId: admin.user.id, targetUserId: client.user.id, amountCents: 1_000 }),
    (error: unknown) => codeOf(error) === 'DEMO_ONLY',
  );
  const bank = new BankService(db, config);
  assert.throws(
    () =>
      bank.demoCapital({
        actorUserId: admin.user.id,
        targetUserId: client.user.id,
        amountCents: 50_000_000_000_001,
      }),
    (error: unknown) => codeOf(error) === 'VALIDATION_ERROR',
  );
});

test('carteira USD: lastro na tesouraria, extrato e idempotência', () => {
  const { db, fx, admin, client } = fixture();

  const result = fx.fund({
    actorUserId: admin.user.id,
    targetUserId: client.user.id,
    currency: 'USD',
    amountCents: USD_CAPITAL,
    memo: 'Capital internacional de laboratório',
    idempotencyKey: 'api-fx-usd-3b',
  });
  assert.equal(result.wallet.currency, 'USD');
  assert.equal(result.wallet.balanceCents, USD_CAPITAL);
  assert.equal(result.wallet.balanceFormatted, formatFx(USD_CAPITAL, 'USD'));
  assert.match(result.wallet.balanceFormatted, /3\.000\.000\.000,00/);

  const treasury = db
    .prepare('SELECT balance_cents FROM bank_fx_wallets WHERE id = ?')
    .get(FX_TREASURY_WALLET_ID) as { balance_cents: number };
  assert.equal(treasury.balance_cents, FX_TREASURY_OPENING_CENTS - USD_CAPITAL);

  const entries = db
    .prepare(
      `SELECT direction, amount_cents FROM bank_fx_entries
        WHERE transfer_id = ? ORDER BY direction`,
    )
    .all(result.transfer.id) as Array<{ direction: string; amount_cents: number }>;
  assert.equal(entries.length, 2);
  assert.equal(
    entries.reduce((total, entry) => total + (entry.direction === 'DEBIT' ? entry.amount_cents : -entry.amount_cents), 0),
    0,
  );

  const wallet = fx.wallets(client.user.id).wallets.find((item) => item.currency === 'USD');
  assert.ok(wallet);
  assert.equal(wallet.balanceCents, USD_CAPITAL);

  const statement = fx.statement(client.user.id, 'USD');
  assert.equal(statement.entries.length, 1);
  assert.equal(statement.entries[0]?.direction, 'IN');
  assert.equal(statement.entries[0]?.balanceAfterCents, USD_CAPITAL);
  assert.equal(statement.entries[0]?.counterpartyName, 'Tesouraria xPartner');

  const replay = fx.fund({
    actorUserId: admin.user.id,
    targetUserId: client.user.id,
    currency: 'USD',
    amountCents: USD_CAPITAL,
    memo: 'Capital internacional de laboratório',
    idempotencyKey: 'api-fx-usd-3b',
  });
  assert.equal(replay.replayed, true);
  assert.equal(fx.statement(client.user.id, 'USD').entries.length, 1);
});

test('carteira USD: recusa fora do demo, titular inexistente e moeda não suportada', () => {
  const { db, fx, admin } = fixture();
  const real = new BankFxService(db, testConfig({ DEMO_MODE: 'false' }));
  assert.throws(
    () => real.fund({ actorUserId: admin.user.id, targetUserId: admin.user.id, amountCents: 100 }),
    (error: unknown) => codeOf(error) === 'DEMO_ONLY',
  );
  assert.throws(
    () => fx.fund({ actorUserId: admin.user.id, targetUserId: 'bank_user_missing', amountCents: 100 }),
    (error: unknown) => codeOf(error) === 'NOT_FOUND',
  );
  assert.throws(
    () => fx.fund({ actorUserId: admin.user.id, targetUserId: admin.user.id, currency: 'EUR', amountCents: 100 }),
    (error: unknown) => codeOf(error) === 'VALIDATION_ERROR',
  );
});

test('api: capital e carteira USD exigem admin e aparecem para o titular', async () => {
  const ctx = await buildTestServer();
  try {
    const adminRegister = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/register',
      payload: {
        name: 'Ana API Capital',
        document: '529.982.247-25',
        email: 'ana.api.capital@xpartner.test',
        password: PASSWORD,
      },
    });
    assert.equal(adminRegister.statusCode, 201);
    const adminBody = adminRegister.json() as { user: { id: string }; token: string };
    const adminBearer = { authorization: `Bearer ${adminBody.token}` };

    const userRegister = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/register',
      payload: {
        name: 'Cristian API Capital',
        document: '342.599.988-54',
        email: 'cristian.api.capital@xpartner.test',
        password: PASSWORD,
      },
    });
    assert.equal(userRegister.statusCode, 201);
    const userBody = userRegister.json() as { user: { id: string } };
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/bank/admin/users/${userBody.user.id}/approve`,
      headers: adminBearer,
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/login',
      payload: { identifier: 'cristian.api.capital@xpartner.test', password: PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const userBearer = { authorization: `Bearer ${(login.json() as { token: string }).token}` };

    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/demo/capital',
      payload: { targetUserId: userBody.user.id, amountCents: BRL_CAPITAL },
    });
    assert.equal(anonymous.statusCode, 401);

    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/demo/capital',
      headers: userBearer,
      payload: { targetUserId: userBody.user.id, amountCents: BRL_CAPITAL },
    });
    assert.equal(forbidden.statusCode, 403);

    const capital = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/demo/capital',
      headers: { ...adminBearer, 'idempotency-key': 'route-capital-brl-2b' },
      payload: { targetUserId: userBody.user.id, amountCents: BRL_CAPITAL },
    });
    assert.equal(capital.statusCode, 201);
    assert.equal((capital.json() as { account: { balanceCents: number } }).account.balanceCents, BRL_CAPITAL);

    const fx = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/demo/fx',
      headers: { ...adminBearer, 'idempotency-key': 'route-fx-usd-3b' },
      payload: { targetUserId: userBody.user.id, currency: 'USD', amountCents: USD_CAPITAL },
    });
    assert.equal(fx.statusCode, 201);

    const wallets = await ctx.app.inject({ method: 'GET', url: '/v1/bank/fx/wallets', headers: userBearer });
    assert.equal(wallets.statusCode, 200);
    const usd = (wallets.json() as { wallets: Array<{ currency: string; balanceCents: number }> }).wallets.find(
      (wallet) => wallet.currency === 'USD',
    );
    assert.equal(usd?.balanceCents, USD_CAPITAL);

    const overview = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/admin/overview',
      headers: adminBearer,
    });
    assert.equal(overview.statusCode, 200);
    const fxSystem = (overview.json() as { system: { fx: { custodyCents: number; wallets: number } } }).system.fx;
    assert.equal(fxSystem.custodyCents, USD_CAPITAL);
    assert.equal(fxSystem.wallets, 1);

    const statement = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/fx/wallets/USD/statement',
      headers: userBearer,
    });
    assert.equal(statement.statusCode, 200);
    const body = statement.json() as { entries: Array<{ direction: string }> };
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0]?.direction, 'IN');
  } finally {
    await ctx.app.close();
  }
});
