import assert from 'node:assert/strict';
import test from 'node:test';
import { accountView, BankService, ensureTreasury } from '../src/modules/bank.ts';
import type { BankAccountRow } from '../src/modules/bank.ts';
import { BankAuthService } from '../src/modules/bank-auth.ts';
import { BankCreditService } from '../src/modules/bank-credit.ts';
import { BankPdvService } from '../src/modules/bank-pdv.ts';
import { FiscalWorker } from '../src/modules/fiscal-worker.ts';
import { TransactionService } from '../src/modules/transactions.ts';
import { testConfig, testDb } from './helpers.ts';
import { buildTestServer } from './test-server.ts';

const PASSWORD = 'SenhaForte#2026';
const ADMIN_CPF = '52998224725';
const CLIENT_CPF = '34259998854';

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? (error as { code: string }).code : undefined;
}

/** Cria dois titulares e eleva o score do cliente com aportes e movimentação. */
function fixture() {
  const config = testConfig();
  const db = testDb();
  ensureTreasury(db);
  const bank = new BankService(db, config);
  const auth = new BankAuthService(db, config, bank);
  const credit = new BankCreditService(db, bank);
  const transactions = new TransactionService(db, config);
  const fiscal = new FiscalWorker(db, config);
  const pdv = new BankPdvService(db, config, bank, transactions, fiscal);

  const admin = auth.register({
    name: 'Ana Administradora',
    document: ADMIN_CPF,
    email: 'ana.credito@xpartner.test',
    password: PASSWORD,
  });
  const clientRegister = auth.register({
    name: 'Cristian Ribeiro Florencio',
    document: CLIENT_CPF,
    email: 'cristian.credito@xpartner.test',
    password: PASSWORD,
  });
  const approved = auth.approve(admin.user.id, clientRegister.user.id);
  const adminAccount = admin.account;
  assert.ok(adminAccount, 'administrador bootstrap precisa de conta');

  for (let index = 0; index < 5; index += 1) {
    bank.funding({
      actorUserId: admin.user.id,
      targetUserId: approved.user.id,
      amountCents: 1_000_000,
    });
  }
  for (let index = 0; index < 4; index += 1) {
    bank.transfer({
      userId: approved.user.id,
      accountId: approved.account.id,
      amountCents: 100_000,
      description: 'Movimentação para score',
      recipient: { accountNumber: adminAccount.number },
    });
  }

  const fresh = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(approved.account.id) as unknown as BankAccountRow;
  const client = { ...approved, account: accountView(fresh) };

  return { config, db, bank, auth, credit, pdv, admin, client };
}

test('crédito: linha, simulação Price e antecipação com deságio', () => {
  const { credit, client } = fixture();

  const line = credit.line(client.user.id);
  assert.ok(line.score >= 300, `score ${line.score}`);
  assert.ok(line.availableLimitCents >= 1_000_000, `limite ${line.availableLimitCents}`);
  assert.equal(line.minCents, 10_000);

  const loan = credit.quote(client.user.id, { product: 'EMPRESTIMO', amountCents: 1_000_000, installments: 6 });
  assert.equal(loan.installments, 6);
  assert.equal(loan.principalCents, 1_000_000);
  assert.equal(loan.schedule.length, 6);
  assert.equal(
    loan.schedule.reduce((sum, row) => sum + row.principalCents, 0),
    1_000_000,
    'amortização deve quitar exatamente o principal',
  );
  assert.ok(loan.totalDueCents > loan.principalCents);
  assert.equal(
    loan.totalDueCents,
    loan.schedule.reduce((sum, row) => sum + row.totalCents, 0),
  );
  assert.ok(loan.monthlyRatePercent > 0);
  const dueDates = loan.schedule.map((row) => row.dueDate);
  assert.deepEqual(dueDates, [...dueDates].sort(), 'vencimentos em ordem crescente');

  const advance = credit.quote(client.user.id, { product: 'ANTECIPACAO', amountCents: 500_000 });
  assert.equal(advance.schedule.length, 1);
  assert.ok(advance.principalCents < advance.amountCents, 'deságio reduz o valor liberado');
  assert.equal(advance.principalCents + advance.interestCents, advance.amountCents);
  assert.equal(advance.schedule[0]?.totalCents, 500_000);

  assert.throws(
    () => credit.quote(client.user.id, { product: 'EMPRESTIMO', amountCents: 5_000_000, installments: 12 }),
    (error: unknown) => codeOf(error) === 'CREDIT_LIMIT',
  );
  assert.throws(
    () => credit.quote(client.user.id, { product: 'EMPRESTIMO', amountCents: 5_000 }),
    (error: unknown) => codeOf(error) === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => credit.quote(client.user.id, { product: 'EMPRESTIMO', amountCents: 1_000_000, installments: 24 }),
    (error: unknown) => codeOf(error) === 'VALIDATION_ERROR',
  );
});

