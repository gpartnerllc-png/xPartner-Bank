import type { Db } from '../kernel/db.ts';
import { nowIso } from '../kernel/db.ts';
import { AppError } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import type { Cents } from '../kernel/money.ts';
import { assertCents } from '../kernel/money.ts';

export type OwnerType = 'PLATFORM' | 'MERCHANT';
export type AccountKind =
  | 'ACQUIRER_RECEIVABLE'
  | 'MERCHANT_PAYABLE'
  | 'MERCHANT_AVAILABLE'
  | 'FEE_REVENUE'
  | 'ANTICIPATION_REVENUE'
  | 'CASH'
  | 'TOKEN_RESERVE'
  | 'TOKEN_LIABILITY'
  | 'ROYALTY_PAYABLE'
  | 'DEPIN_REWARD_EXPENSE'
  | 'OPEN_FINANCE_CLEARING'
  | 'INVESTMENT_PRINCIPAL'
  | 'INVESTMENT_INCOME'
  | 'TAX_PAYABLE';

export const PLATFORM_OWNER_ID = 'platform';

const PLATFORM_KINDS: AccountKind[] = [
  'ACQUIRER_RECEIVABLE',
  'FEE_REVENUE',
  'ANTICIPATION_REVENUE',
  'CASH',
  'TOKEN_RESERVE',
  'TOKEN_LIABILITY',
  'DEPIN_REWARD_EXPENSE',
  'OPEN_FINANCE_CLEARING',
  'INVESTMENT_INCOME',
  'TAX_PAYABLE',
];

export interface EntryInput {
  kind: AccountKind;
  ownerType?: OwnerType;
  ownerId?: string;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: Cents;
  memo?: string;
}

export interface AccountBalance {
  accountId: string;
  ownerType: OwnerType;
  ownerId: string;
  kind: AccountKind;
  debitCents: Cents;
  creditCents: Cents;
  balanceCents: Cents;
}

function resolveOwner(entry: EntryInput): { ownerType: OwnerType; ownerId: string } {
  if (PLATFORM_KINDS.includes(entry.kind)) {
    return { ownerType: 'PLATFORM', ownerId: PLATFORM_OWNER_ID };
  }
  if (entry.ownerType !== 'MERCHANT' || !entry.ownerId) {
    throw new AppError('LEDGER_OWNER_REQUIRED', `Conta ${entry.kind} exige proprietário MERCHANT.`, 500);
  }
  return { ownerType: 'MERCHANT', ownerId: entry.ownerId };
}

