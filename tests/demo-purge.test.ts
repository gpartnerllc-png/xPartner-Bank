import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import { migrate } from '../src/kernel/db.ts';
import { openDb } from '../src/kernel/db-node.ts';
import type { Db } from '../src/kernel/db.ts';
import { DEMO_MERCHANT_ID, seedCore, seedDemoData } from '../src/modules/seed.ts';
import { BillingService } from '../src/modules/billing.ts';
import { CustomerService } from '../src/modules/customers.ts';
import { TransactionService } from '../src/modules/transactions.ts';
import { PixService } from '../src/modules/pix.ts';
import { BankService, ledgerTrialBalance } from '../src/modules/bank.ts';
import { BankAuthService } from '../src/modules/bank-auth.ts';
import {
  PURGE_CONFIRM_PHRASE,
  QA_EMAIL_DOMAIN,
  previewPurge,
  purgeDemoData,
} from '../src/modules/demo-purge.ts';
import { listBalances } from '../src/domain/ledger.ts';
import { fundSystemAccounts, testConfig } from './helpers.ts';

const PASSWORD = 'SenhaForte#2026';
const VITRINE_CPF = '52998224725';

function vitrineEmail(name: string): string {
  return `${name}${QA_EMAIL_DOMAIN}`;
}

/** Núcleo com a vitrine semeada: vendas, Pix, cliente e boleto de demonstração. */
function seededDb(): Db {
  const config = loadConfig({
    NODE_ENV: 'test',
    XPARTNER_MASTER_KEY: 'test-master-key-0123456789abcdefghij',
    DEMO_MODE: 'true',
    SEED_DEMO: 'true',
    FISCAL_LATENCY_MS: '0',
    FISCAL_REJECTION_PCT: '0',
  } as NodeJS.ProcessEnv);
  const db = openDb(':memory:');
  migrate(db);
  seedCore(db);

  const transactions = new TransactionService(db, config);
  const pix = new PixService(db, config, transactions);
  seedDemoData(db, config, transactions, pix);

  const customers = new CustomerService(db);
  const billing = new BillingService(db, transactions, pix, customers);
  customers.create({
    merchantId: DEMO_MERCHANT_ID,
    name: 'Cliente de Vitrine',
    document: VITRINE_CPF,
    email: vitrineEmail('vitrine'),
  });
  billing.createBoleto({
    merchantId: DEMO_MERCHANT_ID,
    amountCents: 5_000,
    payerName: 'Cliente de Vitrine',
    payerDocument: VITRINE_CPF,
    description: 'Cobrança de demonstração',
  });

  fundSystemAccounts(db);
  return db;
}

test('purge: inventário lista antes o que vai ser apagado', () => {
  const db = seededDb();
  const preview = previewPurge(db);

  assert.ok(preview.rows > 0, 'a vitrine semeada precisa ter linhas para apagar');
  assert.ok(preview.tables.transactions > 0);
  assert.ok(preview.tables.customers > 0);
  assert.ok(preview.tables.boletos > 0);
  assert.ok(preview.tables.ledger_entries > 0);
  assert.ok(preview.accountsWithBalance > 0, 'tesouraria e capital entram na prévia');
});

test('purge: apaga lançamentos, zera saldos e preserva a estrutura', () => {
  const config = testConfig();
  const db = seededDb();
  const bank = new BankService(db, config);
  const auth = new BankAuthService(db, config, bank);

  // primeiro cadastro em modo demo vira o administrador da rede
  const owner = auth.register({
    name: 'Titular Real',
    document: '34259998854',
    email: 'titular.real@vidareal.com.br',
    password: PASSWORD,
  });
  const boneco = auth.register({
    name: 'Boneco de Teste',
    document: '23456789092',
    email: vitrineEmail('boneco'),
    password: PASSWORD,
  });
  auth.approve(owner.user.id, boneco.user.id);
  bank.funding({
    actorUserId: owner.user.id,
    targetUserId: boneco.user.id,
    amountCents: 1_000,
    description: 'Aporte para o boneco',
  });

  const result = purgeDemoData(db, { actor: owner.user.id });

  assert.ok(result.deleted.transactions && result.deleted.transactions > 0);
  assert.ok(result.deleted.customers && result.deleted.customers > 0, 'clientes de vitrine somem da base');
  assert.ok(result.deleted.boletos && result.deleted.boletos > 0);
  assert.ok(result.removedQaUsers.includes('Boneco de Teste'));

  for (const table of ['transactions', 'ledger_entries', 'boletos', 'customers', 'bank_ledger', 'bank_transfers']) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    assert.equal(row.n, 0, `${table} deve ficar vazia`);
  }

  const merchant = db
    .prepare('SELECT COUNT(*) AS n FROM merchants WHERE id = ?')
    .get(DEMO_MERCHANT_ID) as { n: number };
  assert.equal(merchant.n, 1, 'o lojista estrutural continua cadastrado');
  const acquirers = db.prepare('SELECT COUNT(*) AS n FROM acquirers').get() as { n: number };
  assert.ok(acquirers.n > 0, 'a tabela de adquirentes é estrutura, não lançamento');

  const remaining = db
    .prepare('SELECT name FROM bank_users WHERE role <> ?')
    .all('SYSTEM') as Array<{ name: string }>;
  assert.deepEqual(
    remaining.map((row) => row.name),
    ['Titular Real'],
    'sobra apenas quem é de verdade',
  );

  const accounts = db.prepare('SELECT balance_cents FROM bank_accounts').all() as Array<{ balance_cents: number }>;
  assert.ok(accounts.length > 0 && accounts.every((row) => row.balance_cents === 0), 'todo saldo recomeça em zero');
  const wallets = db.prepare('SELECT balance_cents FROM bank_fx_wallets').all() as Array<{ balance_cents: number }>;
  assert.ok(wallets.every((row) => row.balance_cents === 0), 'carteiras internacionais também zeram');
  assert.equal(ledgerTrialBalance(db).balanced, true, 'o livro-razão bancário continua quadrado');

  const merchantBalances = listBalances(db, { ownerType: 'MERCHANT', ownerId: DEMO_MERCHANT_ID });
  assert.ok(merchantBalances.length > 0);
  assert.equal(
    merchantBalances.reduce((total, balance) => total + Math.abs(balance.balanceCents), 0),
    0,
    'lojista sem lançamento acorda com saldo zero',
  );
});

test('purge: é idempotente e exige a frase fixa de confirmação', () => {
  const db = seededDb();
  const first = purgeDemoData(db, { actor: 'script:teste' });
  assert.ok(Object.keys(first.deleted).length > 0);

  const second = purgeDemoData(db, { actor: 'script:teste' });
  assert.deepEqual(second.deleted, {}, 'nada mais para apagar');
  assert.deepEqual(second.removedQaUsers, []);

  assert.equal(PURGE_CONFIRM_PHRASE, 'APAGAR DADOS DE DEMONSTRACAO');
});
