import { loadConfig } from '../src/config.ts';
import type { AppConfig } from '../src/config.ts';
import { migrate, openDb } from '../src/kernel/db.ts';
import type { Db } from '../src/kernel/db.ts';
import { seedCore } from '../src/modules/seed.ts';

const TEST_MASTER_KEY = 'test-master-key-0123456789abcdefghij';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    XPARTNER_MASTER_KEY: TEST_MASTER_KEY,
    DEMO_MODE: 'true',
    SEED_DEMO: 'false',
    FISCAL_LATENCY_MS: '0',
    FISCAL_REJECTION_PCT: '0',
    RATE_LIMIT_PER_MINUTE: '1000',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export function testDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  seedCore(db);
  return db;
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor esgotou o tempo limite');
}
