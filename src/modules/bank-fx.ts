import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { sha256Hex } from '../kernel/crypto.ts';
import { assertCents, type Cents } from '../kernel/money.ts';
import { TREASURY_USER_ID } from './bank.ts';

/**
 * Livro de moeda estrangeira do laboratório. É separado do ledger BRL: aqui não
 * há câmbio, remessa internacional nem custódia externa, apenas saldo demo com
 * duas partidas por transferência e lastro na carteira da tesouraria.
 */
export const FX_TREASURY_WALLET_ID = 'bank_fx_system_usd';
export const FX_TREASURY_OPENING_CENTS = 10_000_000_000_000; // US$ 100.000.000.000,00 de capital demo
export const FX_MAX_CENTS = 2_000_000_000_000; // US$ 20.000.000.000,00 por operação
export const FX_SUPPORTED = new Set(['USD']);

const formatters = new Map<string, Intl.NumberFormat>();
function fxFormatter(currency: string): Intl.NumberFormat {
  const key = currency.toUpperCase();
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: key });
    formatters.set(key, formatter);
  }
  return formatter;
}

export function formatFx(amount: Cents, currency: string): string {
  return fxFormatter(currency).format(assertCents(amount) / 100);
}

export interface FxWalletRow {
  id: string;
  user_id: string;
  currency: string;
  status: 'ACTIVE' | 'BLOCKED';
  balance_cents: number;
  opening_balance_cents: number;
  created_at: string;
  updated_at: string;
}

export interface FxWalletView {
  id: string;
  currency: string;
  status: string;
  balanceCents: Cents;
  balanceFormatted: string;
  openingBalanceCents: Cents;
  createdAt: string;
  updatedAt: string;
}

export interface FxTransferView {
  id: string;
  currency: string;
  kind: string;
  status: string;
  direction: 'IN' | 'OUT';
  amountCents: Cents;
  amountFormatted: string;
  memo: string;
  counterpartyName: string;
  createdAt: string;
  balanceAfterCents?: Cents;
  balanceAfterFormatted?: string;
}

export interface FxStatementEntry extends FxTransferView {
  balanceAfterCents: Cents;
  balanceAfterFormatted: string;
}

interface FxTransferRow {
  id: string;
  currency: string;
  kind: string;
  debit_wallet_id: string;
  credit_wallet_id: string;
  amount_cents: number;
  memo: string | null;
  status: 'POSTED' | 'REVERSED';
  idempotency_key: string | null;
  request_hash: string | null;
  initiator_id: string;
  created_at: string;
}