test('crédito: contratação idempotente, desembolso da tesouraria e extrato', () => {
  const { bank, credit, client } = fixture();
  const before = client.account.balanceCents;

  const first = credit.create(client.user.id, {
    product: 'EMPRESTIMO',
    amountCents: 1_000_000,
    installments: 6,
    idempotencyKey: 'contrato-idem-0001',
  });
  assert.equal(first.replayed, false);
  assert.equal(first.contract.status, 'OPEN');
  assert.equal(first.contract.openInstallments, 6);
  assert.equal(first.account.balanceCents, before + 1_000_000);
  assert.equal(first.transfer.channel, 'CREDIT');
  assert.match(first.contract.contractNumber, /^CRT-\d{4}-\d{5}$/);

  const replay = credit.create(client.user.id, {
    product: 'EMPRESTIMO',
    amountCents: 1_000_000,
    installments: 6,
    idempotencyKey: 'contrato-idem-0001',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.contract.id, first.contract.id);
  assert.equal(replay.account.balanceCents, before + 1_000_000);

  assert.throws(
    () =>
      credit.create(client.user.id, {
        product: 'EMPRESTIMO',
        amountCents: 900_000,
        installments: 6,
        idempotencyKey: 'contrato-idem-0001',
      }),
    (error: unknown) => codeOf(error) === 'CONFLICT',
  );

  const clientStatement = bank.statement(client.account.id);
  assert.equal(clientStatement.entries[0]?.kindLabel, 'Crédito liberado');
  assert.equal(clientStatement.entries[0]?.channel, 'CREDIT');

  const list = credit.list(client.user.id);
  assert.equal(list.contracts.length, 1);
  assert.equal(list.summary.outstandingCents, first.contract.totalDueCents);
  assert.ok(list.summary.nextDueDate);

  const csv = credit.exportCsv(client.user.id);
  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv, /"contrato";"produto";"status"/);
  assert.ok(csv.includes(first.contract.contractNumber));
});

test('crédito: parcela, liquidação antecipada com desconto e contrato encerrado', () => {
  const { bank, credit, client } = fixture();
  const created = credit.create(client.user.id, {
    product: 'EMPRESTIMO',
    amountCents: 1_200_000,
    installments: 4,
  });
  const balanceAfterCredit = created.account.balanceCents;
  const firstInstallment = created.contract.schedule[0];
  assert.ok(firstInstallment);

  const paid = credit.payInstallment(client.user.id, created.contract.id, 1);
  assert.equal(paid.installment.status, 'PAID');
  assert.equal(paid.account.balanceCents, balanceAfterCredit - (firstInstallment?.totalCents ?? 0));
  assert.equal(paid.contract.paidInstallments, 1);
  assert.equal(paid.contract.status, 'OPEN');
  assert.equal(paid.transfer.channel, 'CREDIT_PAYMENT');

  const statement = bank.statement(client.account.id);
  assert.equal(statement.entries[0]?.kindLabel, 'Parcela de crédito');
  assert.equal(statement.entries[0]?.channel, 'CREDIT_PAYMENT');

  assert.throws(
    () => credit.payInstallment(client.user.id, created.contract.id, 1),
    (error: unknown) => codeOf(error) === 'CONFLICT',
  );

  const settled = credit.settleEarly(client.user.id, created.contract.id);
  assert.equal(settled.contract.status, 'PAID');
  assert.equal(settled.contract.settledEarly, true);
  assert.equal(settled.contract.outstandingCents, 0);
  assert.equal(settled.contract.openInstallments, 0);
  assert.ok(settled.discountCents > 0, 'juros futuros são descontados');
  assert.equal(settled.transfer.channel, 'CREDIT_PAYMENT');
  assert.equal(settled.account.balanceCents, balanceAfterCredit - (firstInstallment?.totalCents ?? 0) - settled.amountCents);

  assert.throws(
    () => credit.settleEarly(client.user.id, created.contract.id),
    (error: unknown) => codeOf(error) === 'CONFLICT',
  );

  const line = credit.line(client.user.id);
  assert.equal(line.outstandingPrincipalCents, 0);
});

