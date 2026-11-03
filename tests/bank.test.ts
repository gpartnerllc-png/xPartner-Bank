import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import { ensureTreasury, BankService, TREASURY_ACCOUNT_ID } from '../src/modules/bank.ts';
import { BankAuthService } from '../src/modules/bank-auth.ts';
import { TEST_TREASURY_CENTS, testConfig, testDb } from './helpers.ts';
import { buildTestServer } from './test-server.ts';

const PASSWORD = 'SenhaForte#2026';
const PASSWORD_2 = 'OutraSenha#2026';

function fakeRequest(token: string, method = 'GET'): FastifyRequest {
  return { method, headers: { authorization: `Bearer ${token}` } } as unknown as FastifyRequest;
}

test('banco: primeiro usuário vira admin, aprova cliente e transferência interna é real e idempotente', () => {
  const config = testConfig();
  const db = testDb();
  ensureTreasury(db);
  const bank = new BankService(db, config);
  const auth = new BankAuthService(db, config, bank);

  const admin = auth.register({
    name: 'Ana Administradora',
    document: '529.982.247-25',
    email: 'ana.admin@xpartner.test',
    password: PASSWORD,
  });
  assert.equal(admin.bootstrapAdmin, true);
  assert.equal(admin.requiresApproval, false);
  assert.equal(admin.user.role, 'ADMIN');
  assert.equal(admin.user.status, 'ACTIVE');
  assert.ok(admin.account);
  assert.ok(admin.session);

  const client = auth.register({
    name: 'Bruno Cliente',
    document: '111.444.777-35',
    email: 'bruno.cliente@xpartner.test',
    password: PASSWORD_2,
  });
  assert.equal(client.requiresApproval, true);
  assert.equal(client.user.status, 'PENDING');
  assert.equal(client.account, null);

  assert.throws(() => auth.login({ identifier: 'bruno.cliente@xpartner.test', password: PASSWORD_2 }), (error: unknown) => {
    return error instanceof Error && 'code' in error && (error as { code: string }).code === 'ACCOUNT_PENDING';
  });

  const approved = auth.approve(admin.user.id, client.user.id);
  assert.equal(approved.user.status, 'ACTIVE');
  const clientAccount = approved.account;
  assert.match(clientAccount.formattedNumber, /^0001 \/ \d{7}-\d$/);

  const login = auth.login({ identifier: '11144477735', password: PASSWORD_2 });
  assert.equal(login.user.document, '111.444.777-35');
  assert.equal(login.user.role, 'USER');
  const clientAuth = auth.authenticate(fakeRequest(login.session.token));
  assert.equal(clientAuth.user.id, client.user.id);

  bank.funding({ actorUserId: admin.user.id, targetUserId: admin.user.id, amountCents: 500_000 });
  bank.funding({ actorUserId: admin.user.id, targetUserId: client.user.id, amountCents: 300_000 });

  const adminNumber = admin.account?.number;
  assert.ok(adminNumber);
  const first = bank.transfer({
    userId: client.user.id,
    accountId: clientAccount.id,
    amountCents: 125_000,
    description: 'Aluguel de outubro',
    recipient: { accountNumber: adminNumber },
    idempotencyKey: 'idem-transfer-0001',
  });
  assert.equal(first.replayed, false);
  assert.equal(first.account.balanceCents, 175_000);
  assert.equal(first.transfer.amountCents, 125_000);
  assert.match(first.transfer.endToEndId, /^E99999999\d{23}$/);

  const replay = bank.transfer({
    userId: client.user.id,
    accountId: clientAccount.id,
    amountCents: 125_000,
    description: 'Aluguel de outubro',
    recipient: { accountNumber: adminNumber },
    idempotencyKey: 'idem-transfer-0001',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.account.balanceCents, 175_000);

  assert.throws(() => bank.transfer({
    userId: client.user.id,
    accountId: clientAccount.id,
    amountCents: 125_000,
    description: 'Outro valor',
    recipient: { accountNumber: adminNumber },
    idempotencyKey: 'idem-transfer-0001',
  }), (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'CONFLICT');

  assert.throws(() => bank.transfer({
    userId: client.user.id,
    accountId: clientAccount.id,
    amountCents: 900_000,
    recipient: { accountNumber: adminNumber },
  }), (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'INSUFFICIENT_FUNDS');

  assert.throws(() => bank.transfer({
    userId: client.user.id,
    accountId: clientAccount.id,
    amountCents: 1_000,
    recipient: { accountNumber: clientAccount.number },
  }), (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'VALIDATION_ERROR');

  const statement = bank.statement(clientAccount.id, { limit: 20 });
  assert.equal(statement.entries.length, 2);
  assert.equal(statement.balanceCents, 175_000);
  assert.equal(statement.entries[0]?.direction, 'OUT');
  assert.equal(statement.entries[0]?.counterparty.name, admin.user.name);
  assert.equal(statement.entries[1]?.kind, 'FUNDING');

  const trial = bank.systemOverview().ledger;
  assert.equal(trial.balanced, true);
  assert.equal(trial.debitCents, trial.creditCents);

  // 3 contas de titulares + tesouraria e capital de sistema do fixture.
  const contas = db.prepare('SELECT COUNT(*) AS count FROM contas').get() as { count: number };
  const transacoes = db.prepare('SELECT COUNT(*) AS count FROM transacoes').get() as { count: number };
  assert.equal(contas.count, 4);
  assert.equal(transacoes.count, 3);

  const score = bank.creditScore(clientAccount.id);
  assert.ok(score.score >= 0 && score.score <= 1000);
  assert.ok(score.suggestedLimitCents >= 0);

  const receipt = bank.receipt(first.transfer.id, { userId: client.user.id, role: 'USER' });
  assert.equal(receipt.integrity.balanced, true);
  assert.equal(receipt.transfer.direction, 'OUT');
  assert.equal(receipt.ledger.length, 2);

  const treasury = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(TREASURY_ACCOUNT_ID) as { balance_cents: number };
  assert.equal(treasury.balance_cents, TEST_TREASURY_CENTS - 800_000);
  assert.equal(
    bank.statement(admin.account!.id).balanceCents,
    500_000 + 125_000,
  );
});

test('banco: reset de senha pelo admin revoga sessão e exige troca', () => {
  const config = testConfig();
  const db = testDb();
  ensureTreasury(db);
  const bank = new BankService(db, config);
  const auth = new BankAuthService(db, config, bank);

  const admin = auth.register({
    name: 'Carla Admin',
    document: '123.456.789-09',
    email: 'carla.admin@xpartner.test',
    password: PASSWORD,
  });
  const user = auth.register({
    name: 'Diego Usuário',
    document: '390.533.447-05',
    email: 'diego.user@xpartner.test',
    password: PASSWORD_2,
  });
  auth.approve(admin.user.id, user.user.id);
  const login = auth.login({ identifier: 'diego.user@xpartner.test', password: PASSWORD_2 });
  const oldAuth = auth.authenticate(fakeRequest(login.session.token));

  const reset = auth.resetPassword(admin.user.id, user.user.id);
  assert.match(reset.tempPassword, /^Xp[A-Za-z0-9]{12}$/);
  assert.equal(reset.user.mustChangePassword, true);
  assert.throws(() => auth.authenticate(fakeRequest(login.session.token)));

  assert.throws(() => auth.login({ identifier: 'diego.user@xpartner.test', password: PASSWORD_2 }), (error: unknown) => {
    return error instanceof Error && 'code' in error && (error as { code: string }).code === 'UNAUTHORIZED';
  });

  const tempLogin = auth.login({ identifier: 'diego.user@xpartner.test', password: reset.tempPassword });
  assert.equal(tempLogin.user.mustChangePassword, true);
  const tempAuth = auth.authenticate(fakeRequest(tempLogin.session.token));
  assert.throws(() => auth.changePassword(oldAuth, reset.tempPassword, 'NovaSenha#2027'));
  auth.changePassword(tempAuth, reset.tempPassword, 'NovaSenha#2027');
  const newLogin = auth.login({ identifier: 'diego.user@xpartner.test', password: 'NovaSenha#2027' });
  assert.equal(newLogin.user.mustChangePassword, false);

  assert.throws(() => auth.delete(admin.user.id, admin.user.id), (error: unknown) => {
    return error instanceof Error && 'code' in error && (error as { code: string }).code === 'VALIDATION_ERROR';
  });
});

test('banco: exclusão exige saldo zero e bloqueia login depois', () => {
  const config = testConfig();
  const db = testDb();
  ensureTreasury(db);
  const bank = new BankService(db, config);
  const auth = new BankAuthService(db, config, bank);

  const admin = auth.register({
    name: 'Eva Admin',
    document: '862.883.667-57',
    email: 'eva.admin@xpartner.test',
    password: PASSWORD,
  });
  const user = auth.register({
    name: 'Felipe Cliente',
    document: '935.411.347-80',
    email: 'felipe.cliente@xpartner.test',
    password: PASSWORD_2,
  });
  const approved = auth.approve(admin.user.id, user.user.id);
  bank.funding({ actorUserId: admin.user.id, targetUserId: user.user.id, amountCents: 50_000 });

  assert.throws(() => auth.delete(admin.user.id, user.user.id), (error: unknown) => {
    return error instanceof Error && 'code' in error && (error as { code: string }).code === 'BALANCE_NOT_ZERO';
  });

  bank.transfer({
    userId: user.user.id,
    accountId: approved.account.id,
    amountCents: 50_000,
    description: 'Zeragem para encerramento',
    recipient: { accountNumber: admin.account!.number },
  });
  auth.delete(admin.user.id, user.user.id);
  const row = db.prepare('SELECT status FROM bank_users WHERE id = ?').get(user.user.id) as { status: string };
  assert.equal(row.status, 'DELETED');
  const account = db.prepare('SELECT status FROM bank_accounts WHERE user_id = ?').get(user.user.id) as { status: string };
  assert.equal(account.status, 'CLOSED');
  assert.throws(() => auth.login({ identifier: 'felipe.cliente@xpartner.test', password: PASSWORD_2 }));
});

test('api do banco: cadastro, aprovação, cookie com CSRF, transferência e reset', async () => {
  const ctx = await buildTestServer();
  try {
    const status = await ctx.app.inject({ method: 'GET', url: '/v1/bank/status' });
    assert.equal(status.statusCode, 200);
    assert.equal((status.json() as { demoMode: boolean }).demoMode, true);

    const adminRegister = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/register',
      payload: {
        name: 'Gabriela Admin',
        document: '529.982.247-25',
        email: 'gabriela.admin@xpartner.test',
        password: PASSWORD,
      },
    });
    assert.equal(adminRegister.statusCode, 201);
    const adminBody = adminRegister.json() as {
      user: { id: string };
      account: { id: string; number: string };
      token: string;
      bootstrapAdmin: boolean;
    };
    assert.equal(adminBody.bootstrapAdmin, true);
    const adminToken = adminBody.token;
    const adminAccountNumber = adminBody.account.number;
    assert.ok(adminToken);

    const userRegister = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/register',
      payload: {
        name: 'Heitor Cliente',
        document: '111.444.777-35',
        email: 'heitor.cliente@xpartner.test',
        password: PASSWORD_2,
      },
    });
    assert.equal(userRegister.statusCode, 201);
    const userBody = userRegister.json() as { user: { id: string; status: string }; requiresApproval: boolean };
    assert.equal(userBody.requiresApproval, true);
    assert.equal(userBody.user.status, 'PENDING');

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/v1/bank/admin/users/${userBody.user.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(approve.statusCode, 200);
    const approved = approve.json() as { user: { id: string }; account: { id: string; number: string } };

    const userLogin = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/login',
      payload: { identifier: 'heitor.cliente@xpartner.test', password: PASSWORD_2 },
    });
    assert.equal(userLogin.statusCode, 200);
    const loginBody = userLogin.json() as { token: string; csrfToken: string; user: { mustChangePassword: boolean } };
    assert.equal(loginBody.user.mustChangePassword, false);
    assert.ok(userLogin.headers['set-cookie']);

    const cookie = `xp_bank_session=${encodeURIComponent(loginBody.token)}`;
    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/demo/credit',
      headers: { cookie },
      payload: { amountCents: 10_000 },
    });
    assert.equal(noCsrf.statusCode, 403);

    const withCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/demo/credit',
      headers: { cookie, 'x-bank-csrf': loginBody.csrfToken },
      payload: { amountCents: 45_000 },
    });
    assert.equal(withCsrf.statusCode, 201);
    assert.equal((withCsrf.json() as { account: { balanceCents: number } }).account.balanceCents, 45_000);

    const adminCredit = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/demo/credit',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amountCents: 20_000, targetUserId: userBody.user.id },
    });
    assert.equal(adminCredit.statusCode, 201);

    const transfer = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/transfers',
      headers: { authorization: `Bearer ${loginBody.token}`, 'idempotency-key': 'api-idem-0001' },
      payload: {
        amountCents: 25_000,
        description: 'Pagamento de teste',
        recipient: { accountNumber: adminAccountNumber },
      },
    });
    assert.equal(transfer.statusCode, 201);
    const transferBody = transfer.json() as {
      transfer: { id: string; endToEndId: string; direction: string };
      account: { balanceCents: number };
    };
    assert.equal(transferBody.transfer.direction, 'OUT');
    assert.equal(transferBody.account.balanceCents, 65_000 - 25_000);

    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/transfers',
      headers: { authorization: `Bearer ${loginBody.token}`, 'idempotency-key': 'api-idem-0001' },
      payload: {
        amountCents: 25_000,
        description: 'Pagamento de teste',
        recipient: { accountNumber: adminAccountNumber },
      },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['x-idempotent-replayed'], 'true');

    const statement = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/statement',
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    assert.equal(statement.statusCode, 200);
    const statementBody = statement.json() as { entries: Array<{ direction: string }>; balanceCents: number };
    assert.equal(statementBody.balanceCents, 40_000);
    assert.equal(statementBody.entries.length, 3);

    const receipt = await ctx.app.inject({
      method: 'GET',
      url: `/v1/bank/transfers/${transferBody.transfer.id}`,
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    assert.equal(receipt.statusCode, 200);
    assert.equal((receipt.json() as { integrity: { balanced: boolean } }).integrity.balanced, true);

    const overview = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/admin/overview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(overview.statusCode, 200);
    const overviewBody = overview.json() as {
      system: { ledger: { balanced: boolean }; activeUsers: number };
      pending: unknown[];
    };
    assert.equal(overviewBody.system.ledger.balanced, true);
    assert.equal(overviewBody.system.activeUsers, 2);

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/v1/bank/admin/users/${userBody.user.id}/reset-password`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(reset.statusCode, 200);
    const resetBody = reset.json() as { tempPassword: string; user: { mustChangePassword: boolean } };
    assert.equal(resetBody.user.mustChangePassword, true);

    const revoked = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/me',
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    assert.equal(revoked.statusCode, 401);

    const adminNoAuth = await ctx.app.inject({ method: 'GET', url: '/v1/bank/admin/overview' });
    assert.equal(adminNoAuth.statusCode, 401);
  } finally {
    await ctx.app.close();
  }
});
