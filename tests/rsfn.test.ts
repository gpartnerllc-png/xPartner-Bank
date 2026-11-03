import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAG0004,
  buildNumCtrlIf,
  buildPag0004Xml,
  parsePag0004Xml,
  validatePag0004,
  type Pag0004Message,
} from '../src/domain/rsfn.ts';
import { BankService, ensureTreasury, TREASURY_ACCOUNT_ID } from '../src/modules/bank.ts';
import { BankAuthService } from '../src/modules/bank-auth.ts';
import {
  RSFN_TRANSIT_ACCOUNT_ID,
  RsfnService,
  ensureRsfnTransit,
} from '../src/modules/rsfn.ts';
import { TEST_TREASURY_CENTS, testConfig, testDb } from './helpers.ts';
import { buildTestServer } from './test-server.ts';

const PASSWORD = 'SenhaForte#2026';
const NOW = Date.parse('2026-10-31T12:34:56.000Z');

function sample(overrides: Partial<Pag0004Message> = {}): Pag0004Message {
  return {
    numCtrlIf: buildNumCtrlIf('12345678', NOW, 7),
    codMsg: PAG0004,
    ispbEmissor: '12345678',
    ispbDestinatario: '87654321',
    dtMovto: '2026-10-31',
    codCliEmissor: '0001',
    documentoEmissor: '52998224725',
    nomeEmissor: 'Ana & Cia <Tesouraria>',
    agenciaDestinatario: '0001',
    contaDestinatario: '000123456',
    documentoDestinatario: '11144477735',
    nomeDestinatario: "João D'Ávila",
    valorCents: 150_000,
    finalidadeTransacao: '0001',
    ...overrides,
  };
}

function codes(issues: Array<{ code: string }>): string[] {
  return issues.map((issue) => issue.code);
}

test('rsfn: builder escapa XML e parser devolve exatamente o mesmo PAG0004', () => {
  const message = sample();
  const xml = buildPag0004Xml(message);
  assert.match(xml, new RegExp(`<DOC xmlns="http://bcb.gov.br">`));
  assert.match(xml, /<CodMsg>PAG0004<\/CodMsg>/);
  assert.match(xml, new RegExp(`<NumCtrlIF>${message.numCtrlIf}</NumCtrlIF>`));
  assert.match(xml, /<NomCliEmissor>Ana &amp; Cia &lt;Tesouraria&gt;<\/NomCliEmissor>/);
  assert.match(xml, /<NomCliDestinatario>João D&apos;Ávila<\/NomCliDestinatario>/);
  assert.match(xml, /<VlrLanc>1500.00<\/VlrLanc>/);

  const parsed = parsePag0004Xml(xml);
  assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.message?.numCtrlIf, message.numCtrlIf);
  assert.equal(parsed.message?.nomeEmissor, message.nomeEmissor);
  assert.equal(parsed.message?.nomeDestinatario, message.nomeDestinatario);
  assert.equal(parsed.message?.valorCents, 150_000);
  assert.equal(parsed.sha256.length, 64);
  assert.equal(parsed.sha256, parsePag0004Xml(xml).sha256);
});

test('rsfn: validação rejeita ISPB igual, documento inválido, data, valor e finalidade', () => {
  assert.deepEqual(validatePag0004(sample()), []);
  assert.ok(codes(validatePag0004(sample({ ispbDestinatario: '12345678' }))).includes('ISPB_IGUAL'));
  assert.ok(codes(validatePag0004(sample({ documentoDestinatario: '12345678901' }))).includes('DOCUMENTO'));
  assert.ok(codes(validatePag0004(sample({ dtMovto: '2026-02-30' }))).includes('DATA'));
  assert.ok(codes(validatePag0004(sample({ finalidadeTransacao: '0002' }))).includes('FINALIDADE'));
  assert.ok(codes(validatePag0004(sample({ valorCents: 0 }))).includes('VALOR'));
  assert.ok(codes(validatePag0004(sample({ valorCents: 100_000_001 }))).includes('VALOR_LIMITE'));
  assert.ok(codes(validatePag0004(sample({ agenciaDestinatario: '0001A' }))).includes('AGENCIA'));
  assert.ok(codes(validatePag0004(sample({ nomeDestinatario: ' ' }))).includes('NOME'));

  const otherDate = buildNumCtrlIf('12345678', Date.parse('2026-10-30T12:34:56.000Z'), 1);
  assert.ok(codes(validatePag0004(sample({ numCtrlIf: otherDate }))).includes('NUM_CTRL_DATA'));

  assert.throws(() => buildPag0004Xml(sample({ ispbDestinatario: '12345678' })), (error: unknown) => {
    return error instanceof Error && 'code' in error && (error as { code: string }).code === 'RSFN_INVALID';
  });
});

