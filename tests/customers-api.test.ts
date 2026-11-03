import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb } from '../src/kernel/db.ts';
import { buildTestServer } from './test-server.ts';

const CPF = '342.599.988-54';

test('clientes: editar, bloquear, desbloquear e remover da base ativa', async () => {
  const ctx = await buildTestServer();
  try {
    const auth = { authorization: `Bearer ${ctx.token}` };

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: auth,
      payload: { name: 'Beatriz Lima', document: CPF, email: 'bia@example.com', city: 'Curitiba', uf: 'PR' },
    });
    assert.equal(created.statusCode, 201);
    const customerId = (created.json() as { customer: { id: string } }).customer.id;

    const edited = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerId}`,
      headers: auth,
      payload: { name: 'Beatriz Lima Costa', email: 'bia.costa@example.com', phone: '41998877665' },
    });
    assert.equal(edited.statusCode, 200);
    const editView = (edited.json() as { customer: { name: string; email: string; phone: string } }).customer;
    assert.equal(editView.name, 'Beatriz Lima Costa');
    assert.equal(editView.email, 'bia.costa@example.com');
    assert.equal(editView.phone, '41998877665');

    const blocked = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerId}`,
      headers: auth,
      payload: { status: 'BLOCKED' },
    });
    assert.equal(blocked.statusCode, 200);
    assert.equal((blocked.json() as { customer: { status: string } }).customer.status, 'BLOCKED');

    const unblocked = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerId}`,
      headers: auth,
      payload: { status: 'ACTIVE' },
    });
    assert.equal((unblocked.json() as { customer: { status: string } }).customer.status, 'ACTIVE');

    const boleto = await ctx.app.inject({
      method: 'POST',
      url: '/v1/boletos',
      headers: auth,
      payload: { amountCents: 4_500, dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), customerId },
    });
    assert.equal(boleto.statusCode, 201);

    const removed = await ctx.app.inject({ method: 'DELETE', url: `/v1/customers/${customerId}`, headers: auth });
    assert.equal(removed.statusCode, 200);
    const removedView = removed.json() as {
      customer: { name: string; email: string | null; phone: string | null; status: string; archivedAt: string };
      preserved: { boletos: number };
    };
    assert.equal(removedView.customer.email, null);
    assert.equal(removedView.customer.phone, null);
    assert.equal(removedView.customer.status, 'BLOCKED');
    assert.match(removedView.customer.name, /^Cliente removido/);
    assert.ok(removedView.customer.archivedAt);
    assert.equal(removedView.preserved.boletos, 1);

    const listAfter = await ctx.app.inject({ method: 'GET', url: '/v1/customers?limit=100', headers: auth });
    assert.ok(!(listAfter.json() as { data: Array<{ id: string }> }).data.some((c) => c.id === customerId));

    const boletoStillThere = await ctx.app.inject({
      method: 'GET',
      url: '/v1/boletos?limit=100',
      headers: auth,
    });
    const boletoId = (boleto.json() as { boleto: { id: string } }).boleto.id;
    assert.ok((boletoStillThere.json() as { data: Array<{ id: string }> }).data.some((b) => b.id === boletoId));

    const again = await ctx.app.inject({ method: 'DELETE', url: `/v1/customers/${customerId}`, headers: auth });
    assert.equal(again.statusCode, 409);

    const recreated = await ctx.app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: auth,
      payload: { name: 'Beatriz Lima', document: CPF, email: 'nova@example.com' },
    });
    assert.equal(recreated.statusCode, 201);
    const revived = (recreated.json() as { customer: { id: string; name: string; archivedAt: string | null } }).customer;
    assert.equal(revived.id, customerId);
    assert.equal(revived.name, 'Beatriz Lima');
    assert.equal(revived.archivedAt, null);
  } finally {
    await ctx.app.close();
    closeDb(ctx.db);
  }
});
