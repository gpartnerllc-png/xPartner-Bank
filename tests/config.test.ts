import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';

test('config: produção exige chave mestra forte', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), /XPARTNER_MASTER_KEY/);
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', XPARTNER_MASTER_KEY: 'curta' } as NodeJS.ProcessEnv),
    /XPARTNER_MASTER_KEY/,
  );
});

test('config: produção proíbe modo demo e liga guardas', () => {
  const validKey = 'k'.repeat(40);
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        XPARTNER_MASTER_KEY: validKey,
        DEMO_MODE: 'true',
      } as NodeJS.ProcessEnv),
    /DEMO_MODE/,
  );

  const config = loadConfig({ NODE_ENV: 'production', XPARTNER_MASTER_KEY: validKey } as NodeJS.ProcessEnv);
  assert.equal(config.isProduction, true);
  assert.equal(config.demoMode, false);
  assert.equal(config.seedDemo, false);
});

test('config: desenvolvimento liga demo mas não semeia dados de vitrine', () => {
  const config = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
  assert.equal(config.demoMode, true);
  assert.equal(config.seedDemo, false);
  assert.ok(config.masterKey.length >= 32);
});

test('config: SEED_DEMO=true continua sendo a única porta da vitrine', () => {
  const config = loadConfig({ NODE_ENV: 'development', SEED_DEMO: 'true' } as NodeJS.ProcessEnv);
  assert.equal(config.seedDemo, true);
});