function walletView(row: FxWalletRow): FxWalletView {
  return {
    id: row.id,
    currency: row.currency,
    status: row.status,
    balanceCents: row.balance_cents,
    balanceFormatted: formatFx(row.balance_cents, row.currency),
    openingBalanceCents: row.opening_balance_cents,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function transferView(row: FxTransferRow, direction: 'IN' | 'OUT', counterpartyName: string, balanceAfter?: number): FxTransferView {
  return {
    id: row.id,
    currency: row.currency,
    kind: row.kind,
    status: row.status,
    direction,
    amountCents: row.amount_cents,
    amountFormatted: formatFx(row.amount_cents, row.currency),
    memo: row.memo ?? '',
    counterpartyName,
    createdAt: row.created_at,
    balanceAfterCents: balanceAfter,
    balanceAfterFormatted: balanceAfter === undefined ? undefined : formatFx(balanceAfter, row.currency),
  };
}

function normalizeMemo(input: string | undefined): string {
  const value = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!value) return 'Aporte internacional demo';
  if (value.length > 120) throw Errors.validation('Descrição excede 120 caracteres.');
  return value;
}

export function ensureFxTreasury(db: Db, now = Date.now()): void {
  const timestamp = nowIso(now);
  db.prepare(
    `INSERT OR IGNORE INTO bank_fx_wallets
       (id, user_id, currency, status, balance_cents, opening_balance_cents, created_at, updated_at)
     VALUES (?, ?, 'USD', 'ACTIVE', ?, ?, ?, ?)`,
  ).run(FX_TREASURY_WALLET_ID, TREASURY_USER_ID, FX_TREASURY_OPENING_CENTS, FX_TREASURY_OPENING_CENTS, timestamp, timestamp);
  const current = db
    .prepare('SELECT opening_balance_cents FROM bank_fx_wallets WHERE id = ?')
    .get(FX_TREASURY_WALLET_ID) as { opening_balance_cents: number } | undefined;
  if (!current || current.opening_balance_cents >= FX_TREASURY_OPENING_CENTS) return;
  const delta = FX_TREASURY_OPENING_CENTS - current.opening_balance_cents;
  db.prepare(
    `UPDATE bank_fx_wallets
        SET balance_cents = balance_cents + ?, opening_balance_cents = opening_balance_cents + ?, updated_at = ?
      WHERE id = ?`,
  ).run(delta, delta, timestamp, FX_TREASURY_WALLET_ID);
  audit(db, TREASURY_USER_ID, 'bank.fx.treasury.capital', `bank_fx_wallet:${FX_TREASURY_WALLET_ID}`, {
    addedCents: delta,
    openingCents: FX_TREASURY_OPENING_CENTS,
  });
}

function ensureWallet(db: Db, userId: string, currency: string, now: number): FxWalletRow {
  const existing = db
    .prepare('SELECT * FROM bank_fx_wallets WHERE user_id = ? AND currency = ?')
    .get(userId, currency) as unknown as FxWalletRow | undefined;
  if (existing) return existing;
  const timestamp = nowIso(now);
  const id = newId('fxw', now);
  db.prepare(
    `INSERT INTO bank_fx_wallets
       (id, user_id, currency, status, balance_cents, opening_balance_cents, created_at, updated_at)
     VALUES (?, ?, ?, 'ACTIVE', 0, 0, ?, ?)`,
  ).run(id, userId, currency, timestamp, timestamp);
  return db.prepare('SELECT * FROM bank_fx_wallets WHERE id = ?').get(id) as unknown as FxWalletRow;
}

export class BankFxService {
  private readonly db: Db;
  private readonly config: AppConfig;

  constructor(db: Db, config: AppConfig) {
    this.db = db;
    this.config = config;
  }

  wallets(userId: string): { wallets: FxWalletView[] } {
    const rows = this.db
      .prepare('SELECT * FROM bank_fx_wallets WHERE user_id = ? ORDER BY currency')
      .all(userId) as unknown as FxWalletRow[];
    return { wallets: rows.map(walletView) };
  }

  systemOverview(): {
    custodyCents: Cents;
    custodyFormatted: string;
    wallets: number;
    treasuryCents: Cents;
    treasuryFormatted: string;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN user_id <> ? THEN balance_cents ELSE 0 END), 0) AS custody,
                COALESCE(SUM(CASE WHEN user_id = ? THEN balance_cents ELSE 0 END), 0) AS treasury,
                COALESCE(SUM(CASE WHEN user_id <> ? AND balance_cents > 0 THEN 1 ELSE 0 END), 0) AS wallets
           FROM bank_fx_wallets`,
      )
      .get(TREASURY_USER_ID, TREASURY_USER_ID, TREASURY_USER_ID) as {
      custody: number;
      treasury: number;
      wallets: number;
    };
    return {
      custodyCents: row.custody,
      custodyFormatted: formatFx(row.custody, 'USD'),
      wallets: row.wallets,
      treasuryCents: row.treasury,
      treasuryFormatted: formatFx(row.treasury, 'USD'),
    };
  }

  statement(userId: string, currency: string, limit = 50): {
    currency: string;
    wallet: FxWalletView;
    entries: FxStatementEntry[];
  } {
    const code = String(currency ?? 'USD').toUpperCase();
    if (!FX_SUPPORTED.has(code)) throw Errors.validation('Moeda internacional não habilitada nesta versão.');
    const wallet = this.db
      .prepare('SELECT * FROM bank_fx_wallets WHERE user_id = ? AND currency = ?')
      .get(userId, code) as unknown as FxWalletRow | undefined;
    if (!wallet) {
      return {
        currency: code,
        wallet: {
          id: '',
          currency: code,
          status: 'ACTIVE',
          balanceCents: 0,
          balanceFormatted: formatFx(0, code),
          openingBalanceCents: 0,
          createdAt: nowIso(Date.now()),
          updatedAt: nowIso(Date.now()),
        },
        entries: [],
      };
    }
    const safeLimit = Math.min(500, Math.max(1, limit));
    const rows = this.db
      .prepare(
        `SELECT e.direction, e.amount_cents, e.balance_after_cents, e.created_at AS entry_created_at,
                t.id, t.currency, t.kind, t.debit_wallet_id, t.credit_wallet_id, t.amount_cents AS transfer_amount,
                t.memo, t.status, t.idempotency_key, t.request_hash, t.initiator_id, t.created_at,
                cu.name AS counterparty_name
           FROM bank_fx_entries e
           JOIN bank_fx_transfers t ON t.id = e.transfer_id
           JOIN bank_fx_wallets cw
             ON cw.id = CASE WHEN e.direction = 'DEBIT' THEN t.credit_wallet_id ELSE t.debit_wallet_id END
           JOIN bank_users cu ON cu.id = cw.user_id
          WHERE e.wallet_id = ?
          ORDER BY e.created_at DESC
          LIMIT ?`,
      )
      .all(wallet.id, safeLimit) as unknown as Array<
      FxTransferRow & {
        direction: 'DEBIT' | 'CREDIT';
        balance_after_cents: number;
        counterparty_name: string;
      }
    >;
    return {
      currency: code,
      wallet: walletView(wallet),
      entries: rows.map((row) => ({
        ...transferView(row, row.direction === 'DEBIT' ? 'OUT' : 'IN', row.counterparty_name, row.balance_after_cents),
        balanceAfterCents: row.balance_after_cents,
        balanceAfterFormatted: formatFx(row.balance_after_cents, row.currency),
      })),
    };
  }

  /** Aporte internacional de laboratório: tesouraria USD → carteira do titular. */
  fund(input: {
    actorUserId: string;
    targetUserId: string;
    currency?: string;
    amountCents: number;
    memo?: string;
    idempotencyKey?: string;
    now?: number;
  }): { transfer: FxTransferView; wallet: FxWalletView; replayed: boolean } {
    if (!this.config.demoMode) {
      throw new AppError('DEMO_ONLY', 'Carteira internacional demo disponível apenas em ambiente demo.', 403);
    }
    const currency = String(input.currency ?? 'USD').toUpperCase();
    if (!FX_SUPPORTED.has(currency)) {
      throw Errors.validation('Moeda internacional não habilitada nesta versão.');
    }
    const amount = assertCents(input.amountCents);
    if (amount <= 0) throw Errors.validation('amountCents deve ser maior que zero.');
    if (amount > FX_MAX_CENTS) {
      throw Errors.validation(`Aporte internacional limitado a ${formatFx(FX_MAX_CENTS, currency)} por operação.`);
    }
    const now = input.now ?? Date.now();
    const timestamp = nowIso(now);
    const memo = normalizeMemo(input.memo);
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 120)) {
      throw Errors.validation('Idempotency-Key deve ter entre 8 e 120 caracteres.');
    }
    const fingerprint = sha256Hex(`${currency}|${input.targetUserId}|${amount}|${memo}`);

    return tx(this.db, () => {
      if (idempotencyKey) {
        const existing = this.db
          .prepare('SELECT * FROM bank_fx_transfers WHERE initiator_id = ? AND idempotency_key = ?')
          .get(input.actorUserId, idempotencyKey) as unknown as FxTransferRow | undefined;
        if (existing) {
          if (existing.request_hash !== fingerprint) {
            throw Errors.conflict('Idempotency-Key reutilizada com payload diferente.');
          }
          const wallet = this.db
            .prepare('SELECT * FROM bank_fx_wallets WHERE id = ?')
            .get(existing.credit_wallet_id) as unknown as FxWalletRow;
          return {
            transfer: transferView(existing, 'IN', 'Tesouraria internacional (demo)'),
            wallet: walletView(wallet),
            replayed: true,
          };
        }
      }

      const target = this.db
        .prepare("SELECT id, name, status FROM bank_users WHERE id = ? AND status = 'ACTIVE'")
        .get(input.targetUserId) as { id: string; name: string; status: string } | undefined;
      if (!target) throw Errors.notFound('Titular ativo não encontrado para a carteira internacional.');

      ensureFxTreasury(this.db, now);
      const treasury = this.db
        .prepare('SELECT * FROM bank_fx_wallets WHERE id = ?')
        .get(FX_TREASURY_WALLET_ID) as unknown as FxWalletRow;
      const wallet = ensureWallet(this.db, input.targetUserId, currency, now);

      const debit = this.db
        .prepare(
          `UPDATE bank_fx_wallets SET balance_cents = balance_cents - ?, updated_at = ?
            WHERE id = ? AND balance_cents >= ?`,
        )
        .run(amount, timestamp, treasury.id, amount);
      if (debit.changes !== 1) {
        throw new AppError('FX_TREASURY_EMPTY', 'Tesouraria internacional sem saldo para este aporte.', 409);
      }
      this.db
        .prepare('UPDATE bank_fx_wallets SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?')
        .run(amount, timestamp, wallet.id);

      const id = newId('fxt', now);
      this.db
        .prepare(
          `INSERT INTO bank_fx_transfers
             (id, currency, kind, debit_wallet_id, credit_wallet_id, amount_cents, memo, status,
              idempotency_key, request_hash, initiator_id, created_at)
           VALUES (?, ?, 'CAPITAL', ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?)`,
        )
        .run(id, currency, treasury.id, wallet.id, amount, memo, idempotencyKey ?? null, idempotencyKey ? fingerprint : null, input.actorUserId, timestamp);

      const creditAfter = wallet.balance_cents + amount;
      const treasuryAfter = treasury.balance_cents - amount;
      const insertEntry = this.db.prepare(
        `INSERT INTO bank_fx_entries
           (id, transfer_id, wallet_id, direction, amount_cents, balance_after_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insertEntry.run(newId('fxe', now), id, treasury.id, 'DEBIT', amount, treasuryAfter, timestamp);
      insertEntry.run(newId('fxe', now), id, wallet.id, 'CREDIT', amount, creditAfter, timestamp);

      enqueueEvent(this.db, {
        topic: 'bank.fx',
        type: 'bank.fx.funded',
        key: input.targetUserId,
        payload: {
          transferId: id,
          currency,
          amountCents: amount,
          userId: input.targetUserId,
          actorUserId: input.actorUserId,
          createdAt: timestamp,
        },
      });
      audit(this.db, input.actorUserId, 'bank.fx.funded', `bank_fx_transfer:${id}`, {
        currency,
        amountCents: amount,
        targetUserId: input.targetUserId,
      });

      const created = this.db.prepare('SELECT * FROM bank_fx_transfers WHERE id = ?').get(id) as unknown as FxTransferRow;
      return {
        transfer: transferView(created, 'IN', 'Tesouraria internacional (demo)', creditAfter),
        wallet: walletView({ ...wallet, balance_cents: creditAfter }),
        replayed: false,
      };
    });
  }
}