function accountIdFor(db: Db, ownerType: OwnerType, ownerId: string, kind: AccountKind): string {
  const existing = db
    .prepare('SELECT id FROM accounts WHERE owner_type = ? AND owner_id = ? AND kind = ? AND currency = ?')
    .get(ownerType, ownerId, kind, 'BRL') as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId('acc');
  db.prepare(
    'INSERT INTO accounts (id, owner_type, owner_id, kind, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, ownerType, ownerId, kind, 'BRL', nowIso());
  return id;
}

export interface GroupInput {
  groupId: string;
  groupKind: string;
  transactionId?: string;
  createdAt?: string;
  entries: EntryInput[];
}

/**
 * Lançamento contábil de dupla entrada. Rejeita grupos desbalanceados antes de qualquer escrita
 * e grava tudo na transação SQL do chamador.
 */
export function postGroup(db: Db, input: GroupInput): void {
  if (input.entries.length < 2) {
    throw new AppError('LEDGER_UNBALANCED', 'Lançamento exige ao menos dois partidas.', 500);
  }
  let debits = 0;
  let credits = 0;
  for (const entry of input.entries) {
    const amount = assertCents(entry.amountCents);
    if (amount <= 0) throw new AppError('LEDGER_INVALID_AMOUNT', 'Partida deve ser positiva.', 500);
    if (entry.direction === 'DEBIT') debits += amount;
    else credits += amount;
  }
  if (debits !== credits) {
    throw new AppError('LEDGER_UNBALANCED', `Lançamento desbalanceado: D ${debits} ≠ C ${credits}.`, 500);
  }

  const createdAt = input.createdAt ?? nowIso();
  const insert = db.prepare(
    `INSERT INTO ledger_entries
       (id, entry_group, group_kind, transaction_id, account_id, direction, amount_cents, currency, memo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'BRL', ?, ?)`,
  );
  for (const entry of input.entries) {
    const owner = resolveOwner(entry);
    const accountId = accountIdFor(db, owner.ownerType, owner.ownerId, entry.kind);
    insert.run(
      newId('le'),
      input.groupId,
      input.groupKind,
      input.transactionId ?? null,
      accountId,
      entry.direction,
      assertCents(entry.amountCents),
      entry.memo ?? null,
      createdAt,
    );
  }
}

export function listBalances(db: Db, filter?: { ownerType?: OwnerType; ownerId?: string }): AccountBalance[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter?.ownerType) {
    clauses.push('a.owner_type = ?');
    params.push(filter.ownerType);
  }
  if (filter?.ownerId) {
    clauses.push('a.owner_id = ?');
    params.push(filter.ownerId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT a.id AS accountId, a.owner_type AS ownerType, a.owner_id AS ownerId, a.kind,
              COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount_cents END), 0) AS debitCents,
              COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_cents END), 0) AS creditCents
         FROM accounts a
         LEFT JOIN ledger_entries e ON e.account_id = a.id
         ${where}
        GROUP BY a.id
        ORDER BY a.kind, a.owner_id`,
    )
    .all(...params) as Array<{
    accountId: string;
    ownerType: OwnerType;
    ownerId: string;
    kind: AccountKind;
    debitCents: number;
    creditCents: number;
  }>;
  return rows.map((row) => ({ ...row, balanceCents: row.debitCents - row.creditCents }));
}

export function merchantSummary(
  db: Db,
  merchantId: string,
): { availableCents: Cents; receivableCents: Cents; platformFeeCents: Cents } {
  const rows = listBalances(db, { ownerType: 'MERCHANT', ownerId: merchantId });
  const available = rows.find((row) => row.kind === 'MERCHANT_AVAILABLE');
  const receivable = rows.find((row) => row.kind === 'MERCHANT_PAYABLE');
  const fee = db
    .prepare(
      `SELECT COALESCE(SUM(e.amount_cents), 0) AS fees
         FROM ledger_entries e
         JOIN accounts a ON a.id = e.account_id
        WHERE a.kind = 'FEE_REVENUE' AND e.direction = 'CREDIT'`,
    )
    .get() as { fees: number };
  return {
    availableCents: available ? available.creditCents - available.debitCents : 0,
    receivableCents: receivable ? receivable.creditCents - receivable.debitCents : 0,
    platformFeeCents: fee.fees,
  };
}

export function trialBalance(db: Db): { debitCents: number; creditCents: number; balanced: boolean } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents END), 0) AS debitCents,
              COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents END), 0) AS creditCents
         FROM ledger_entries`,
    )
    .get() as { debitCents: number; creditCents: number };
  return { ...row, balanced: row.debitCents === row.creditCents };
}

export function merchantAccountKindLabel(kind: AccountKind): string {
  const labels: Record<AccountKind, string> = {
    ACQUIRER_RECEIVABLE: 'A receber das adquirentes',
    MERCHANT_PAYABLE: 'A receber do lojista',
    MERCHANT_AVAILABLE: 'Saldo disponível do lojista',
    FEE_REVENUE: 'Receita de MDR',
    ANTICIPATION_REVENUE: 'Receita de antecipação',
    CASH: 'Caixa / liquidação',
    TOKEN_RESERVE: 'Lastro de ativos tokenizados',
    TOKEN_LIABILITY: 'Passivo de tokens emitidos',
    ROYALTY_PAYABLE: 'Royalties a pagar',
    DEPIN_REWARD_EXPENSE: 'Despesa de recompensa DePIN',
    OPEN_FINANCE_CLEARING: 'Liquidação de pagamentos via Open Finance',
    INVESTMENT_PRINCIPAL: 'Principal investido do lojista',
    INVESTMENT_INCOME: 'Rendimentos e proventos de investimentos',
    TAX_PAYABLE: 'Impostos retidos a recolher',
  };
  return labels[kind];
}