test('pdv: venda com NFC-e síncrona, liquidação do líquido e exportações', async () => {
  const { pdv, bank, client } = fixture();
  const before = client.account.balanceCents;

  const result = await pdv.sell({
    userId: client.user.id,
    amountCents: 12_345,
    method: 'PIX',
    description: 'Café especial 250g',
    items: [{ name: 'Café especial 250g', ncm: '09012100', quantity: 1, unitPriceCents: 12_345 }],
  });

  assert.equal(result.sale.method, 'PIX');
  assert.equal(result.sale.amountCents, 12_345);
  assert.ok(result.sale.feeCents >= 0);
  assert.equal(result.sale.netCents, 12_345 - result.sale.feeCents);
  assert.ok(result.fiscal, 'NFC-e emitida na mesma resposta');
  assert.equal(result.fiscal?.status, 'AUTHORIZED');
  assert.match(result.fiscal?.accessKey ?? '', /^\d{44}$/);
  assert.ok(result.fiscal?.qrCodeUrl?.startsWith('https://'));
  assert.equal(result.sale.settlement.transferId, result.transfer?.id);
  assert.equal(result.account.balanceCents, before + result.sale.netCents);
  assert.match(result.transfer?.description ?? '', /^Liquidação venda /);

  const statement = bank.statement(client.account.id);
  assert.equal(statement.entries[0]?.kindLabel, 'Liquidação de venda NFC-e');
  assert.equal(statement.entries[0]?.channel, 'PDV');

  const list = pdv.list(client.user.id);
  assert.equal(list.sales.length, 1);
  assert.equal(list.summary.fiscalized, 1);
  assert.equal(list.summary.grossCents, 12_345);

  const doc = pdv.document(client.user.id, result.sale.id);
  assert.ok(doc.xml.includes(result.fiscal?.accessKey ?? ''));
  assert.ok(doc.danfeText.length > 0);
  assert.ok(doc.escpos.length > 0);

  const csv = pdv.salesCsv(client.user.id);
  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv, /"data";"nsu";"meio"/);
  assert.ok(csv.includes(result.fiscal?.accessKey ?? ''));

  const card = await pdv.sell({ userId: client.user.id, amountCents: 5_000, method: 'credit', installments: 2 });
  assert.equal(card.sale.method, 'CREDIT');
  assert.equal(card.sale.installments, 2);
  assert.ok(card.sale.netCents > 0);

  await assert.rejects(
    () =>
      pdv.sell({
        userId: client.user.id,
        amountCents: 10_000,
        method: 'PIX',
        items: [{ name: 'Item errado', quantity: 1, unitPriceCents: 9_000 }],
      }),
    (error: unknown) => codeOf(error) === 'VALIDATION_ERROR',
  );
});

