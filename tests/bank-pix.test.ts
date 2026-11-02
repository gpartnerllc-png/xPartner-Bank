import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePixPayload } from '../src/domain/pix.ts';
import { BankService, ensureTreasury, validateAccountNumber } from '../src/modules/bank.ts';
import { BankAuthService } from '../src/modules/bank-auth.ts';
import { BankPixService } from '../src/modules/bank-pix.ts';
import { testConfig, testDb } from './helpers.ts';
import { buildTestServer } from './test-server.ts';

const PASSWORD = 'SenhaForte#2026';
const ADMIN_CPF = '52998224725';
const CRISTIAN_CPF = '34259998854';

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? (error as { code: string }).code : undefined;
}

function serviceFixture() {
  const config = testConfig();
  const db = testDb();
  ensureTreasury(db);
  const bank = new BankService(db, config);
  const auth = new BankAuthService(db, config, bank);
  const pix = new BankPixService(db);

  const admin = auth.register({
    name: 'Ana Administradora',
    document: ADMIN_CPF,
    email: 'ana.admin@xpartner.test',
    password: PASSWORD,
  });
  const cristian = auth.register({
    name: 'Cristian Ribeiro Florencio',
    document: CRISTIAN_CPF,
    email: 'cristian.ribeiro@xpartner.test',
    password: PASSWORD,
  });
  const approved = auth.approve(admin.user.id, cristian.user.id);
  return { db, bank, auth, pix, admin, cristian, approved };
}

test('conta: dígito verificador FEBRABAN módulo 11 aceita 0 e a convenção legada X', () => {
  assert.deepEqual(validateAccountNumber('1000001', '1'), {
    base: '1000001',
    expectedDigit: '1',
    providedDigit: '1',
    valid: true,
    legacyX: false,
  });
  assert.equal(validateAccountNumber('54321', '7').valid, true);

  const legacy = validateAccountNumber('123456', 'X');
  assert.equal(legacy.expectedDigit, '0');
  assert.equal(legacy.valid, true);
  assert.equal(legacy.legacyX, true);
  assert.equal(validateAccountNumber('123456', '0').valid, true);
  assert.equal(validateAccountNumber('123456', '9').valid, false);

  assert.throws(() => validateAccountNumber('12', '1'), (error: unknown) => codeOf(error) === 'VALIDATION_ERROR');
  assert.throws(() => validateAccountNumber('123456', 'A'), (error: unknown) => codeOf(error) === 'VALIDATION_ERROR');
});

