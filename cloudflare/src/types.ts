export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  RECEIPTS: R2Bucket;
  EVENTS: Queue<BankEvent>;
  AI: Ai;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  DEMO_MODE?: string;
  APP_ORIGIN?: string;
  SESSION_TTL_SECONDS?: string;
  BOOTSTRAP_TOKEN?: string;
  SESSION_PEPPER?: string;
  RSFN_ISPB?: string;
  MERCHANT: DurableObjectNamespace;
}

export interface BankEvent {
  id: string;
  topic: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface UserRow {
  id: string;
  name: string;
  document: string;
  email: string;
  phone: string | null;
  password_hash: string;
  role: 'USER' | 'ADMIN' | 'SYSTEM';
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'DELETED';
  must_change_password: number;
  failed_attempts: number;
  locked_until: string | null;
  approved_by: string | null;
  approved_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AccountRow {
  id: string;
  user_id: string;
  branch: string;
  number: string;
  kind: 'CHECKING' | 'SYSTEM';
  status: 'ACTIVE' | 'BLOCKED' | 'CLOSED';
  balance_cents: number;
  opening_balance_cents: number;
  per_transfer_limit_cents: number;
  daily_limit_cents: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

export interface TransferRow {
  id: string;
  kind: 'INTERNAL' | 'FUNDING';
  debit_account_id: string;
  credit_account_id: string;
  amount_cents: number;
  description: string | null;
  status: 'POSTED' | 'REVERSED';
  end_to_end_id: string;
  idempotency_key: string | null;
  request_hash: string | null;
  initiator_id: string;
  recipient_name: string;
  channel: string;
  created_at: string;
}

export interface LedgerRow {
  id: string;
  transfer_id: string;
  account_id: string;
  direction: 'DEBIT' | 'CREDIT';
  amount_cents: number;
  balance_after_cents: number;
  created_at: string;
}

export interface RecipientRow {
  user_id: string;
  name: string;
  document: string;
  account_id: string;
  branch: string;
  number: string;
  pix_key_type?: string;
  pix_key_masked?: string;
}

export interface AuthContext {
  user: UserRow;
  account: AccountRow | null;
  session: SessionRow;
  token: string;
  viaCookie: boolean;
}

export interface PublicUser {
  id: string;
  name: string;
  document: string;
  documentMasked: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  mustChangePassword: boolean;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  lastLoginAt: string | null;
  deletedAt: string | null;
  account: AccountView | null;
}

export interface AccountView {
  id: string;
  branch: string;
  number: string;
  numberFormatted: string;
  formattedNumber: string;
  kind: string;
  status: string;
  balanceCents: number;
  balanceFormatted: string;
  openingBalanceCents: number;
  perTransferLimitCents: number;
  dailyLimitCents: number;
  openedAt: string;
  createdAt: string;
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
  balanceCents: number;
  balanceFormatted: string;
  openingBalanceCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface FxTransferRow {
  id: string;
  currency: string;
  kind: string;
  debit_wallet_id: string;
  credit_wallet_id: string;
  amount_cents: number;
  memo: string | null;
  status: string;
  initiator_id: string;
  created_at: string;
}
