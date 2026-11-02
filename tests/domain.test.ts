import assert from 'node:assert/strict';
import test from 'node:test';
import { postGroup, trialBalance } from '../src/domain/ledger.ts';
import { assessRisk, recordRiskLinks, riskGraphStats } from '../src/domain/risk.ts';
import { routeTransaction } from '../src/domain/routing.ts';
import { buildPixPayload, normalizeTxid, validatePixPayload } from '../src/domain/pix.ts';
import { buildNfce, generateAccessKey, transmitToSefaz } from '../src/domain/fiscal.ts';
import { advanceOffer, settlementPlan } from '../src/domain/settlement.ts';
import { mod11CheckDigit } from '../src/kernel/fiscal-digits.ts';
import { DEMO_MERCHANT_ID, DEMO_TERMINAL_ID } from '../src/modules/seed.ts';
import { testConfig, testDb } from './helpers.ts';

test('ledger: lance de dupla entrada balanceado fecha o balancete', () => {
  const db = testDb();
  postGroup(db, {
    groupId: 'grp_1',
    groupKind: 'SALE',
    entries: [
      { kind: 'ACQUIRER_RECEIVABLE', direction: 'DEBIT', amountCents: 10_000 },
      { kind: 'MERCHANT_PAYABLE', ownerType: 'MERCHANT', ownerId: DEMO_MERCHANT_ID, direction: 'CREDIT', amountCents: 9_750 },
      { kind: 'FEE_REVENUE', direction: 'CREDIT', amountCents: 250 },
    ],
  });

  const trial = trialBalance(db);
  assert.equal(trial.debitCents, 10_000);
  assert.equal(trial.creditCents, 10_000);
  assert.equal(trial.balanced, true);

  assert.throws(
    () =>
      postGroup(db, {
        groupId: 'grp_bad',
        groupKind: 'SALE',
        entries: [
          { kind: 'CASH', direction: 'DEBIT', amountCents: 100 },
          { kind: 'FEE_REVENUE', direction: 'CREDIT', amountCents: 90 },
        ],
      }),
    /desbalanceado/,
  );
});

test('ledger: grupo exige ao menos duas partidas', () => {
  const db = testDb();
  assert.throws(
    () =>
      postGroup(db, {
        groupId: 'grp_unico',
        groupKind: 'SALE',
        entries: [{ kind: 'CASH', direction: 'DEBIT', amountCents: 100 }],
      }),
    /ao menos dois/,
  );
});

test('risco: velocidade e grafo elevam o score de forma explicável', () => {
  const db = testDb();
  const now = Date.now();
  const fingerprint = 'fp_cartao_teste';
  const insert = db.prepare(
    `INSERT INTO transactions (id, merchant_id, terminal_id, amount_cents, method, installments, status, card_fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, 5000, 'DEBIT', 1, 'APPROVED', ?, ?, ?)`,
  );
  for (let index = 0; index < 5; index += 1) {
    insert.run(`txn_v${index}`, DEMO_MERCHANT_ID, DEMO_TERMINAL_ID, fingerprint, new Date(now - 60_000).toISOString(), new Date(now - 60_000).toISOString());
  }

  const result = assessRisk(db, {
    merchantId: DEMO_MERCHANT_ID,
    terminalId: DEMO_TERMINAL_ID,
    cardFingerprint: fingerprint,
    amountCents: 5_000,
    method: 'DEBIT',
    installments: 1,
    hour: 14,
    now,
  });
  assert.equal(result.score, 30, JSON.stringify(result.reasons));
  assert.equal(result.decision, 'APPROVE');
  assert.ok(result.reasons.some((reason) => reason.code === 'VELOCITY_1H'));

  recordRiskLinks(db, {
    cardFingerprint: fingerprint,
    terminalId: DEMO_TERMINAL_ID,
    merchantId: DEMO_MERCHANT_ID,
    flagged: true,
  });
  const flagged = assessRisk(db, {
    merchantId: DEMO_MERCHANT_ID,
    terminalId: DEMO_TERMINAL_ID,
    cardFingerprint: fingerprint,
    amountCents: 5_000,
    method: 'DEBIT',
    installments: 1,
    hour: 14,
    now,
  });
  assert.ok(flagged.score >= 75, JSON.stringify(flagged.reasons));
  assert.equal(flagged.decision, 'DECLINE');
  assert.ok(flagged.reasons.some((reason) => reason.code === 'GRAPH_FLAGGED_LINK'));

  const stats = riskGraphStats(db);
  assert.ok(stats.edges >= 4);
  assert.ok(stats.flagged >= 1);
});

test('roteamento: escolhe o menor custo esperado por método e bandeira', () => {
  const db = testDb();
  const debit = routeTransaction(db, { method: 'DEBIT', installments: 1, amountCents: 10_000 });
  assert.equal(debit.selected.acquirerId, 'acq_getnet');
  assert.ok(debit.alternatives.length >= 2);

  const credit = routeTransaction(db, { method: 'CREDIT', brand: 'Visa', installments: 1, amountCents: 10_000 });
  assert.equal(credit.selected.acquirerId, 'acq_stone');

  const amex = routeTransaction(db, { method: 'CREDIT', brand: 'Amex', installments: 1, amountCents: 10_000 });
  assert.equal(amex.selected.acquirerId, 'acq_stone');
  assert.ok(amex.alternatives.every((quote) => quote.acquirerId !== 'acq_rede'));

  const pix = routeTransaction(db, { method: 'PIX', installments: 1, amountCents: 10_000 });
  assert.equal(pix.selected.acquirerId, 'acq_spi');
});

