import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MerchantCore } from '../src/merchant/core.ts';
import type { SqlStorageLike } from '../src/merchant/sqlite.ts';

interface Cursor {
  toArray(): Array<Record<string, unknown>>;
  rowsWritten?: number;
}

/**
 * O Durable Object fala com o SQLite do runtime; aqui o mesmo contrato é
 * atendido pelo SQLite do Node, para o teste exercising as rotas reais.
 * Scripts de várias instruções vão para `exec`, porque `prepare` do SQLite do
 * Node silenciosamente ignora tudo depois da primeira instrução.
 */
function storageOf(database: DatabaseSync): SqlStorageLike {
  const isRead = (query: string): boolean =>
    /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(query) || /\bRETURNING\b/i.test(query);
  const isScript = (query: string): boolean => /;\s*\S/.test(query.trim().replace(/;\s*$/, ''));

  return {
    exec(query: string, ...bindings: unknown[]): Cursor {
      if (isRead(query)) {
        return { toArray: () => database.prepare(query).all(...bindings) as Array<Record<string, unknown>>, rowsWritten: 0 };
      }
      if (bindings.length === 0 && isScript(query)) {
        database.exec(query);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const result = database.prepare(query).run(...bindings);
      return { toArray: () => [], rowsWritten: Number(result.changes) };
    },
  };
}

function newCore(): MerchantCore {
  const database = new DatabaseSync(':memory:');
  const storage = storageOf(database);
  const ctx = {
    storage: {
      sql: storage,
      transactionSync(work: () => void) {
        work();
      },
    },
    blockConcurrencyWhile(work: () => Promise<void>): Promise<void> {
      return work();
    },
  };
  return new MerchantCore(ctx as never);
}

async function jsonOf(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://merchant.internal${path}`, init);
}

function bearer(token: string, method = 'GET', payload?: unknown): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  };
}

test('token público do edge lê o painel mas não fabrica lançamento', async () => {
  const core = newCore();

  const bootstrap = await jsonOf(await core.fetch(request('/v1/demo/bootstrap')));
  assert.equal(typeof bootstrap.token, 'string');
  assert.equal(bootstrap.canSimulate, false);
  assert.equal(bootstrap.scopes, 'demo:read demo:write');

  const session = await jsonOf(
    await core.fetch(request('/v1/auth/demo', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })),
  );
  assert.equal(session.canSimulate, false);

  for (const token of [bootstrap.token, session.token]) {
    const sale = await core.fetch(
      request('/v1/demo/sales', bearer(token, 'POST', { amountCents: 5_000, method: 'DEBIT' })),
    );
    assert.equal(sale.status, 403);
    assert.match(((await jsonOf(sale)).error?.message ?? '') as string, /demo:simulate/);

    const charge = await core.fetch(request('/v1/demo/pix', bearer(token, 'POST', { amountCents: 5_000 })));
    assert.equal(charge.status, 403);

    const settle = await core.fetch(
      request('/v1/open-finance/debits/ofd_inexistente/settle', bearer(token, 'POST', {})),
    );
    assert.equal(settle.status, 403, 'liquidação de Open Finance também exige o operador');
  }

  const overview = await core.fetch(request('/v1/overview', bearer(bootstrap.token)));
  assert.equal(overview.status, 200, 'a leitura do painel continua funcionando');

  const transactions = await jsonOf(await core.fetch(request('/v1/transactions', bearer(bootstrap.token))));
  assert.deepEqual(transactions.data, [], 'nenhum lançamento entrou pela tentativa anônima');
});

test('token do operador autenticado liberou a maquininha no edge', async () => {
  const core = newCore();

  const mint = await jsonOf(
    await core.fetch(
      request('/internal/admin/simulator-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'admin_test' }),
      }),
    ),
  );
  assert.equal(mint.tokenType, 'Bearer');
  assert.match(mint.scopes as string, /demo:simulate/);
  assert.equal(mint.issuedTo, 'admin_test');

  const sale = await core.fetch(
    request('/v1/demo/sales', bearer(mint.token, 'POST', { amountCents: 12_900, method: 'DEBIT', brand: 'visa', last4: '4242' })),
  );
  assert.equal(sale.status, 200);

  const listed = await jsonOf(await core.fetch(request('/v1/transactions', bearer(mint.token))));
  assert.equal(listed.data.length, 1, 'o lançamento do operador aparece na leitura');
});