test('rsfn: parser bloqueia DTD/XXE, elementos desconhecidos, duplicidade e atributos', () => {
  const xml = buildPag0004Xml(sample());
  const doctype = xml.replace('<DOC', '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><DOC');
  assert.ok(codes(parsePag0004Xml(doctype).issues).includes('XML_PROIBIDO'));

  const entity = xml.replace('Ana &amp; Cia', ' &xxe; ');
  assert.ok(codes(parsePag0004Xml(entity).issues).includes('XML_ENTIDADE'));

  const unknown = xml.replace('<VlrLanc>', '<CampoSecreto>x</CampoSecreto><VlrLanc>');
  assert.ok(codes(parsePag0004Xml(unknown).issues).includes('XML_ELEMENTO'));

  const duplicate = xml.replace('<DtMovto>', '<DtMovto>2026-10-31</DtMovto><DtMovto>');
  assert.ok(codes(parsePag0004Xml(duplicate).issues).includes('XML_DUPLICADO'));

  const attribute = xml.replace('<VlrLanc>', '<VlrLanc moeda="USD">');
  assert.ok(codes(parsePag0004Xml(attribute).issues).includes('XML_ATRIBUTO'));

  const wrongRoot = xml.replace('<DOC xmlns="http://bcb.gov.br">', '<DOC xmlns="http://evil.example">');
  assert.ok(codes(parsePag0004Xml(wrongRoot).issues).includes('XML_NAMESPACE'));

  const valueFormat = xml.replace('1500.00', '1.500,00');
  const valueResult = parsePag0004Xml(valueFormat);
  assert.equal(valueResult.valid, false);
  assert.ok(codes(valueResult.issues).includes('VALOR_FORMATO'));

  const missing = xml.replace(/<NomCliDestinatario>.*<\/NomCliDestinatario>/, '');
  assert.ok(codes(parsePag0004Xml(missing).issues).includes('XML_OBRIGATORIO'));

  const nested = xml.replace('</BC>', '<BC></BC></BC>');
  assert.equal(parsePag0004Xml(nested).valid, false);
});