test('crédito e PDV via API: rotas autenticadas, idempotência e download da NFC-e', async () => {
  const ctx = await buildTestServer();
  try {
    const adminRegister = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/register',
      payload: {
        name: 'Ana Administradora',
        document: ADMIN_CPF,
        email: 'ana.credito.api@xpartner.test',
        password: PASSWORD,
      },
    });
    assert.equal(adminRegister.statusCode, 201, adminRegister.body);
    const admin = adminRegister.json() as { token: string; user: { id: string }; account: { id: string; number: string } | null };
    assert.ok(admin.account, 'administrador bootstrap precisa de conta');

    const clientRegister = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/register',
      payload: {
        name: 'Cristian Ribeiro Florencio',
        document: CLIENT_CPF,
        email: 'cristian.credito.api@xpartner.test',
        password: PASSWORD,
      },
    });
    assert.equal(clientRegister.statusCode, 201, clientRegister.body);
    const client = clientRegister.json() as { user: { id: string } };

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/v1/bank/admin/users/${client.user.id}/approve`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    assert.equal(approve.statusCode, 200, approve.body);
    const clientAccount = (approve.json() as { account: { id: string; number: string } }).account;

    for (let index = 0; index < 5; index += 1) {
      ctx.bank.funding({ actorUserId: admin.user.id, targetUserId: client.user.id, amountCents: 1_000_000 });
    }
    for (let index = 0; index < 4; index += 1) {
      ctx.bank.transfer({
        userId: client.user.id,
        accountId: clientAccount.id,
        amountCents: 100_000,
        description: 'Movimentação para score',
        recipient: { accountNumber: admin.account.number },
      });
    }

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/login',
      payload: { identifier: CLIENT_CPF, password: PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);
    const session = login.json() as { token: string; account: { id: string; balanceCents: number } };

    const line = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/credit/line',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(line.statusCode, 200, line.body);
    assert.ok((line.json() as { line: { availableLimitCents: number } }).line.availableLimitCents >= 300_000);

    const quote = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/credit/quote',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { product: 'EMPRESTIMO', amountCents: 300_000, installments: 3 },
    });
    assert.equal(quote.statusCode, 200, quote.body);
    assert.equal((quote.json() as { quote: { schedule: unknown[] } }).quote.schedule.length, 3);

    const contract = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/credit/contracts',
      headers: { authorization: `Bearer ${session.token}`, 'idempotency-key': 'api-idem-000001' },
      payload: { product: 'EMPRESTIMO', amountCents: 300_000, installments: 3 },
    });
    assert.equal(contract.statusCode, 201, contract.body);
    const created = contract.json() as {
      contract: { id: string; status: string; totalDueCents: number };
      transfer: { channel: string };
    };
    assert.equal(created.contract.status, 'OPEN');
    assert.equal(created.transfer.channel, 'CREDIT');

    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/credit/contracts',
      headers: { authorization: `Bearer ${session.token}`, 'idempotency-key': 'api-idem-000001' },
      payload: { product: 'EMPRESTIMO', amountCents: 300_000, installments: 3 },
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.headers['x-idempotent-replayed'], 'true');

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/credit/contracts',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(list.statusCode, 200);
    assert.equal((list.json() as { contracts: unknown[] }).contracts.length, 1);

    const csv = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/credit/contracts.csv',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-disposition']), /credito-xpartner\.csv/);
    assert.ok(csv.body.startsWith('\ufeff'));

    const pay = await ctx.app.inject({
      method: 'POST',
      url: `/v1/bank/credit/contracts/${created.contract.id}/installments/1/pay`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(pay.statusCode, 201, pay.body);

    const settle = await ctx.app.inject({
      method: 'POST',
      url: `/v1/bank/credit/contracts/${created.contract.id}/settle`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(settle.statusCode, 200, settle.body);
    assert.equal((settle.json() as { contract: { status: string } }).contract.status, 'PAID');

    const balanceBefore = (await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/account',
      headers: { authorization: `Bearer ${session.token}` },
    })).json() as { account: { balanceCents: number } };

    const sale = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/pdv/sales',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { amountCents: 8_900, method: 'PIX', description: 'Fardo de bebidas' },
    });
    assert.equal(sale.statusCode, 201, sale.body);
    const sold = sale.json() as {
      sale: { id: string; netCents: number; fiscal: { accessKey: string; status: string } | null };
      account: { balanceCents: number };
    };
    assert.equal(sold.account.balanceCents, balanceBefore.account.balanceCents + sold.sale.netCents);
    assert.equal(sold.sale.fiscal?.status, 'AUTHORIZED');
    assert.match(sold.sale.fiscal?.accessKey ?? '', /^\d{44}$/);

    const fiscal = await ctx.app.inject({
      method: 'GET',
      url: `/v1/bank/pdv/sales/${sold.sale.id}/fiscal`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(fiscal.statusCode, 200, fiscal.body);
    assert.ok((fiscal.json() as { xml: string }).xml.includes(sold.sale.fiscal?.accessKey ?? ''));

    const xml = await ctx.app.inject({
      method: 'GET',
      url: `/v1/bank/pdv/sales/${sold.sale.id}/xml`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(xml.statusCode, 200);
    assert.match(String(xml.headers['content-type']), /application\/xml/);
    assert.match(String(xml.headers['content-disposition']), /nfce-.*\.xml/);

    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/v1/bank/pdv/sales/${sold.sale.id}/fiscal`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    assert.equal(forbidden.statusCode, 404, 'venda só é visível ao titular');

    const salesCsv = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/pdv/sales.csv',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(salesCsv.statusCode, 200);
    assert.ok(salesCsv.body.includes(sold.sale.fiscal?.accessKey ?? ''));
  } finally {
    await ctx.app.close();
  }
});
