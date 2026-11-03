import { loadConfig } from '../src/config.ts';
import type { AppConfig } from '../src/config.ts';
import { migrate } from '../src/kernel/db.ts';
import { openDb } from '../src/kernel/db-node.ts';
import type { Db } from '../src/kernel/db.ts';
import { seedCore } from '../src/modules/seed.ts';
import {
  DEMO_CAPITAL_ACCOUNT_ID,
  TREASURY_ACCOUNT_ID,
  ensureCapital,
  ensureTreasury,
} from '../src/modules/bank.ts';
import { FX_TREASURY_WALLET_ID, ensureFxTreasury } from '../src/modules/bank-fx.ts';

const TEST_MASTER_KEY = 'test-master-key-0123456789abcdefghij';

/**
 * Lastro das contas de sistema usado só nos testes. A rede não nasce mais com
 * saldo de demonstração — o saldo aparece quando alguém lança —, então os
 * cenários que precisam de tesouraria simulam aqui o aporte do acionista.
 */
export const TEST_TREASURY_CENTS = 10_000_000_000; // R$ 100.000.000,00
export const TEST_CAPITAL_CENTS = 20_000_000_000_000; // R$ 200.000.000.000,00
export const TEST_FX_TREASURY_CENTS = 10_000_000_000_000; // US$ 100.000.000,00

export function fundSystemAccounts(db: Db): void {
  ensureTreasury(db);
  ensureCapital(db);
  ensureFxTreasury(db);
  db.prepare('UPDATE bank_accounts SET balance_cents = ?, opening_balance_cents = ? WHERE id = ?').run(
    TEST_TREASURY_CENTS,
    TEST_TREASURY_CENTS,
    TREASURY_ACCOUNT_ID,
  );
  db.prepare('UPDATE bank_accounts SET balance_cents = ?, opening_balance_cents = ? WHERE id = ?').run(
    TEST_CAPITAL_CENTS,
    TEST_CAPITAL_CENTS,
    DEMO_CAPITAL_ACCOUNT_ID,
  );
  db.prepare('UPDATE bank_fx_wallets SET balance_cents = ?, opening_balance_cents = ? WHERE id = ?').run(
    TEST_FX_TREASURY_CENTS,
    TEST_FX_TREASURY_CENTS,
    FX_TREASURY_WALLET_ID,
  );
}

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
  fundSystemAccounts(db);
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
