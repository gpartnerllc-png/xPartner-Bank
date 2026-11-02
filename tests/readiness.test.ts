import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReadiness } from '../src/modules/readiness.ts';
import { testConfig } from './helpers.ts';

test('readiness: demo lista bloqueios reais e não vaza segredos', () => {
  const config = testConfig();
  const report = buildReadiness(config, {
    XPARTNER_MASTER_KEY: 'segredo-que-nao-pode-vazar',
    ACQUIRER_CLIENT_SECRET: 'credencial-sigilosa',
    PIX_PSP_CLIENT_SECRET: 'outra-credencial',
  } as NodeJS.ProcessEnv);

  assert.equal(report.demoMode, true);
  assert.equal(report.readyForProduction, false);
  assert.ok(report.progressPct > 0 && report.progressPct < 100);

  const acquiring = report.items.find((item) => item.id === 'pagamentos.adquirencia');
  const compliance = report.items.find((item) => item.id === 'conformidade.licenca');
  const rsfn = report.items.find((item) => item.id === 'pagamentos.rsfn');
  assert.equal(acquiring?.status, 'MISSING');
  assert.equal(compliance?.status, 'MANUAL');
  assert.equal(rsfn?.status, 'PARTIAL');
  assert.ok((rsfn?.needs.length ?? 0) >= 3);
  assert.ok((acquiring?.needs.length ?? 0) >= 4);
  assert.ok(report.blockers.length > 0);

  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('segredo-que-nao-pode-vazar'));
  assert.ok(!serialized.includes('credencial-sigilosa'));
  assert.ok(!serialized.includes('outra-credencial'));
});

test('readiness: produção desliga demo e valida a configuração de execução', () => {
  const config = testConfig({ NODE_ENV: 'production', DEMO_MODE: 'false', SEED_DEMO: 'false' });
  const report = buildReadiness(config, {} as NodeJS.ProcessEnv);
  const runtime = report.items.find((item) => item.id === 'core.runtime');
  const ledger = report.items.find((item) => item.id === 'core.ledger');
  const rsfn = report.items.find((item) => item.id === 'pagamentos.rsfn');
  assert.equal(runtime?.status, 'READY');
  assert.equal(ledger?.status, 'READY');
  assert.equal(rsfn?.status, 'MISSING');
  assert.equal(report.demoMode, false);
});