test('pix: chaves são validadas, mascaradas, únicas e limitadas por titular', () => {
  const { pix, admin, approved } = serviceFixture();
  const cristianId = approved.user.id;

  const cpfKey = pix.create(cristianId, { type: 'CPF', value: '342.599.988-54', label: 'Principal' });
  assert.equal(cpfKey.type, 'CPF');
  assert.equal(cpfKey.key, CRISTIAN_CPF);
  assert.equal(cpfKey.masked, '342.***.***-54');
  assert.equal(cpfKey.label, 'Principal');

  assert.throws(
    () => pix.create(cristianId, { type: 'CPF', value: CRISTIAN_CPF }),
    (error: unknown) => codeOf(error) === 'PIX_KEY_EXISTS',
  );
  assert.throws(
    () => pix.create(cristianId, { type: 'CPF', value: ADMIN_CPF }),
    (error: unknown) => codeOf(error) === 'PIX_KEY_OWNERSHIP',
  );
  assert.throws(
    () => pix.create(cristianId, { type: 'CPF', value: '111.111.111-11' }),
    (error: unknown) => codeOf(error) === 'INVALID_PIX_KEY',
  );

  const emailKey = pix.create(cristianId, { value: '  Cristian.Finance@Example.com ' });
  assert.equal(emailKey.type, 'EMAIL');
  assert.equal(emailKey.key, 'cristian.finance@example.com');
  assert.match(emailKey.masked, /^cr\*+@example\.com$/);

  const phoneKey = pix.create(cristianId, { type: 'PHONE', value: '(11) 99876-5432' });
  assert.equal(phoneKey.key, '+5511998765432');
  assert.equal(phoneKey.masked, '+55 ** *****-5432');

  const evp = pix.createEvp(cristianId, 'Cobrança');
  assert.equal(evp.type, 'EVP');
  assert.match(evp.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  pix.create(cristianId, { type: 'EMAIL', value: 'cristian.secundario@example.com' });
  assert.throws(
    () => pix.create(cristianId, { type: 'EMAIL', value: 'cristian.terceiro@example.com' }),
    (error: unknown) => codeOf(error) === 'PIX_KEY_LIMIT',
  );

  const listed = pix.list(cristianId);
  assert.equal(listed.keys.length, 5);
  assert.equal(listed.limit, 5);
  assert.equal(listed.holder.documentMasked, '342.***.***-54');

  const contact = pix.lookup(admin.user.id, '342.599.988-54');
  assert.equal(contact.name, 'Cristian Ribeiro Florencio');
  assert.equal(contact.keyMasked, '342.***.***-54');
  assert.match(contact.account, /^0001 \/ \d{8}$/);

  assert.equal(pix.lookup(admin.user.id, '+55 (11) 99876-5432').keyType, 'PHONE');
  assert.equal(pix.lookup(admin.user.id, 'CRISTIAN.FINANCE@example.com').keyType, 'EMAIL');
  assert.equal(pix.lookup(admin.user.id, evp.key).keyType, 'EVP');

  assert.throws(() => pix.lookup(cristianId, CRISTIAN_CPF), (error: unknown) => codeOf(error) === 'VALIDATION_ERROR');
  assert.throws(
    () => pix.lookup(admin.user.id, 'nao-existe@xpartner.test'),
    (error: unknown) => codeOf(error) === 'NOT_FOUND',
  );

  const removed = pix.remove(cristianId, phoneKey.id);
  assert.equal(removed.status, 'DELETED');
  assert.throws(
    () => pix.lookup(admin.user.id, '+5511998765432'),
    (error: unknown) => codeOf(error) === 'NOT_FOUND',
  );
  const recreated = pix.create(cristianId, { type: 'PHONE', value: '11998765432' });
  assert.equal(recreated.key, '+5511998765432');
  assert.throws(
    () => pix.remove(admin.user.id, cpfKey.id),
    (error: unknown) => codeOf(error) === 'FORBIDDEN',
  );

  const adminList = pix.adminList({ type: 'CPF' });
  assert.equal(adminList.length, 1);
  assert.equal(adminList[0]?.holderName, 'Cristian Ribeiro Florencio');
  assert.equal(adminList[0]?.holderDocumentMasked, '342.***.***-54');
});

test('pix: BR Code estático e com valor têm CRC16 válido e campos EMV esperados', () => {
  const { pix, approved } = serviceFixture();
  const key = pix.create(approved.user.id, { type: 'CPF', value: CRISTIAN_CPF });

  const staticCode = pix.brCode(approved.user.id, key.id);
  assert.equal(validatePixPayload(staticCode.payload), true);
  assert.equal(staticCode.amountCents, null);
  assert.equal(staticCode.payload.slice(-4), staticCode.crc);
  assert.match(staticCode.payload, /^000201/);
  assert.ok(staticCode.payload.includes('br.gov.bcb.pix'));
  assert.ok(staticCode.payload.includes(CRISTIAN_CPF));
  assert.ok(staticCode.payload.includes('5303986'));
  assert.ok(staticCode.payload.includes('5802BR'));
  assert.ok(!staticCode.payload.includes('540612.90'));

  const charged = pix.brCode(approved.user.id, key.id, 129_90);
  assert.equal(validatePixPayload(charged.payload), true);
  assert.equal(charged.amountCents, 12_990);
  assert.ok(charged.payload.includes('5406129.90'));
  assert.notEqual(charged.payload, staticCode.payload);
  assert.notEqual(charged.txid, staticCode.txid);

  assert.throws(() => pix.brCode(approved.user.id, key.id, 0), (error: unknown) => codeOf(error) === 'INVALID_AMOUNT');
});

test('pix api: chave, consulta, pagamento por chave Pix e extrato com canal PIX', async () => {
  const ctx = await buildTestServer();
  try {
    const adminRegister = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/register',
      payload: {
        name: 'Ana Administradora',
        document: ADMIN_CPF,
        email: 'ana.pix@xpartner.test',
        password: PASSWORD,
      },
    });
    assert.equal(adminRegister.statusCode, 201, adminRegister.body);
    const admin = adminRegister.json() as { token: string; user: { id: string } };

    const clientRegister = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/register',
      payload: {
        name: 'Cristian Ribeiro Florencio',
        document: CRISTIAN_CPF,
        email: 'cristian.pix@xpartner.test',
        password: PASSWORD,
      },
    });
    assert.equal(clientRegister.statusCode, 201, clientRegister.body);
    const client = clientRegister.json() as { user: { id: string }; requiresApproval: boolean };
    assert.equal(client.requiresApproval, true);

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/v1/bank/admin/users/${client.user.id}/approve`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    assert.equal(approve.statusCode, 200, approve.body);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/login',
      payload: { identifier: CRISTIAN_CPF, password: PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);
    const session = login.json() as { token: string; account: { number: string; balanceCents: number } };

    const adminKey = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/pix/keys',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { type: 'CPF', value: '529.982.247-25', label: 'Receber' },
    });
    assert.equal(adminKey.statusCode, 201, adminKey.body);
    assert.equal((adminKey.json() as { key: { key: string } }).key.key, ADMIN_CPF);

    const create = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/pix/keys',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { value: 'cristian.ribeiro@xpartner.test' },
    });
    assert.equal(create.statusCode, 201, create.body);
    const createdKey = (create.json() as { key: { id: string; type: string; masked: string } }).key;
    assert.equal(createdKey.type, 'EMAIL');
    assert.equal(createdKey.masked, 'cr**************@xpartner.test');

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/pix/keys',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(list.statusCode, 200);
    assert.equal((list.json() as { keys: unknown[] }).keys.length, 1);

    const brcode = await ctx.app.inject({
      method: 'GET',
      url: `/v1/bank/pix/keys/${createdKey.id}/brcode?amountCents=2500`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(brcode.statusCode, 200);
    const code = brcode.json() as { payload: string; amountCents: number };
    assert.equal(code.amountCents, 2500);
    assert.equal(validatePixPayload(code.payload), true);

    const validate = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/accounts/validate?base=123456&digit=X',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(validate.statusCode, 200);
    assert.equal((validate.json() as { check: { valid: boolean; legacyX: boolean } }).check.legacyX, true);
    const validateNumber = await ctx.app.inject({
      method: 'GET',
      url: `/v1/bank/accounts/validate?number=${session.account.number}`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal((validateNumber.json() as { check: { valid: boolean } }).check.valid, true);

    const lookup = await ctx.app.inject({
      method: 'GET',
      url: `/v1/bank/pix/lookup?key=${CRISTIAN_CPF}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    assert.equal(lookup.statusCode, 404);

    const lookupEmail = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/pix/lookup?key=cristian.ribeiro@xpartner.test',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    assert.equal(lookupEmail.statusCode, 200, lookupEmail.body);
    assert.equal((lookupEmail.json() as { recipient: { name: string } }).recipient.name, 'Cristian Ribeiro Florencio');

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/demo/credit',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { amountCents: 100_000 },
    });

    const transfer = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/transfers',
      headers: { authorization: `Bearer ${session.token}` },
      payload: {
        amountCents: 7_500,
        description: 'Pix para a administradora',
        recipient: { pixKey: '529.982.247-25' },
      },
    });
    assert.equal(transfer.statusCode, 201, transfer.body);
    const receipt = transfer.json() as {
      transfer: { id: string; channel: string; kindLabel?: string };
      account: { balanceCents: number };
      pix: { keyType: string; keyMasked: string; name: string };
    };
    assert.equal(receipt.transfer.channel, 'PIX');
    assert.equal(receipt.account.balanceCents, 92_500);
    assert.equal(receipt.pix.keyType, 'CPF');
    assert.equal(receipt.pix.keyMasked, '529.***.***-25');

    const receiptById = await ctx.app.inject({
      method: 'GET',
      url: `/v1/bank/transfers/${receipt.transfer.id}`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(receiptById.statusCode, 200);
    assert.equal((receiptById.json() as { transfer: { channel: string } }).transfer.channel, 'PIX');

    const statement = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/statement',
      headers: { authorization: `Bearer ${session.token}` },
    });
    const entries = (statement.json() as { entries: Array<{ channel: string; kindLabel: string }> }).entries;
    assert.equal(entries[0]?.channel, 'PIX');
    assert.equal(entries[0]?.kindLabel, 'Pix enviado');

    const selfLookup = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/pix/lookup?key=cristian.ribeiro@xpartner.test',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(selfLookup.statusCode, 422);

    const adminKeys = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/admin/pix/keys',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    assert.equal(adminKeys.statusCode, 200);
    assert.equal((adminKeys.json() as { data: unknown[] }).data.length, 2);

    const remove = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/bank/pix/keys/${createdKey.id}`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(remove.statusCode, 200);
    assert.equal((remove.json() as { status: string }).status, 'DELETED');
  } finally {
    await ctx.app.close();
  }
});