test('pix: BR Code EMV com CRC16 válido e txid normalizado', () => {
  const payload = buildPixPayload({
    pixKey: 'pagamentos@xpartner.com.br',
    merchantName: 'Padaria Pao de Ouro',
    merchantCity: 'SAO PAULO',
    amountCents: 3_490,
    txid: 'XP12345678901234567890',
    description: 'Cafe especial',
  });
  assert.ok(payload.startsWith('000201'));
  assert.ok(payload.includes('540534.90'));
  assert.equal(validatePixPayload(payload), true);

  const tampered = payload.slice(0, -1) + (payload.endsWith('0') ? '1' : '0');
  assert.equal(validatePixPayload(tampered), false);
  assert.equal(normalizeTxid('abc-123.def/456'), 'abc123def456');
});

test('fiscal: chave de acesso de 44 dígitos com DV mod-11 válido', () => {
  const emittedAt = new Date('2026-10-31T12:00:00-03:00');
  const key = generateAccessKey({
    cUF: '35',
    emittedAt,
    cnpj: '12345678000195',
    serie: 1,
    number: 42,
    tpEmis: '1',
    cNF: '12345678',
  });
  assert.equal(key.length, 44);
  assert.match(key, /^\d{44}$/);

  const base = key.slice(0, 43);
  assert.equal(Number(key[43]), mod11CheckDigit(base));
  assert.ok(key.startsWith('352610'));
  assert.ok(key.includes('12345678000195'));
  assert.equal(key.slice(22, 25), '001');
  assert.equal(key.slice(25, 34), '000000042');
});

test('fiscal: NFC-e assinada, escapada e com QR Code; contingência muda tpEmis', () => {
  const config = testConfig();
  const input = {
    merchant: {
      cnpj: '12345678000195',
      legalName: 'PAO & CIA <COMERCIO> LTDA',
      tradeName: 'Padaria "Pao de Ouro"',
      ie: '110042490114',
      city: 'SAO PAULO',
      uf: 'SP',
      cMun: config.fiscal.cMun,
      crt: '1' as const,
    },
    transactionId: 'txn_fiscal_teste',
    nsu: '123456789',
    authorizationCode: 'ABC123',
    method: 'CREDIT' as const,
    amountCents: 12_900,
    installments: 2,
    items: [
      {
        code: 'SKU1',
        name: 'Cesta <especial> & cia',
        ncm: '21069090',
        cfop: '5102',
        quantity: 1,
        unit: 'UN',
        unitPriceCents: 12_900,
        totalCents: 12_900,
      },
    ],
    serie: 1,
    number: 7,
    emittedAt: new Date('2026-10-31T15:00:00-03:00'),
    ambiente: 'homologacao' as const,
    keySeed: 'txn_fiscal_teste:mch',
  };

  const online = buildNfce({ ...input, contingency: false }, config);
  assert.equal(online.accessKey.length, 44);
  assert.match(online.xml, /<SignatureValue>/);
  assert.match(online.xml, /PAO &amp; CIA &lt;COMERCIO&gt; LTDA/);
  assert.match(online.xml, /Cesta &lt;especial&gt; &amp; cia/);
  assert.match(online.xml, /<qrCode>/);
  assert.ok(online.qrCodeUrl.includes(online.accessKey));
  assert.ok(online.danfeText.includes('Chave de acesso'));
  assert.ok(online.danfeText.includes('Cesta <especial> & cia'));
  assert.ok(online.escpos.includes('\x1b@'));

  const contingency = buildNfce({ ...input, contingency: true }, config);
  assert.equal(contingency.accessKey.slice(34, 35), '9');
  assert.ok(contingency.danfeText.includes('CONTINGENCIA'));
});

test('fiscal: SEFAZ determinística autoriza e rejeita com motivo', () => {
  const approved = transmitToSefaz('3526101234567800019565001000000042112345678x', 1, 0);
  assert.equal(approved.authorized, true);
  assert.match(approved.protocol ?? '', /^\d{15}$/);

  let rejected = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!transmitToSefaz('3526101234567800019565001000000042112345678x', attempt, 100).authorized) {
      rejected += 1;
    }
  }
  assert.ok(rejected >= 3);
});

test('liquidação: prazos por método e antecipação elegível só em recebível pendente', () => {
  const createdAt = new Date().toISOString();
  assert.equal(settlementPlan('PIX', createdAt).daysToSettle, 0);
  assert.equal(settlementPlan('DEBIT', createdAt).daysToSettle, 1);
  assert.equal(settlementPlan('CREDIT', createdAt).daysToSettle, 30);

  const db = testDb();
  const now = Date.now();
  const future = new Date(now + 20 * 86_400_000).toISOString();
  const past = new Date(now - 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO transactions (id, merchant_id, terminal_id, amount_cents, method, installments, status, risk_score, created_at, updated_at)
     VALUES ('txn_adv', ?, ?, 10000, 'CREDIT', 1, 'APPROVED', 0, ?, ?)`,
  ).run(DEMO_MERCHANT_ID, DEMO_TERMINAL_ID, past, past);
  db.prepare(
    `INSERT INTO settlements (id, transaction_id, merchant_id, gross_cents, acquirer_fee_cents, net_cents, scheduled_at, status, mode, created_at)
     VALUES ('stl_adv', 'txn_adv', ?, 10000, 200, 9800, ?, 'PENDING', 'STANDARD', ?)`,
  ).run(DEMO_MERCHANT_ID, future, past);

  const offer = advanceOffer(db, 'txn_adv', now);
  assert.equal(offer.eligible, true);
  assert.ok(offer.daysEarly >= 19 && offer.daysEarly <= 20);
  assert.ok(offer.rateBps >= 80 && offer.rateBps <= 600);
  assert.ok(offer.feeCents > 0);
  assert.ok(offer.netCents < 9800);

  const missing = advanceOffer(db, 'txn_inexistente', now);
  assert.equal(missing.eligible, false);
});
