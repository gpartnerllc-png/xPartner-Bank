/**
 * Ajusta saldos de demonstração com lastro contábil.
 *
 *   npm run demo:balance -- --document 34259998854 --brl 2000000000 --usd 3000000000
 *
 * BRL entra na conta corrente via conta de capital (channel CAPITAL).
 * USD entra na carteira internacional a partir da tesouraria USD.
 * O script só credita a diferença até o alvo; rodar de novo sem saldo alterado
 * é no-op. Não reduz saldo e não funciona fora do modo demo.
 */
import { loadConfig } from '../src/config.ts';
import { closeDb, migrate, openDb } from '../src/kernel/db.ts';
import { ledgerTrialBalance, BankService, ensureCapital, ensureTreasury } from '../src/modules/bank.ts';
import { BankFxService, ensureFxTreasury, formatFx } from '../src/modules/bank-fx.ts';
import { formatBRL, parseBRLToCents } from '../src/kernel/money.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dbPath = arg('db') ?? process.env.DB_PATH ?? '.data/xpartner.db';
const document = (arg('document') ?? '').replace(/\D/g, '');
const email = (arg('email') ?? '').trim().toLowerCase();
const userId = arg('user-id');
const brlTargetRaw = arg('brl');
const usdTargetRaw = arg('usd');

if (!document && !email && !userId) {
  console.error('Informe --document, --email ou --user-id.');
  process.exit(1);
}
if (!brlTargetRaw && !usdTargetRaw) {
  console.error('Informe ao menos --brl e/ou --usd com o saldo-alvo.');
  process.exit(1);
}

const config = loadConfig({ ...process.env, DB_PATH: dbPath, SEED_DEMO: 'false' });
if (config.isProduction || !config.demoMode) {
  console.error('Este script só opera em ambiente demo (NODE_ENV diferente de production e DEMO_MODE=true).');
  process.exit(1);
}

const db = openDb(dbPath);
try {
  migrate(db);
  ensureTreasury(db);
  ensureCapital(db);
  ensureFxTreasury(db);

  const target = db
    .prepare(
      `SELECT u.id, u.name, u.document, u.status, u.role
         FROM bank_users u
        WHERE u.role <> 'SYSTEM'
          AND (u.id = ? OR u.document = ? OR lower(u.email) = ?)
        LIMIT 1`,
    )
    .get(userId ?? '', document || '-', email || '-') as
    | { id: string; name: string; document: string; status: string; role: string }
    | undefined;
  if (!target) {
    console.error('Titular não encontrado.');
    process.exit(1);
  }
  if (target.status !== 'ACTIVE') {
    console.error(`Titular ${target.name} está ${target.status}; ative antes de creditar.`);
    process.exit(1);
  }

  const admin = db
    .prepare("SELECT id FROM bank_users WHERE role = 'ADMIN' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  if (!admin) {
    console.error('Nenhum administrador ativo para assinar o aporte.');
    process.exit(1);
  }

  const bank = new BankService(db, config);
  const fx = new BankFxService(db, config);
  const account = db
    .prepare('SELECT id, balance_cents FROM bank_accounts WHERE user_id = ?')
    .get(target.id) as { id: string; balance_cents: number } | undefined;
  if (!account) {
    console.error('Titular sem conta corrente.');
    process.exit(1);
  }

  if (brlTargetRaw) {
    const targetCents = parseBRLToCents(brlTargetRaw);
    const delta = targetCents - account.balance_cents;
    if (delta < 0) {
      console.error(
        `Saldo BRL atual (${formatBRL(account.balance_cents)}) já supera o alvo (${formatBRL(targetCents)}); este script não debita.`,
      );
      process.exit(1);
    }
    if (delta === 0) {
      console.log(`BRL já está em ${formatBRL(account.balance_cents)}.`);
    } else {
      const result = bank.demoCapital({
        actorUserId: admin.id,
        targetUserId: target.id,
        amountCents: delta,
        description: 'Aporte de capital de laboratório (demo)',
      });
      console.log(`BRL creditado: ${formatBRL(delta)} → saldo ${result.account.balanceFormatted}.`);
    }
  }

  if (usdTargetRaw) {
    const targetCents = parseBRLToCents(usdTargetRaw);
    const wallet = fx.wallets(target.id).wallets.find((item) => item.currency === 'USD');
    const current = wallet ? wallet.balanceCents : 0;
    const delta = targetCents - current;
    if (delta < 0) {
      console.error(
        `Saldo USD atual (${formatFx(current, 'USD')}) já supera o alvo (${formatFx(targetCents, 'USD')}); este script não debita.`,
      );
      process.exit(1);
    }
    if (delta === 0) {
      console.log(`USD já está em ${formatFx(current, 'USD')}.`);
    } else {
      const result = fx.fund({
        actorUserId: admin.id,
        targetUserId: target.id,
        currency: 'USD',
        amountCents: delta,
        memo: 'Capital internacional de laboratório (demo)',
      });
      console.log(`USD creditado: ${formatFx(delta, 'USD')} → saldo ${result.wallet.balanceFormatted}.`);
    }
  }

  const ledger = ledgerTrialBalance(db);
  console.log(
    `Titular: ${target.name} · ${target.document} · conta ${account.id} · ledger ${ledger.balanced ? 'balanceado' : 'DIVERGENTE'}.`,
  );
  if (!ledger.balanced) process.exitCode = 1;
} finally {
  closeDb(db);
}