test('rsfn: ciclo externo debita o cliente, compensa, aceita e estorna com partidas dobradas', () => {
  const config = testConfig();
  const db = testDb();
  ensureTreasury(db);
  ensureRsfnTransit(db);
  const bank = new BankService(db, config);
  const auth = new BankAuthService(db, config, bank);
  const rsfn = new RsfnService(db, config);

  const admin = auth.register({
    name: 'Irene Admin',
    document: '529.982.247-25',
    email: 'irene.admin@xpartner.test',
    password: PASSWORD,
  });
  bank.funding({ actorUserId: admin.user.id, targetUserId: admin.user.id, amountCents: 800_000 });
  const accountId = admin.account!.id;

  assert.equal(rsfn.configView().enabled, true);
  assert.equal(rsfn.configView().transport, 'SIMULATED');
  assert.equal(rsfn.configView().liveConnectorReady, false);

  const created = rsfn.create({
    userId: admin.user.id,
    accountId,
    amountCents: 150_000,
    description: 'Pagamento a fornecedor',
    destination: {
      ispb: '87654321',
      branch: '0001',
      account: '000123456',
      document: '11144477735',
      name: 'João D Ávila',
    },
    idempotencyKey: 'rsfn-idem-0001',
    now: NOW,
  });
  assert.equal(created.replayed, false);
  assert.equal(created.message.status, 'SENT');
  assert.equal(created.message.transport, 'SIMULATED');
  assert.equal(created.message.amountCents, 150_000);
  assert.equal(created.message.ispbEmissor, '99999999');
  assert.equal(created.message.ispbDestinatario, '87654321');
  assert.equal(created.message.endToEndId, created.message.numCtrlIf);
  assert.equal(created.transfer.balanceAfterCents, 650_000);
  assert.equal(created.account.balanceCents, 650_000);

  const parsed = parsePag0004Xml(created.xml);
  assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
  assert.equal(parsed.message?.valorCents, 150_000);

  const transit = db.prepare('SELECT balance_cents FROM bank_accounts WHERE id = ?').get(RSFN_TRANSIT_ACCOUNT_ID) as {
    balance_cents: number;
  };
  assert.equal(transit.balance_cents, 150_000);

  const statement = bank.statement(accountId, { limit: 10 });
  const rsfnEntry = statement.entries.find((entry) => entry.channel === 'RSFN');
  assert.ok(rsfnEntry);
  assert.equal(rsfnEntry?.kind, 'RSFN');
  assert.equal(rsfnEntry?.direction, 'OUT');
  assert.equal(rsfnEntry?.kindLabel, 'RSFN · PAG0004');
  assert.equal(rsfnEntry?.counterparty.name, 'João D Ávila');

  const replay = rsfn.create({
    userId: admin.user.id,
    accountId,
    amountCents: 150_000,
    description: 'Pagamento a fornecedor',
    destination: {
      ispb: '87654321',
      branch: '0001',
      account: '000123456',
      document: '11144477735',
      name: 'João D Ávila',
    },
    idempotencyKey: 'rsfn-idem-0001',
    now: NOW + 1000,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.id, created.message.id);
  assert.equal(
    (db.prepare('SELECT balance_cents FROM bank_accounts WHERE id = ?').get(accountId) as { balance_cents: number })
      .balance_cents,
    650_000,
  );

  assert.throws(
    () =>
      rsfn.create({
        userId: admin.user.id,
        accountId,
        amountCents: 150_001,
        description: 'Pagamento a fornecedor',
        destination: {
          ispb: '87654321',
          branch: '0001',
          account: '000123456',
          document: '11144477735',
          name: 'João D Ávila',
        },
        idempotencyKey: 'rsfn-idem-0001',
        now: NOW + 2000,
      }),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'CONFLICT',
  );

  const accepted = rsfn.ack(created.message.id, { decision: 'ACCEPT', actorUserId: admin.user.id, now: NOW + 60_000 });
  assert.equal(accepted.refunded, false);
  assert.equal(accepted.message.status, 'SETTLED');
  assert.equal(accepted.message.acknowledgement.at !== null, true);
  assert.throws(
    () => rsfn.ack(created.message.id, { decision: 'REJECT', actorUserId: admin.user.id }),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'CONFLICT',
  );

  const second = rsfn.create({
    userId: admin.user.id,
    accountId,
    amountCents: 100_000,
    description: 'Segunda remessa',
    destination: {
      ispb: '87654321',
      branch: '0001',
      account: '000123456',
      document: '11144477735',
      name: 'João D Ávila',
    },
    now: NOW + 120_000,
  });
  assert.equal(second.account.balanceCents, 550_000);
  const rejected = rsfn.ack(second.message.id, {
    decision: 'REJECT',
    rejectionCode: 'E999',
    rejectionReason: 'ISPB de destino indisponível',
    actorUserId: admin.user.id,
    now: NOW + 180_000,
  });
  assert.equal(rejected.refunded, true);
  assert.equal(rejected.message.status, 'REJECTED');
  assert.equal(rejected.message.rejection?.code, 'E999');

  const afterReject = bank.statement(accountId, { limit: 10 });
  assert.equal(afterReject.balanceCents, 650_000);
  const refundEntry = afterReject.entries.find((entry) => entry.description.includes('Estorno RSFN'));
  assert.ok(refundEntry);
  assert.equal(refundEntry?.direction, 'IN');
  assert.match(refundEntry?.description ?? '', /Estorno RSFN/);

  const trial = bank.systemOverview().ledger;
  assert.equal(trial.balanced, true);
  const transitAfter = db.prepare('SELECT balance_cents FROM bank_accounts WHERE id = ?').get(RSFN_TRANSIT_ACCOUNT_ID) as {
    balance_cents: number;
  };
  assert.equal(transitAfter.balance_cents, 150_000);

  assert.equal(rsfn.list(admin.user.id).length, 2);
  assert.equal(rsfn.get(created.message.id, { userId: admin.user.id, role: 'USER' }).xml.includes('<DOC'), true);
  assert.throws(
    () => rsfn.get(created.message.id, { userId: 'someone-else', role: 'USER' }),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'FORBIDDEN',
  );
});

test('rsfn: sem ISPB o envio falha e em produção o aceite manual é bloqueado', () => {
  const config = testConfig();
  config.rsfn = { ...config.rsfn, ispb: '' };
  const db = testDb();
  ensureTreasury(db);
  ensureRsfnTransit(db);
  const bank = new BankService(db, config);
  const auth = new BankAuthService(db, config, bank);
  const rsfn = new RsfnService(db, config);

  const admin = auth.register({
    name: 'Júlia Admin',
    document: '529.982.247-25',
    email: 'julia.admin@xpartner.test',
    password: PASSWORD,
  });
  bank.funding({ actorUserId: admin.user.id, targetUserId: admin.user.id, amountCents: 100_000 });
  assert.equal(rsfn.configView().enabled, false);
  assert.throws(
    () =>
      rsfn.create({
        userId: admin.user.id,
        accountId: admin.account!.id,
        amountCents: 10_000,
        destination: { ispb: '87654321', branch: '0001', account: '000123456', document: '11144477735', name: 'Destino' },
      }),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'RSFN_NOT_CONFIGURED',
  );

  const prodConfig = testConfig({ NODE_ENV: 'production', DEMO_MODE: 'false', SEED_DEMO: 'false' });
  const prodRsfn = new RsfnService(db, prodConfig);
  assert.throws(
    () => prodRsfn.ack('qualquer', { decision: 'ACCEPT', actorUserId: 'x' }),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'RSFN_CONNECTOR_REQUIRED',
  );
  assert.equal((db.prepare('SELECT balance_cents FROM bank_accounts WHERE id = ?').get(TREASURY_ACCOUNT_ID) as { balance_cents: number }).balance_cents, TEST_TREASURY_CENTS - 100_000);
});

test('rsfn api: config, validação, envio, download do XML e aceite do administrador', async () => {
  const ctx = await buildTestServer();
  try {
    const register = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/auth/register',
      payload: {
        name: 'Kátia Admin',
        document: '529.982.247-25',
        email: 'katia.admin@xpartner.test',
        password: PASSWORD,
      },
    });
    assert.equal(register.statusCode, 201);
    const session = register.json() as { token: string; account: { id: string } };

    const config = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/rsfn/config',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(config.statusCode, 200);
    assert.equal((config.json() as { config: { enabled: boolean } }).config.enabled, true);

    const xsd = await ctx.app.inject({ method: 'GET', url: '/v1/bank/rsfn/pag0004.xsd' });
    assert.equal(xsd.statusCode, 200);
    assert.match(xsd.headers['content-type'] as string, /application\/xml/);

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/demo/credit',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { amountCents: 500_000 },
    });

    const xml = buildPag0004Xml(sample({ numCtrlIf: buildNumCtrlIf('12345678', NOW, 3) }));
    const validation = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/rsfn/validate',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { xml },
    });
    assert.equal(validation.statusCode, 200);
    assert.equal((validation.json() as { valid: boolean }).valid, true);

    const invalid = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/rsfn/validate',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { xml: xml.replace('<DOC', '<!DOCTYPE x><DOC') },
    });
    assert.equal(invalid.statusCode, 200);
    assert.equal((invalid.json() as { valid: boolean }).valid, false);

    const transfer = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bank/rsfn/transfers',
      headers: { authorization: `Bearer ${session.token}`, 'idempotency-key': 'api-rsfn-idem-01' },
      payload: {
        amountCents: 120_000,
        description: 'Remessa RSFN via API',
        destination: {
          ispb: '87654321',
          branch: '0001',
          account: '000123456',
          document: '111.444.777-35',
          name: 'João D Ávila',
        },
      },
    });
    assert.equal(transfer.statusCode, 201, transfer.body);
    const created = transfer.json() as {
      message: { id: string; numCtrlIf: string; status: string; acknowledgement: { canAcknowledge: boolean } };
      account: { balanceCents: number };
      xml: string;
    };
    assert.equal(created.message.status, 'SENT');
    assert.equal(created.message.acknowledgement.canAcknowledge, true);
    assert.equal(created.account.balanceCents, 380_000);

    const download = await ctx.app.inject({
      method: 'GET',
      url: `/v1/bank/rsfn/messages/${created.message.id}/xml`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, created.xml);
    assert.match(download.headers['content-disposition'] as string, new RegExp(`${created.message.numCtrlIf}\\.xml`));

    const ack = await ctx.app.inject({
      method: 'POST',
      url: `/v1/bank/rsfn/messages/${created.message.id}/ack`,
      headers: { authorization: `Bearer ${session.token}` },
      payload: { decision: 'ACCEPT' },
    });
    assert.equal(ack.statusCode, 200, ack.body);
    assert.equal((ack.json() as { message: { status: string } }).message.status, 'SETTLED');

    const statement = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/statement',
      headers: { authorization: `Bearer ${session.token}` },
    });
    const entries = (statement.json() as { entries: Array<{ kind: string; channel: string }> }).entries;
    const rsfnEntry = entries.find((entry) => entry.channel === 'RSFN');
    assert.ok(rsfnEntry);
    assert.equal(rsfnEntry?.kind, 'RSFN');

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/rsfn/messages',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(list.statusCode, 200);
    assert.equal((list.json() as { data: unknown[] }).data.length, 1);

    const adminList = await ctx.app.inject({
      method: 'GET',
      url: '/v1/bank/admin/rsfn/messages',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(adminList.statusCode, 200);
  } finally {
    await ctx.app.close();
  }
});
