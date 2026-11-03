import type { Env } from './types.ts';
import { HttpError } from './http.ts';
import { newId, nowIso, randomToken, sha256Hex } from './security.ts';
import { accountByUser, audit, findUserById, queueEvent } from './repo.ts';
import { endToEndId, formatBRL } from './validation.ts';
import {
  AGRO_ESCROW_HOLDER,
  AI_SOLVER_MODEL,
  ALADDIN_MAX_LOAN_CENTS,
  ALADDIN_MAX_VAR_BPS,
  ALADDIN_MIN_SCORE,
  CCIP_ESCROW_HOLDER,
  actionDigest,
  attestationHash,
  ccipMessageId,
  creditScoreFrom,
  decimalSelector,
  dvpOfferDigest,
  evmAddress,
  intentDigest,
  invalid,
  isoDateOrThrow,
  loanToValueBps,
  maxLoanForScore,
  nullifierFor,
  optInt,
  oracleCentsPerUnit,
  positiveInt,
  requiredText,
  riskDigest,
  sessionKeyHash,
  simulateMonteCarlo,
  solverScore,
  symbol,
  todayEpoch,
} from './web3-domain.ts';

/**
 * Camada Web3 do edge: DVP atômico, oráculo, crédito agro, atestações,
 * ERC-4337/paymaster, risco Aladdin, crédito algorítmico, CCIP e intents.
 *
 * O titular é o usuário bancário autenticado. Valores em centavos circulam pelo
 * ledger de dupla entrada do edge (bank_transfers + trigger), e ativos
 * tokenizados ficam em web3_holdings com escrows explícitos. A prova Groth16
 * real roda no core Node; no edge o crédito Aladdin é liberado por atestação de
 * predicado com nullifier, e isso é declarado nas capacidades públicas.
 */

const SYSTEM_USER_ID = 'bank_user_system';
const NETWORK_KINDS = new Set(['APPCHAIN', 'SUBNET', 'L2', 'L1']);
const ORACLE_SOURCES = new Set(['CHAINLINK', 'BAND', 'XPARTNER']);
const RISK_SOURCES = new Set(['MONTE_CARLO', 'ORACLE_FUSION', 'OPERATOR']);
const RISK_TIERS: Record<string, { eta: number; riskBps: number }> = {
  A: { eta: 15, riskBps: 120 },
  B: { eta: 40, riskBps: 350 },
  C: { eta: 90, riskBps: 800 },
};

type Bind = string | number | null;

interface NetworkRow {
  id: string;
  name: string;
  chain_id: number;
  kind: string;
  rpc_url: string;
  explorer_url: string | null;
  native_symbol: string;
  bridge_contract: string | null;
  token_contract: string | null;
  dvp_contract: string | null;
  paymaster_contract: string | null;
  finality_seconds: number;
  governance: string;
  status: string;
  created_at: string;
}

interface FeedRow {
  symbol: string;
  source: string;
  decimals: number;
  max_age_seconds: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PriceRow {
  id: string;
  symbol: string;
  price_units: number;
  round_id: number;
  source: string;
  published_at: string;
  created_at: string;
}

interface HoldingRow {
  asset_symbol: string;
  holder_id: string;
  units: number;
  updated_at: string;
}

interface OfferRow {
  id: string;
  network_id: string;
  maker_id: string;
  taker_id: string | null;
  kind: string;
  sell_symbol: string;
  sell_units: number;
  buy_symbol: string | null;
  buy_units: number | null;
  cash_cents: number;
  fee_bps: number;
  nonce: string;
  digest: string;
  expires_at: string;
  status: string;
  created_at: string;
  settled_at: string | null;
}

interface TradeRow {
  id: string;
  offer_id: string;
  network_id: string;
  maker_id: string;
  taker_id: string;
  sell_symbol: string;
  sell_units: number;
  buy_symbol: string | null;
  buy_units: number | null;
  cash_cents: number;
  fee_cents: number;
  cash_transfer_id: string | null;
  fee_transfer_id: string | null;
  tx_digest: string;
  anchor_height: number | null;
  created_at: string;
}

interface AgroRow {
  id: string;
  network_id: string;
  holder_id: string;
  collateral_symbol: string;
  collateral_units: number;
  principal_cents: number;
  outstanding_cents: number;
  interest_bps: number;
  ltv_bps: number;
  liquidation_ltv_bps: number;
  oracle_symbol: string;
  status: string;
  disbursement_transfer_id: string | null;
  due_at: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface AttestationRow {
  id: string;
  commitment: string;
  claim_type: string;
  predicate: string;
  threshold: number;
  issuer: string;
  attestation_hash: string;
  expires_at: string;
  holder_id: string;
  status: string;
  created_at: string;
}

interface NullifierRow {
  nullifier: string;
  attestation_id: string;
  purpose: string;
  relying_party: string;
  created_at: string;
}

interface PolicyRow {
  id: string;
  holder_id: string;
  label: string;
  per_action_max_cents: number;
  daily_cap_cents: number;
  allowed_symbols: string;
  status: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  policy_id: string;
  holder_id: string;
  network_id: string;
  agent: string;
  key_hash: string;
  allowed_selectors: string;
  spend_cap_cents: number;
  spent_cents: number;
  expires_at: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

interface BudgetRow {
  id: string;
  holder_id: string;
  network_id: string;
  label: string;
  cap_cents: number;
  spent_cents: number;
  per_op_max_cents: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PaymasterOpRow {
  id: string;
  budget_id: string;
  user_op_hash: string;
  payer_id: string;
  gas_cents: number;
  anchor_height: number | null;
  created_at: string;
}

interface RiskRow {
  id: string;
  holder_id: string;
  var_bps: number;
  volatility_bps: number;
  credit_score: number;
  model: string;
  source: string;
  sample_size: number;
  observed_at: string;
  expires_at: string;
  digest: string;
  created_at: string;
}

interface LoanRow {
  id: string;
  borrower_id: string;
  principal_cents: number;
  outstanding_cents: number;
  interest_bps: number;
  risk_metric_id: string;
  attestation_id: string;
  score: number;
  var_bps: number;
  status: string;
  disbursement_transfer_id: string | null;
  due_at: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  commitment?: string;
}

interface LaneRow {
  id: string;
  name: string;
  source_chain_id: number;
  dest_chain_id: number;
  source_selector: string;
  dest_selector: string;
  router: string;
  receiver: string;
  fee_bps: number;
  max_units: number;
  status: string;
  created_at: string;
}

interface LiquidityRow {
  holder_id: string;
  lane_id: string;
  symbol: string;
  available_units: number;
  rate_bps: number;
  risk_tier: string;
  status: string;
  updated_at: string;
}

interface IntentRow {
  id: string;
  holder_id: string;
  lane_id: string;
  symbol: string;
  amount_units: number;
  min_dest_units: number;
  fee_budget_cents: number;
  status: string;
  selected_quote_id: string | null;
  ai_model: string | null;
  deadline: string;
  digest: string;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

interface QuoteRow {
  id: string;
  intent_id: string;
  solver_id: string;
  provider_holder_id: string;
  dest_units: number;
  fee_cents: number;
  eta_seconds: number;
  risk_bps: number;
  score: number;
  status: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  intent_id: string;
  quote_id: string;
  lane_id: string;
  message_id: string;
  sequence: number;
  sender_id: string;
  receiver: string;
  symbol: string;
  amount_units: number;
  dest_units: number;
  fee_cents: number;
  status: string;
  digest: string;
  created_at: string;
  settled_at: string | null;
}

async function all<T>(env: Env, sql: string, ...binds: Bind[]): Promise<T[]> {
  const result = await env.DB.prepare(sql)
    .bind(...binds)
    .all<T>();
  return result.results;
}

async function one<T>(env: Env, sql: string, ...binds: Bind[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...binds)
    .first<T>();
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function limitOf(value: unknown, fallback = 50): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
}

// ── Views ──────────────────────────────────────────────────────────────────

function networkView(row: NetworkRow) {
  return {
    id: row.id,
    name: row.name,
    chainId: row.chain_id,
    kind: row.kind,
    rpcUrl: row.rpc_url,
    explorerUrl: row.explorer_url,
    nativeSymbol: row.native_symbol,
    contracts: {
      bridge: row.bridge_contract,
      token: row.token_contract,
      dvp: row.dvp_contract,
      paymaster: row.paymaster_contract,
    },
    finalitySeconds: row.finality_seconds,
    governance: row.governance,
    status: row.status,
    createdAt: row.created_at,
  };
}

function feedView(row: FeedRow, latest: PriceRow | null) {
  return {
    symbol: row.symbol,
    source: row.source,
    decimals: row.decimals,
    maxAgeSeconds: row.max_age_seconds,
    status: row.status,
    latest: latest
      ? {
          priceUnits: latest.price_units,
          centsPerUnit: oracleCentsPerUnit(latest.price_units, row.decimals),
          centsPerUnitFormatted: formatBRL(oracleCentsPerUnit(latest.price_units, row.decimals)),
          round: latest.round_id,
          source: latest.source,
          publishedAt: latest.published_at,
        }
      : null,
    updatedAt: row.updated_at,
  };
}

function offerView(row: OfferRow) {
  return {
    id: row.id,
    networkId: row.network_id,
    makerId: row.maker_id,
    takerId: row.taker_id,
    kind: row.kind,
    sellSymbol: row.sell_symbol,
    sellUnits: row.sell_units,
    buySymbol: row.buy_symbol,
    buyUnits: row.buy_units,
    cashCents: row.cash_cents,
    cashFormatted: formatBRL(row.cash_cents),
    feeBps: row.fee_bps,
    nonce: row.nonce,
    digest: row.digest,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function tradeView(row: TradeRow) {
  return {
    id: row.id,
    offerId: row.offer_id,
    networkId: row.network_id,
    makerId: row.maker_id,
    takerId: row.taker_id,
    sellSymbol: row.sell_symbol,
    sellUnits: row.sell_units,
    buySymbol: row.buy_symbol,
    buyUnits: row.buy_units,
    cashCents: row.cash_cents,
    cashFormatted: formatBRL(row.cash_cents),
    feeCents: row.fee_cents,
    feeFormatted: formatBRL(row.fee_cents),
    cashTransferId: row.cash_transfer_id,
    feeTransferId: row.fee_transfer_id,
    txDigest: row.tx_digest,
    anchorHeight: row.anchor_height,
    createdAt: row.created_at,
  };
}

async function agroView(env: Env, row: AgroRow, nowMs = Date.now()) {
  let collateralCents: number | null = null;
  let ltvBps: number | null = null;
  try {
    const price = await readPrice(env, row.oracle_symbol, nowMs);
    collateralCents = row.collateral_units * price.centsPerUnit;
    ltvBps = loanToValueBps(row.outstanding_cents, collateralCents);
  } catch {
    collateralCents = null;
    ltvBps = null;
  }
  return {
    id: row.id,
    networkId: row.network_id,
    holderId: row.holder_id,
    collateralSymbol: row.collateral_symbol,
    collateralUnits: row.collateral_units,
    collateralCents,
    collateralFormatted: collateralCents === null ? null : formatBRL(collateralCents),
    principalCents: row.principal_cents,
    principalFormatted: formatBRL(row.principal_cents),
    outstandingCents: row.outstanding_cents,
    outstandingFormatted: formatBRL(row.outstanding_cents),
    interestBps: row.interest_bps,
    ltvBps: row.ltv_bps,
    liquidationLtvBps: row.liquidation_ltv_bps,
    currentLtvBps: ltvBps,
    liquidatable: ltvBps !== null && ltvBps >= row.liquidation_ltv_bps,
    oracleSymbol: row.oracle_symbol,
    status: row.status,
    dueAt: row.due_at,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

function attestationView(row: AttestationRow, nowMs = Date.now()) {
  return {
    id: row.id,
    commitment: row.commitment,
    claimType: row.claim_type,
    predicate: row.predicate,
    threshold: row.threshold,
    issuer: row.issuer,
    attestationHash: row.attestation_hash,
    expiresAt: row.expires_at,
    holderId: row.holder_id,
    status: row.status,
    active: row.status === 'ACTIVE' && Date.parse(row.expires_at) > nowMs,
    createdAt: row.created_at,
  };
}

function policyView(row: PolicyRow) {
  return {
    id: row.id,
    holderId: row.holder_id,
    label: row.label,
    perActionMaxCents: row.per_action_max_cents,
    perActionMaxFormatted: formatBRL(row.per_action_max_cents),
    dailyCapCents: row.daily_cap_cents,
    dailyCapFormatted: formatBRL(row.daily_cap_cents),
    allowedSymbols: row.allowed_symbols.split(','),
    status: row.status,
    createdAt: row.created_at,
  };
}

function sessionView(row: SessionRow) {
  return {
    id: row.id,
    policyId: row.policy_id,
    holderId: row.holder_id,
    networkId: row.network_id,
    agent: row.agent,
    allowedSelectors: row.allowed_selectors.split(','),
    spendCapCents: row.spend_cap_cents,
    spendCapFormatted: formatBRL(row.spend_cap_cents),
    spentCents: row.spent_cents,
    spentFormatted: formatBRL(row.spent_cents),
    remainingCents: Math.max(0, row.spend_cap_cents - row.spent_cents),
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function budgetView(row: BudgetRow) {
  return {
    id: row.id,
    holderId: row.holder_id,
    networkId: row.network_id,
    label: row.label,
    capCents: row.cap_cents,
    capFormatted: formatBRL(row.cap_cents),
    spentCents: row.spent_cents,
    spentFormatted: formatBRL(row.spent_cents),
    remainingCents: Math.max(0, row.cap_cents - row.spent_cents),
    perOpMaxCents: row.per_op_max_cents,
    perOpMaxFormatted: formatBRL(row.per_op_max_cents),
    status: row.status,
    createdAt: row.created_at,
  };
}

function opView(row: PaymasterOpRow) {
  return {
    id: row.id,
    budgetId: row.budget_id,
    userOpHash: row.user_op_hash,
    payerId: row.payer_id,
    gasCents: row.gas_cents,
    gasFormatted: formatBRL(row.gas_cents),
    anchorHeight: row.anchor_height,
    createdAt: row.created_at,
  };
}

function riskView(row: RiskRow, nowMs = Date.now()) {
  return {
    id: row.id,
    holderId: row.holder_id,
    varBps: row.var_bps,
    varPct: Number((row.var_bps / 100).toFixed(2)),
    volatilityBps: row.volatility_bps,
    volatilityPct: Number((row.volatility_bps / 100).toFixed(2)),
    creditScore: row.credit_score,
    model: row.model,
    source: row.source,
    sampleSize: row.sample_size,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    valid: Date.parse(row.expires_at) > nowMs,
    digest: row.digest,
    createdAt: row.created_at,
  };
}

function loanView(row: LoanRow, nowMs = Date.now()) {
  const repaid = Math.max(0, row.principal_cents + Math.round((row.principal_cents * row.interest_bps) / 10_000) - row.outstanding_cents);
  const total = row.principal_cents + Math.round((row.principal_cents * row.interest_bps) / 10_000);
  return {
    id: row.id,
    borrowerId: row.borrower_id,
    principalCents: row.principal_cents,
    principalFormatted: formatBRL(row.principal_cents),
    outstandingCents: row.outstanding_cents,
    outstandingFormatted: formatBRL(row.outstanding_cents),
    interestBps: row.interest_bps,
    totalCents: total,
    repaidCents: repaid,
    progressPct: total > 0 ? Math.min(100, Math.round((repaid * 100) / total)) : 0,
    riskMetricId: row.risk_metric_id,
    attestationId: row.attestation_id,
    commitment: row.commitment,
    score: row.score,
    varBps: row.var_bps,
    status: row.status,
    dueAt: row.due_at,
    overdue: row.status === 'OPEN' && Date.parse(row.due_at) < nowMs,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

function laneView(row: LaneRow) {
  return {
    id: row.id,
    name: row.name,
    sourceChainId: row.source_chain_id,
    destChainId: row.dest_chain_id,
    sourceSelector: row.source_selector,
    destSelector: row.dest_selector,
    router: row.router,
    receiver: row.receiver,
    feeBps: row.fee_bps,
    maxUnits: row.max_units,
    status: row.status,
    createdAt: row.created_at,
  };
}

function liquidityView(row: LiquidityRow) {
  return {
    holderId: row.holder_id,
    laneId: row.lane_id,
    symbol: row.symbol,
    availableUnits: row.available_units,
    rateBps: row.rate_bps,
    riskTier: row.risk_tier,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function intentView(row: IntentRow) {
  return {
    id: row.id,
    holderId: row.holder_id,
    laneId: row.lane_id,
    symbol: row.symbol,
    amountUnits: row.amount_units,
    minDestUnits: row.min_dest_units,
    feeBudgetCents: row.fee_budget_cents,
    feeBudgetFormatted: formatBRL(row.fee_budget_cents),
    status: row.status,
    selectedQuoteId: row.selected_quote_id,
    aiModel: row.ai_model,
    deadline: row.deadline,
    digest: row.digest,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function quoteView(row: QuoteRow) {
  return {
    id: row.id,
    intentId: row.intent_id,
    solverId: row.solver_id,
    providerHolderId: row.provider_holder_id,
    destUnits: row.dest_units,
    feeCents: row.fee_cents,
    feeFormatted: formatBRL(row.fee_cents),
    etaSeconds: row.eta_seconds,
    riskBps: row.risk_bps,
    score: row.score,
    status: row.status,
    createdAt: row.created_at,
  };
}

function messageView(row: MessageRow) {
  return {
    id: row.id,
    intentId: row.intent_id,
    quoteId: row.quote_id,
    laneId: row.lane_id,
    messageId: row.message_id,
    sequence: row.sequence,
    senderId: row.sender_id,
    receiver: row.receiver,
    symbol: row.symbol,
    amountUnits: row.amount_units,
    destUnits: row.dest_units,
    feeCents: row.fee_cents,
    status: row.status,
    digest: row.digest,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

// ── Infra interna ─────────────────────────────────────────────────────────

async function anchor(
  env: Env,
  action: string,
  resource: string,
  resourceId: string,
  payload: Record<string, unknown>,
): Promise<{ height: number; hash: string }> {
  const payloadHash = await sha256Hex(JSON.stringify(payload));
  const prev = await one<{ height: number; hash: string }>(
    env,
    'SELECT height, hash FROM edge_anchor_chain ORDER BY height DESC LIMIT 1',
  );
  const height = (prev?.height ?? 0) + 1;
  const hash = await sha256Hex(`${height}|${prev?.hash ?? 'GENESIS'}|${payloadHash}`);
  await env.DB.prepare(
    'INSERT INTO edge_anchor_chain (height, hash, prev_hash, payload_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(height, hash, prev?.hash ?? 'GENESIS', payloadHash, nowIso())
    .run();
  await audit(env, {
    actorId: null,
    action,
    resource,
    resourceId,
    details: { anchorHeight: height, payloadHash },
  });
  return { height, hash };
}

export async function verifyAnchorChainEdge(
  env: Env,
): Promise<{ valid: boolean; height: number; latestHash: string | null; brokenAt: number | null }> {
  const rows = await all<{ height: number; hash: string; prev_hash: string; payload_hash: string }>(
    env,
    'SELECT height, prev_hash, payload_hash, hash FROM edge_anchor_chain ORDER BY height ASC',
  );
  let prevHash = 'GENESIS';
  for (const row of rows) {
    const expected = await sha256Hex(`${row.height}|${prevHash}|${row.payload_hash}`);
    if (row.prev_hash !== prevHash || row.hash !== expected) {
      return { valid: false, height: rows.length, latestHash: prevHash === 'GENESIS' ? null : prevHash, brokenAt: row.height };
    }
    prevHash = row.hash;
  }
  return { valid: true, height: rows.length, latestHash: rows.length ? prevHash : null, brokenAt: null };
}

export async function anchorSummary(env: Env): Promise<{ height: number; latestHash: string | null }> {
  const row = await one<{ height: number; hash: string }>(
    env,
    'SELECT height, hash FROM edge_anchor_chain ORDER BY height DESC LIMIT 1',
  );
  return { height: row?.height ?? 0, latestHash: row?.hash ?? null };
}

async function cashStatement(
  env: Env,
  fromUserId: string,
  toUserId: string,
  amountCents: number,
  description: string,
  now: string,
): Promise<{ id: string; stmt: D1PreparedStatement } | null> {
  if (amountCents <= 0 || fromUserId === toUserId) return null;
  const debit = await accountByUser(env, fromUserId);
  const credit = await accountByUser(env, toUserId);
  if (!debit || !credit) throw new HttpError(422, 'ACCOUNT_MISSING', 'Conta de origem/destino ausente no ledger.');
  const recipient = await findUserById(env, toUserId);
  const id = newId('trf');
  const stmt = env.DB.prepare(
    `INSERT INTO bank_transfers
       (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
        end_to_end_id, initiator_id, recipient_name, created_at)
     VALUES (?, 'INTERNAL', ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?)`,
  ).bind(
    id,
    debit.id,
    credit.id,
    amountCents,
    description.slice(0, 120),
    endToEndId(),
    fromUserId,
    recipient?.name ?? 'Tesouraria xPartner',
    now,
  );
  return { id, stmt };
}

function debitUnitsStmt(env: Env, asset: string, holder: string, units: number, now: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE web3_holdings SET units = units - ?, updated_at = ? WHERE asset_symbol = ? AND holder_id = ?`,
  ).bind(units, now, asset, holder);
}

function creditUnitsStmt(env: Env, asset: string, holder: string, units: number, now: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO web3_holdings (asset_symbol, holder_id, units, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(asset_symbol, holder_id) DO UPDATE
       SET units = units + excluded.units, updated_at = excluded.updated_at`,
  ).bind(asset, holder, units, now);
}

async function holdingUnits(env: Env, asset: string, holder: string): Promise<number> {
  const row = await one<{ units: number }>(
    env,
    'SELECT units FROM web3_holdings WHERE asset_symbol = ? AND holder_id = ?',
    asset,
    holder,
  );
  return row?.units ?? 0;
}

async function ensureUnits(env: Env, asset: string, holder: string, units: number, code: string): Promise<void> {
  const balance = await holdingUnits(env, asset, holder);
  if (balance < units) {
    throw new HttpError(422, code, `Saldo insuficiente de ${asset}: ${balance} unidades.`, {
      symbol: asset,
      balance,
      required: units,
    });
  }
}

async function networkRow(env: Env, idOrChainId: string): Promise<NetworkRow> {
  const value = String(idOrChainId ?? '').trim();
  const row =
    /^\d+$/.test(value)
      ? await one<NetworkRow>(env, 'SELECT * FROM web3_networks WHERE chain_id = ?', Number(value))
      : await one<NetworkRow>(env, 'SELECT * FROM web3_networks WHERE id = ?', value);
  if (!row) throw new HttpError(404, 'WEB3_NETWORK_NOT_FOUND', 'Rede Web3 não encontrada.');
  return row;
}

async function feedRow(env: Env, symbolValue: string): Promise<FeedRow> {
  const row = await one<FeedRow>(env, 'SELECT * FROM web3_oracle_feeds WHERE symbol = ?', symbolValue);
  if (!row) throw new HttpError(404, 'ORACLE_FEED_NOT_FOUND', 'Feed de oráculo não encontrado.');
  return row;
}

// ── Seed de demonstração ──────────────────────────────────────────────────

const SEED_NETWORKS = [
  {
    id: 'w3net_consorcio',
    name: 'Consórcio xPartner',
    chainId: 771_001,
    kind: 'APPCHAIN',
    rpcUrl: 'https://rpc.consorcio.xpartner.internal',
    explorerUrl: 'https://explorer.consorcio.xpartner.internal',
    nativeSymbol: 'BRLT',
    bridge: '0x1000000000000000000000000000000000000001',
    token: '0x1000000000000000000000000000000000000002',
    dvp: '0x1000000000000000000000000000000000000003',
    paymaster: '0x1000000000000000000000000000000000000004',
  },
  {
    id: 'w3net_agro',
    name: 'Subnet Agro',
    chainId: 771_002,
    kind: 'SUBNET',
    rpcUrl: 'https://rpc.subnet-agro.xpartner.internal',
    explorerUrl: 'https://explorer.subnet-agro.xpartner.internal',
    nativeSymbol: 'BRLT',
    bridge: '0x1000000000000000000000000000000000000011',
    token: '0x1000000000000000000000000000000000000012',
    dvp: '0x1000000000000000000000000000000000000013',
    paymaster: '0x1000000000000000000000000000000000000014',
  },
] as const;

const SEED_FEEDS = [
  { symbol: 'SOJA', source: 'XPARTNER', decimals: 2, price: 13_500 },
  { symbol: 'NFCR', source: 'XPARTNER', decimals: 2, price: 100_000 },
  { symbol: 'USDX', source: 'XPARTNER', decimals: 2, price: 500 },
] as const;

const SEED_LANE = {
  id: 'ccip_lane_consorcio_agro',
  name: 'Consórcio → Subnet Agro',
  sourceChainId: 771_001,
  destChainId: 771_002,
  sourceSelector: '7710010000000000001',
  destSelector: '7710020000000000002',
  router: '0x1000000000000000000000000000000000000005',
  receiver: '0x1000000000000000000000000000000000000006',
  feeBps: 20,
  maxUnits: 10_000,
} as const;

export async function ensureWeb3Seed(env: Env): Promise<void> {
  const now = nowIso();
  for (const net of SEED_NETWORKS) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO web3_networks
         (id, name, chain_id, kind, rpc_url, explorer_url, native_symbol, bridge_contract, token_contract,
          dvp_contract, paymaster_contract, finality_seconds, governance, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 'XPARTNER_COUNCIL', 'ACTIVE', ?)`,
    )
      .bind(
        net.id,
        net.name,
        net.chainId,
        net.kind,
        net.rpcUrl,
        net.explorerUrl,
        net.nativeSymbol,
        net.bridge,
        net.token,
        net.dvp,
        net.paymaster,
        now,
      )
      .run();
  }

  for (const feed of SEED_FEEDS) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO web3_oracle_feeds
         (symbol, source, decimals, max_age_seconds, status, created_at, updated_at)
       VALUES (?, ?, ?, 2592000, 'ACTIVE', ?, ?)`,
    )
      .bind(feed.symbol, feed.source, feed.decimals, now, now)
      .run();
    const latest = await one<PriceRow>(
      env,
      'SELECT * FROM web3_oracle_prices WHERE symbol = ? ORDER BY round_id DESC LIMIT 1',
      feed.symbol,
    );
    const stale = !latest || Date.now() - Date.parse(latest.published_at) > 10 * 60 * 1000;
    if (stale) {
      const round = (latest?.round_id ?? 0) + 1;
      await env.DB.prepare(
        `INSERT INTO web3_oracle_prices (id, symbol, price_units, round_id, source, published_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(newId('orc'), feed.symbol, feed.price, round, feed.source, now, now)
        .run();
    }
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO ccip_lanes
       (id, name, source_chain_id, dest_chain_id, source_selector, dest_selector, router, receiver,
        fee_bps, max_units, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
  )
    .bind(
      SEED_LANE.id,
      SEED_LANE.name,
      SEED_LANE.sourceChainId,
      SEED_LANE.destChainId,
      SEED_LANE.sourceSelector,
      SEED_LANE.destSelector,
      SEED_LANE.router,
      SEED_LANE.receiver,
      SEED_LANE.feeBps,
      SEED_LANE.maxUnits,
      now,
    )
    .run();

  const systemHolding = await one<HoldingRow>(
    env,
    'SELECT * FROM web3_holdings WHERE asset_symbol = ? AND holder_id = ?',
    'NFCR',
    SYSTEM_USER_ID,
  );
  if (!systemHolding) {
    const stmts = [
      creditUnitsStmt(env, 'NFCR', SYSTEM_USER_ID, 1_000_000, now),
      creditUnitsStmt(env, 'SOJA', SYSTEM_USER_ID, 500_000, now),
      creditUnitsStmt(env, 'USDX', SYSTEM_USER_ID, 1_000_000, now),
    ];
    await env.DB.batch(stmts);
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO ccip_liquidity
       (holder_id, lane_id, symbol, available_units, rate_bps, risk_tier, status, updated_at)
     VALUES (?, ?, 'NFCR', 1000, 25, 'A', 'ACTIVE', ?)`,
  )
    .bind(SYSTEM_USER_ID, SEED_LANE.id, now)
    .run();

  const demoOffer = await one<OfferRow>(env, "SELECT * FROM web3_dvp_offers WHERE nonce = 'seed-dvp-1'");
  if (!demoOffer) {
    const expiresAt = nowIso(30 * 24 * 60 * 60 * 1000);
    const digest = await dvpOfferDigest(
      { chainId: 771_001, verifyingContract: SEED_NETWORKS[0].dvp },
      {
        maker: SYSTEM_USER_ID,
        taker: null,
        sellSymbol: 'NFCR',
        sellUnits: 10,
        buySymbol: null,
        buyUnits: null,
        cashCents: 995_000,
        feeBps: 10,
        nonce: 'seed-dvp-1',
        expiresAt,
      },
    );
    await env.DB.prepare(
      `INSERT INTO web3_dvp_offers
         (id, network_id, maker_id, taker_id, kind, sell_symbol, sell_units, buy_symbol, buy_units,
          cash_cents, fee_bps, nonce, digest, expires_at, status, created_at, settled_at)
       VALUES (?, ?, ?, NULL, 'CASH_FOR_TOKEN', 'NFCR', 10, NULL, NULL, 995000, 10, 'seed-dvp-1', ?, ?,
               'OPEN', ?, NULL)`,
    )
      .bind(newId('dvp'), SEED_NETWORKS[0].id, SYSTEM_USER_ID, digest, expiresAt, now)
      .run();
  }
}

export async function ensureHolder(env: Env, holderId: string): Promise<void> {
  if (!(env.DEMO_MODE === 'true' || env.DEMO_MODE === '1')) return;
  const now = nowIso();
  const hasHoldings = await one<{ count: number }>(
    env,
    'SELECT COUNT(*) AS count FROM web3_holdings WHERE holder_id = ?',
    holderId,
  );
  if (!hasHoldings || hasHoldings.count === 0) {
    await env.DB.batch([
      creditUnitsStmt(env, 'NFCR', holderId, 500, now),
      creditUnitsStmt(env, 'SOJA', holderId, 300, now),
      creditUnitsStmt(env, 'USDX', holderId, 1_000, now),
    ]);
  }

  const policy = await one<PolicyRow>(env, "SELECT * FROM web3_agent_policies WHERE holder_id = ? AND label = 'default'", holderId);
  if (!policy) {
    await env.DB.prepare(
      `INSERT INTO web3_agent_policies
         (id, holder_id, label, per_action_max_cents, daily_cap_cents, allowed_symbols, status, created_at)
       VALUES (?, ?, 'default', 500000, 2000000, 'NFCR,SOJA,USDX', 'ACTIVE', ?)`,
    )
      .bind(newId('agp'), holderId, now)
      .run();
  }

  const budget = await one<BudgetRow>(env, 'SELECT * FROM web3_paymaster_budgets WHERE holder_id = ? LIMIT 1', holderId);
  if (!budget) {
    await env.DB.prepare(
      `INSERT INTO web3_paymaster_budgets
         (id, holder_id, network_id, label, cap_cents, spent_cents, per_op_max_cents, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Patrocínio demo', 50000, 0, 5000, 'ACTIVE', ?, ?)`,
    )
      .bind(newId('pmb'), holderId, SEED_NETWORKS[0].id, now, now)
      .run();
  }

  const attestation = await one<AttestationRow>(
    env,
    "SELECT * FROM web3_zk_attestations WHERE holder_id = ? AND claim_type = 'NET_WORTH' AND status = 'ACTIVE' LIMIT 1",
    holderId,
  );
  if (!attestation) {
    const commitment = (await sha256Hex(`xpartner:demo:commitment:${holderId}`)).slice(0, 40);
    const expiresAt = nowIso(365 * 24 * 60 * 60 * 1000);
    const hash = await attestationHash({
      commitment,
      claimType: 'NET_WORTH',
      predicate: 'GTE',
      threshold: 5_000_000,
      issuer: 'xpartner:issuer:demo',
      expiresAt,
    });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO web3_zk_attestations
         (id, commitment, claim_type, predicate, threshold, issuer, attestation_hash, expires_at, holder_id, status, created_at)
       VALUES (?, ?, 'NET_WORTH', 'GTE', 5000000, 'xpartner:issuer:demo', ?, ?, ?, 'ACTIVE', ?)`,
    )
      .bind(newId('att'), commitment, hash, expiresAt, holderId, now)
      .run();
  }
}

// ── Redes ─────────────────────────────────────────────────────────────────

export async function listNetworks(env: Env, status?: string) {
  const rows = status
    ? await all<NetworkRow>(env, 'SELECT * FROM web3_networks WHERE status = ? ORDER BY created_at ASC', status.toUpperCase())
    : await all<NetworkRow>(env, 'SELECT * FROM web3_networks ORDER BY created_at ASC');
  return { data: rows.map(networkView) };
}

export async function getNetwork(env: Env, idOrChainId: string) {
  return { network: networkView(await networkRow(env, idOrChainId)) };
}

export async function createNetwork(env: Env, actorId: string, input: Record<string, unknown>) {
  const name = requiredText(input.name, 'name', 80);
  const chainId = positiveInt(input.chainId, 'chainId', 2 ** 31 - 1);
  const kind = String(input.kind ?? '').trim().toUpperCase();
  if (!NETWORK_KINDS.has(kind)) throw invalid('WEB3_NETWORK_KIND', 'kind deve ser APPCHAIN, SUBNET, L2 ou L1.');
  const rpcUrl = requiredText(input.rpcUrl, 'rpcUrl', 300);
  if (!/^https?:\/\//.test(rpcUrl)) throw invalid('WEB3_RPC_URL', 'rpcUrl deve ser http(s).');
  const explorerUrl = input.explorerUrl ? requiredText(input.explorerUrl, 'explorerUrl', 300) : null;
  const nativeSymbol = input.nativeSymbol ? symbol(input.nativeSymbol, 'nativeSymbol') : 'BRLT';
  const bridge = input.bridgeContract ? evmAddress(input.bridgeContract, 'bridgeContract') : null;
  const token = input.tokenContract ? evmAddress(input.tokenContract, 'tokenContract') : null;
  const dvp = input.dvpContract ? evmAddress(input.dvpContract, 'dvpContract') : null;
  const paymaster = input.paymasterContract ? evmAddress(input.paymasterContract, 'paymasterContract') : null;
  const finalitySeconds = optInt(input.finalitySeconds, 'finalitySeconds', 1, 86_400, 2);
  const id = newId('w3net');
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO web3_networks
         (id, name, chain_id, kind, rpc_url, explorer_url, native_symbol, bridge_contract, token_contract,
          dvp_contract, paymaster_contract, finality_seconds, governance, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
    )
      .bind(
        id,
        name,
        chainId,
        kind,
        rpcUrl,
        explorerUrl,
        nativeSymbol,
        bridge,
        token,
        dvp,
        paymaster,
        finalitySeconds,
        String(input.governance ?? 'XPARTNER_COUNCIL').slice(0, 60),
        now,
      )
      .run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'WEB3_NETWORK_EXISTS', 'chainId já registrado.');
    throw error;
  }
  const anchorInfo = await anchor(env, 'WEB3_NETWORK_CREATE', 'web3_network', id, { id, chainId, kind });
  await queueEvent(env, { topic: 'web3.network.created', type: 'RedeWeb3', payload: { id, chainId } });
  return { network: networkView(await networkRow(env, id)), anchorHeight: anchorInfo.height };
}

// ── Oráculo ───────────────────────────────────────────────────────────────

export async function listFeeds(env: Env) {
  const feeds = await all<FeedRow>(env, 'SELECT * FROM web3_oracle_feeds ORDER BY symbol ASC');
  const data = [];
  for (const feed of feeds) {
    const latest = await one<PriceRow>(
      env,
      'SELECT * FROM web3_oracle_prices WHERE symbol = ? ORDER BY round_id DESC LIMIT 1',
      feed.symbol,
    );
    data.push(feedView(feed, latest));
  }
  return { data };
}

export async function registerFeed(env: Env, input: Record<string, unknown>) {
  const feedSymbol = symbol(input.symbol);
  const source = String(input.source ?? 'XPARTNER').toUpperCase();
  if (!ORACLE_SOURCES.has(source)) throw invalid('ORACLE_SOURCE', 'source deve ser CHAINLINK, BAND ou XPARTNER.');
  const decimals = optInt(input.decimals, 'decimals', 0, 8, 2);
  const maxAgeSeconds = optInt(input.maxAgeSeconds, 'maxAgeSeconds', 30, 2_592_000, 3600);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO web3_oracle_feeds (symbol, source, decimals, max_age_seconds, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET source = excluded.source, decimals = excluded.decimals,
       max_age_seconds = excluded.max_age_seconds, updated_at = excluded.updated_at`,
  )
    .bind(feedSymbol, source, decimals, maxAgeSeconds, now, now)
    .run();
  const anchorInfo = await anchor(env, 'WEB3_ORACLE_FEED', 'web3_oracle_feed', feedSymbol, { feedSymbol, source });
  return { feed: feedView(await feedRow(env, feedSymbol), null), anchorHeight: anchorInfo.height };
}

export async function publishPrice(env: Env, actorId: string, input: Record<string, unknown>) {
  const feedSymbol = symbol(input.symbol);
  const feed = await feedRow(env, feedSymbol);
  if (feed.status !== 'ACTIVE') throw invalid('ORACLE_PAUSED', 'Feed de oráculo pausado.');
  const priceUnits = positiveInt(input.priceUnits, 'priceUnits', 10 ** 15);
  const source = String(input.source ?? feed.source).toUpperCase();
  if (!ORACLE_SOURCES.has(source)) throw invalid('ORACLE_SOURCE', 'source inválido.');
  const publishedAt = isoDateOrThrow(input.publishedAt, 'publishedAt', Date.now());
  const latest = await one<PriceRow>(
    env,
    'SELECT * FROM web3_oracle_prices WHERE symbol = ? ORDER BY round_id DESC LIMIT 1',
    feedSymbol,
  );
  const round = (latest?.round_id ?? 0) + 1;
  const id = newId('orc');
  await env.DB.prepare(
    `INSERT INTO web3_oracle_prices (id, symbol, price_units, round_id, source, published_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, feedSymbol, priceUnits, round, source, publishedAt, nowIso())
    .run();
  const anchorInfo = await anchor(env, 'WEB3_ORACLE_PRICE', 'web3_oracle_price', id, {
    symbol: feedSymbol,
    priceUnits,
    round,
    source,
  });
  await queueEvent(env, {
    topic: 'web3.oracle.price',
    type: 'RodadaOrcamento',
    payload: { symbol: feedSymbol, round, priceUnits, actorId },
  });
  return {
    price: {
      symbol: feedSymbol,
      round,
      priceUnits,
      centsPerUnit: oracleCentsPerUnit(priceUnits, feed.decimals),
      centsPerUnitFormatted: formatBRL(oracleCentsPerUnit(priceUnits, feed.decimals)),
      source,
      publishedAt,
    },
    anchorHeight: anchorInfo.height,
  };
}

export async function readPrice(env: Env, symbolValue: string, nowMs = Date.now()) {
  const feedSymbol = symbol(symbolValue);
  const feed = await feedRow(env, feedSymbol);
  if (feed.status !== 'ACTIVE') throw invalid('ORACLE_PAUSED', 'Feed de oráculo pausado.');
  const latest = await one<PriceRow>(
    env,
    'SELECT * FROM web3_oracle_prices WHERE symbol = ? ORDER BY round_id DESC LIMIT 1',
    feedSymbol,
  );
  if (!latest) throw invalid('ORACLE_MISSING', 'Sem preço publicado para o feed.');
  const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(latest.published_at)) / 1000));
  if (ageSeconds > feed.max_age_seconds) {
    throw invalid('ORACLE_STALE', `Preço do oráculo ${feedSymbol} está defasado (${ageSeconds}s).`, {
      symbol: feedSymbol,
      ageSeconds,
      maxAgeSeconds: feed.max_age_seconds,
    });
  }
  return {
    symbol: feedSymbol,
    source: latest.source,
    decimals: feed.decimals,
    priceUnits: latest.price_units,
    centsPerUnit: oracleCentsPerUnit(latest.price_units, feed.decimals),
    centsPerUnitFormatted: formatBRL(oracleCentsPerUnit(latest.price_units, feed.decimals)),
    round: latest.round_id,
    publishedAt: latest.published_at,
    ageSeconds,
    maxAgeSeconds: feed.max_age_seconds,
  };
}

// ── DVP ───────────────────────────────────────────────────────────────────

export async function listOffers(env: Env, holderId: string, filter: { status?: string; mine?: boolean; limit?: number }) {
  const clauses: string[] = [];
  const binds: Bind[] = [];
  if (filter.status) {
    clauses.push('status = ?');
    binds.push(filter.status.toUpperCase());
  } else {
    clauses.push("status IN ('OPEN','FILLED')");
  }
  if (filter.mine) {
    clauses.push('maker_id = ?');
    binds.push(holderId);
  }
  const rows = await all<OfferRow>(
    env,
    `SELECT * FROM web3_dvp_offers WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ...binds,
    limitOf(filter.limit),
  );
  return { data: rows.map(offerView) };
}

export async function getOffer(env: Env, offerId: string) {
  const row = await one<OfferRow>(env, 'SELECT * FROM web3_dvp_offers WHERE id = ?', offerId);
  if (!row) throw new HttpError(404, 'DVP_OFFER_NOT_FOUND', 'Oferta DVP não encontrada.');
  return { offer: offerView(row) };
}

export async function createOffer(env: Env, makerId: string, input: Record<string, unknown>) {
  const network = await networkRow(env, requiredText(input.networkId, 'networkId', 80));
  if (network.status !== 'ACTIVE') throw invalid('WEB3_NETWORK_PAUSED', 'Rede pausada.');
  const kind = String(input.kind ?? 'CASH_FOR_TOKEN').toUpperCase();
  if (kind !== 'CASH_FOR_TOKEN' && kind !== 'TOKEN_FOR_TOKEN') {
    throw invalid('DVP_KIND', 'kind deve ser CASH_FOR_TOKEN ou TOKEN_FOR_TOKEN.');
  }
  const sellSymbol = symbol(input.sellSymbol, 'sellSymbol');
  const sellUnits = positiveInt(input.sellUnits, 'sellUnits', 10 ** 12);
  const buySymbol = kind === 'TOKEN_FOR_TOKEN' ? symbol(input.buySymbol, 'buySymbol') : null;
  const buyUnits = kind === 'TOKEN_FOR_TOKEN' ? positiveInt(input.buyUnits, 'buyUnits', 10 ** 12) : null;
  const cashCents = kind === 'CASH_FOR_TOKEN' ? positiveInt(input.cashCents, 'cashCents', 10 ** 12) : 0;
  const feeBps = optInt(input.feeBps, 'feeBps', 0, 1_000, 0);
  const expiresAt = isoDateOrThrow(input.expiresAt, 'expiresAt', Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (Date.parse(expiresAt) <= Date.now()) throw invalid('DVP_EXPIRED', 'expiresAt deve estar no futuro.');
  const takerId = input.takerId ? requiredText(input.takerId, 'takerId', 80) : null;
  if (takerId === makerId) throw invalid('DVP_SELF', 'Maker e taker devem ser diferentes.');
  await ensureUnits(env, sellSymbol, makerId, sellUnits, 'DVP_INSUFFICIENT_UNITS');
  const nonce = String(input.nonce ?? newId('nonce')).slice(0, 80);
  if (nonce.length < 8) throw invalid('DVP_NONCE', 'nonce deve ter ao menos 8 caracteres.');
  const digest = await dvpOfferDigest(
    { chainId: network.chain_id, verifyingContract: network.dvp_contract ?? '0x0000000000000000000000000000000000000000' },
    { maker: makerId, taker: takerId, sellSymbol, sellUnits, buySymbol, buyUnits, cashCents, feeBps, nonce, expiresAt },
  );
  const id = newId('dvp');
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO web3_dvp_offers
         (id, network_id, maker_id, taker_id, kind, sell_symbol, sell_units, buy_symbol, buy_units,
          cash_cents, fee_bps, nonce, digest, expires_at, status, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL)`,
    )
      .bind(
        id,
        network.id,
        makerId,
        takerId,
        kind,
        sellSymbol,
        sellUnits,
        buySymbol,
        buyUnits,
        cashCents,
        feeBps,
        nonce,
        digest,
        expiresAt,
        now,
      )
      .run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'DVP_NONCE_REUSED', 'Nonce já usado por este maker.');
    throw error;
  }
  const anchorInfo = await anchor(env, 'WEB3_DVP_OFFER', 'web3_dvp_offer', id, { id, makerId, sellSymbol, sellUnits, cashCents });
  await queueEvent(env, { topic: 'web3.dvp.offer', type: 'OfertaDVP', payload: { id, makerId } });
  return { offer: offerView(await one<OfferRow>(env, 'SELECT * FROM web3_dvp_offers WHERE id = ?', id) as OfferRow), anchorHeight: anchorInfo.height };
}

export async function acceptOffer(env: Env, offerId: string, takerId: string) {
  const offer = await one<OfferRow>(env, 'SELECT * FROM web3_dvp_offers WHERE id = ?', offerId);
  if (!offer) throw new HttpError(404, 'DVP_OFFER_NOT_FOUND', 'Oferta DVP não encontrada.');
  if (offer.status !== 'OPEN') throw new HttpError(409, 'DVP_OFFER_CLOSED', 'Oferta não está aberta.');
  if (Date.parse(offer.expires_at) <= Date.now()) {
    await env.DB.prepare("UPDATE web3_dvp_offers SET status = 'EXPIRED' WHERE id = ?").bind(offer.id).run();
    throw invalid('DVP_OFFER_EXPIRED', 'Oferta expirada.');
  }
  if (offer.maker_id === takerId) throw invalid('DVP_SELF', 'Maker não pode aceitar a própria oferta.');
  if (offer.taker_id && offer.taker_id !== takerId) {
    throw new HttpError(403, 'DVP_TAKER_ONLY', 'Oferta reservada a outro taker.');
  }
  await ensureUnits(env, offer.sell_symbol, offer.maker_id, offer.sell_units, 'DVP_INSUFFICIENT_UNITS');
  if (offer.kind === 'TOKEN_FOR_TOKEN') {
    await ensureUnits(env, offer.buy_symbol as string, takerId, offer.buy_units as number, 'DVP_INSUFFICIENT_UNITS');
  }

  const feeCents = Math.floor((offer.cash_cents * offer.fee_bps) / 10_000);
  const netCash = offer.cash_cents - feeCents;
  const now = nowIso();
  const tradeId = newId('dvt');
  const stmts: D1PreparedStatement[] = [
    debitUnitsStmt(env, offer.sell_symbol, offer.maker_id, offer.sell_units, now),
    creditUnitsStmt(env, offer.sell_symbol, takerId, offer.sell_units, now),
  ];
  let cashTransferId: string | null = null;
  let feeTransferId: string | null = null;
  if (offer.kind === 'CASH_FOR_TOKEN') {
    const cash = await cashStatement(env, takerId, offer.maker_id, netCash, `DVP ${offer.id}`, now);
    if (!cash) throw invalid('DVP_CASH', 'Perna em dinheiro inválida.');
    stmts.push(cash.stmt);
    cashTransferId = cash.id;
    if (feeCents > 0) {
      const fee = await cashStatement(env, takerId, SYSTEM_USER_ID, feeCents, `Taxa DVP ${offer.id}`, now);
      if (!fee) throw invalid('DVP_FEE', 'Perna de taxa inválida.');
      stmts.push(fee.stmt);
      feeTransferId = fee.id;
    }
  } else {
    stmts.push(
      debitUnitsStmt(env, offer.buy_symbol as string, takerId, offer.buy_units as number, now),
      creditUnitsStmt(env, offer.buy_symbol as string, offer.maker_id, offer.buy_units as number, now),
    );
  }
  stmts.push(
    env.DB.prepare("UPDATE web3_dvp_offers SET status = 'FILLED', taker_id = ?, settled_at = ? WHERE id = ? AND status = 'OPEN'").bind(
      takerId,
      now,
      offer.id,
    ),
  );
  const txDigest = await sha256Hex(
    `xpartner:dvp:trade:v1:${tradeId}:${offer.id}:${offer.maker_id}:${takerId}:${offer.sell_symbol}:${offer.sell_units}`,
  );
  stmts.push(
    env.DB.prepare(
      `INSERT INTO web3_dvp_trades
         (id, offer_id, network_id, maker_id, taker_id, sell_symbol, sell_units, buy_symbol, buy_units,
          cash_cents, fee_cents, cash_transfer_id, fee_transfer_id, tx_digest, anchor_height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      tradeId,
      offer.id,
      offer.network_id,
      offer.maker_id,
      takerId,
      offer.sell_symbol,
      offer.sell_units,
      offer.buy_symbol,
      offer.buy_units,
      offer.cash_cents,
      feeCents,
      cashTransferId,
      feeTransferId,
      txDigest,
      now,
    ),
  );
  try {
    await env.DB.batch(stmts);
  } catch (error) {
    const message = String(error);
    if (message.includes('INSUFFICIENT_FUNDS')) {
      throw invalid('DVP_INSUFFICIENT_CASH', 'Taker sem saldo disponível para a perna em dinheiro.');
    }
    if (message.includes('CHECK') || message.includes('constraint')) {
      throw invalid('DVP_INSUFFICIENT_UNITS', 'Saldo de unidades insuficiente para liquidar.');
    }
    throw error;
  }
  const anchorInfo = await anchor(env, 'WEB3_DVP_SETTLED', 'web3_dvp_trade', tradeId, {
    tradeId,
    offerId: offer.id,
    makerId: offer.maker_id,
    takerId,
    cashCents: offer.cash_cents,
    feeCents,
  });
  await env.DB.prepare('UPDATE web3_dvp_trades SET anchor_height = ? WHERE id = ?').bind(anchorInfo.height, tradeId).run();
  await queueEvent(env, {
    topic: 'web3.dvp.settled',
    type: 'LiquidacaoAtomica',
    payload: { tradeId, offerId: offer.id, cashCents: offer.cash_cents, feeCents },
  });
  const trade = await one<TradeRow>(env, 'SELECT * FROM web3_dvp_trades WHERE id = ?', tradeId);
  return { trade: tradeView(trade as TradeRow), anchorHeight: anchorInfo.height };
}

export async function cancelOffer(env: Env, offerId: string, actorId: string) {
  const offer = await one<OfferRow>(env, 'SELECT * FROM web3_dvp_offers WHERE id = ?', offerId);
  if (!offer) throw new HttpError(404, 'DVP_OFFER_NOT_FOUND', 'Oferta DVP não encontrada.');
  if (offer.maker_id !== actorId) throw new HttpError(403, 'DVP_MAKER_ONLY', 'Somente o maker cancela a oferta.');
  if (offer.status !== 'OPEN') throw new HttpError(409, 'DVP_OFFER_CLOSED', 'Oferta não está aberta.');
  await env.DB.prepare("UPDATE web3_dvp_offers SET status = 'CANCELLED', settled_at = ? WHERE id = ?").bind(nowIso(), offer.id).run();
  const anchorInfo = await anchor(env, 'WEB3_DVP_CANCEL', 'web3_dvp_offer', offer.id, { offerId: offer.id, actorId });
  return { ok: true, anchorHeight: anchorInfo.height };
}

export async function listTrades(env: Env, holderId: string, limit?: number) {
  const rows = await all<TradeRow>(
    env,
    'SELECT * FROM web3_dvp_trades WHERE maker_id = ? OR taker_id = ? ORDER BY created_at DESC LIMIT ?',
    holderId,
    holderId,
    limitOf(limit),
  );
  return { data: rows.map(tradeView) };
}

// ── Crédito agro ──────────────────────────────────────────────────────────

export async function listAgro(env: Env, holderId: string, status?: string, limit?: number) {
  const rows = status
    ? await all<AgroRow>(
        env,
        'SELECT * FROM web3_agro_contracts WHERE holder_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
        holderId,
        status.toUpperCase(),
        limitOf(limit),
      )
    : await all<AgroRow>(
        env,
        'SELECT * FROM web3_agro_contracts WHERE holder_id = ? ORDER BY created_at DESC LIMIT ?',
        holderId,
        limitOf(limit),
      );
  const data = [];
  for (const row of rows) data.push(await agroView(env, row));
  return { data };
}

export async function getAgro(env: Env, contractId: string, holderId?: string) {
  const row = await one<AgroRow>(env, 'SELECT * FROM web3_agro_contracts WHERE id = ?', contractId);
  if (!row) throw new HttpError(404, 'AGRO_NOT_FOUND', 'Contrato agro não encontrado.');
  if (holderId && row.holder_id !== holderId) throw new HttpError(403, 'AGRO_FORBIDDEN', 'Contrato de outro titular.');
  return { contract: await agroView(env, row) };
}

export async function openAgro(env: Env, holderId: string, input: Record<string, unknown>) {
  const network = await networkRow(env, requiredText(input.networkId, 'networkId', 80));
  if (network.status !== 'ACTIVE') throw invalid('WEB3_NETWORK_PAUSED', 'Rede pausada.');
  const collateralSymbol = symbol(input.collateralSymbol, 'collateralSymbol');
  const collateralUnits = positiveInt(input.collateralUnits, 'collateralUnits', 10 ** 12);
  const principalCents = positiveInt(input.principalCents, 'principalCents', 10 ** 12);
  const interestBps = optInt(input.interestBps, 'interestBps', 0, 20_000, 1_200);
  const ltvBps = optInt(input.ltvBps, 'ltvBps', 1, 9_000, 6_500);
  const liquidationLtvBps = optInt(input.liquidationLtvBps, 'liquidationLtvBps', 1, 10_000, 8_000);
  if (liquidationLtvBps < ltvBps) throw invalid('AGRO_LTV', 'liquidationLtvBps deve ser maior ou igual a ltvBps.');
  const durationDays = optInt(input.durationDays, 'durationDays', 30, 720, 180);
  const oracleSymbol = symbol(input.oracleSymbol ?? collateralSymbol, 'oracleSymbol');
  const price = await readPrice(env, oracleSymbol);
  const collateralCents = collateralUnits * price.centsPerUnit;
  const maxPrincipal = Math.floor((collateralCents * ltvBps) / 10_000);
  if (principalCents > maxPrincipal) {
    throw invalid('AGRO_LTV_EXCEEDED', 'Principal acima do limite de LTV para o colateral.', {
      principalCents,
      maxPrincipalCents: maxPrincipal,
      ltvBps,
    });
  }
  await ensureUnits(env, collateralSymbol, holderId, collateralUnits, 'AGRO_INSUFFICIENT_COLLATERAL');
  const interestCents = Math.round((principalCents * interestBps) / 10_000);
  const outstanding = principalCents + interestCents;
  const id = newId('agr');
  const now = nowIso();
  const dueAt = nowIso(durationDays * 86_400_000);
  const cash = await cashStatement(env, SYSTEM_USER_ID, holderId, principalCents, `Crédito agro ${id}`, now);
  if (!cash) throw invalid('AGRO_CASH', 'Desembolso inválido.');
  const stmts = [
    debitUnitsStmt(env, collateralSymbol, holderId, collateralUnits, now),
    creditUnitsStmt(env, collateralSymbol, AGRO_ESCROW_HOLDER, collateralUnits, now),
    cash.stmt,
    env.DB.prepare(
      `INSERT INTO web3_agro_contracts
         (id, network_id, holder_id, collateral_symbol, collateral_units, principal_cents, outstanding_cents,
          interest_bps, ltv_bps, liquidation_ltv_bps, oracle_symbol, status, disbursement_transfer_id,
          due_at, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, NULL)`,
    ).bind(
      id,
      network.id,
      holderId,
      collateralSymbol,
      collateralUnits,
      principalCents,
      outstanding,
      interestBps,
      ltvBps,
      liquidationLtvBps,
      oracleSymbol,
      cash.id,
      dueAt,
      now,
      now,
    ),
  ];
  await env.DB.batch(stmts);
  const anchorInfo = await anchor(env, 'WEB3_AGRO_OPEN', 'web3_agro_contract', id, {
    id,
    holderId,
    principalCents,
    collateralUnits,
    collateralSymbol,
    ltvBps,
  });
  await queueEvent(env, { topic: 'web3.agro.opened', type: 'CreditoAgro', payload: { id, principalCents } });
  return { contract: await agroView(env, (await one<AgroRow>(env, 'SELECT * FROM web3_agro_contracts WHERE id = ?', id)) as AgroRow), anchorHeight: anchorInfo.height };
}

export async function repayAgro(env: Env, contractId: string, holderId: string, amountCents?: number) {
  const row = await one<AgroRow>(env, 'SELECT * FROM web3_agro_contracts WHERE id = ?', contractId);
  if (!row) throw new HttpError(404, 'AGRO_NOT_FOUND', 'Contrato agro não encontrado.');
  if (row.holder_id !== holderId) throw new HttpError(403, 'AGRO_FORBIDDEN', 'Contrato de outro titular.');
  if (row.status !== 'OPEN') throw new HttpError(409, 'AGRO_CLOSED', 'Contrato já encerrado.');
  const amount = amountCents === undefined ? row.outstanding_cents : positiveInt(amountCents, 'amountCents', 10 ** 12);
  if (amount > row.outstanding_cents) throw invalid('AGRO_OVERPAY', 'Pagamento excede o saldo devedor.');
  const remaining = row.outstanding_cents - amount;
  const now = nowIso();
  const cash = await cashStatement(env, holderId, SYSTEM_USER_ID, amount, `Quitação agro ${row.id}`, now);
  if (!cash) throw invalid('AGRO_CASH', 'Pagamento inválido.');
  const stmts = [
    cash.stmt,
    env.DB.prepare(
      "UPDATE web3_agro_contracts SET outstanding_cents = ?, status = ?, updated_at = ?, closed_at = ? WHERE id = ?",
    ).bind(remaining, remaining === 0 ? 'REPAID' : 'OPEN', now, remaining === 0 ? now : null, row.id),
  ];
  if (remaining === 0) {
    stmts.push(
      debitUnitsStmt(env, row.collateral_symbol, AGRO_ESCROW_HOLDER, row.collateral_units, now),
      creditUnitsStmt(env, row.collateral_symbol, row.holder_id, row.collateral_units, now),
    );
  }
  try {
    await env.DB.batch(stmts);
  } catch (error) {
    if (String(error).includes('INSUFFICIENT_FUNDS')) throw invalid('AGRO_INSUFFICIENT_CASH', 'Saldo insuficiente para a parcela.');
    throw error;
  }
  const anchorInfo = await anchor(env, 'WEB3_AGRO_REPAY', 'web3_agro_contract', row.id, {
    contractId: row.id,
    amountCents: amount,
    remainingCents: remaining,
  });
  return { contract: await agroView(env, (await one<AgroRow>(env, 'SELECT * FROM web3_agro_contracts WHERE id = ?', row.id)) as AgroRow), anchorHeight: anchorInfo.height };
}

export async function liquidateAgro(env: Env, contractId: string, liquidatorId: string) {
  const row = await one<AgroRow>(env, 'SELECT * FROM web3_agro_contracts WHERE id = ?', contractId);
  if (!row) throw new HttpError(404, 'AGRO_NOT_FOUND', 'Contrato agro não encontrado.');
  if (row.status !== 'OPEN') throw new HttpError(409, 'AGRO_CLOSED', 'Contrato já encerrado.');
  const price = await readPrice(env, row.oracle_symbol);
  const collateralCents = row.collateral_units * price.centsPerUnit;
  const currentLtv = loanToValueBps(row.outstanding_cents, collateralCents);
  if (currentLtv < row.liquidation_ltv_bps) {
    throw invalid('AGRO_NOT_LIQUIDATABLE', 'LTV abaixo do gatilho de liquidação.', {
      currentLtvBps: currentLtv,
      liquidationLtvBps: row.liquidation_ltv_bps,
    });
  }
  const now = nowIso();
  const cash = await cashStatement(env, liquidatorId, SYSTEM_USER_ID, row.outstanding_cents, `Liquidação agro ${row.id}`, now);
  if (!cash) throw invalid('AGRO_CASH', 'Liquidação inválida.');
  try {
    await env.DB.batch([
      cash.stmt,
      env.DB.prepare(
        "UPDATE web3_agro_contracts SET outstanding_cents = 0, status = 'LIQUIDATED', updated_at = ?, closed_at = ? WHERE id = ?",
      ).bind(now, now, row.id),
      debitUnitsStmt(env, row.collateral_symbol, AGRO_ESCROW_HOLDER, row.collateral_units, now),
      creditUnitsStmt(env, row.collateral_symbol, liquidatorId, row.collateral_units, now),
    ]);
  } catch (error) {
    if (String(error).includes('INSUFFICIENT_FUNDS')) throw invalid('AGRO_INSUFFICIENT_CASH', 'Liquidante sem saldo para assumir a dívida.');
    throw error;
  }
  const anchorInfo = await anchor(env, 'WEB3_AGRO_LIQUIDATE', 'web3_agro_contract', row.id, {
    contractId: row.id,
    liquidatorId,
    debtCents: row.outstanding_cents,
    currentLtvBps: currentLtv,
  });
  return { contract: await agroView(env, (await one<AgroRow>(env, 'SELECT * FROM web3_agro_contracts WHERE id = ?', row.id)) as AgroRow), anchorHeight: anchorInfo.height };
}

// ── ZK: atestações, nullifier e provas registradas ────────────────────────

export async function listAttestations(env: Env, holderId: string, commitment?: string) {
  const rows = commitment
    ? await all<AttestationRow>(
        env,
        'SELECT * FROM web3_zk_attestations WHERE holder_id = ? AND commitment = ? ORDER BY created_at DESC',
        holderId,
        commitment,
      )
    : await all<AttestationRow>(
        env,
        'SELECT * FROM web3_zk_attestations WHERE holder_id = ? ORDER BY created_at DESC LIMIT 100',
        holderId,
      );
  return { data: rows.map((row) => attestationView(row)) };
}

export async function issueAttestation(env: Env, holderId: string, input: Record<string, unknown>) {
  const commitment = requiredText(input.commitment, 'commitment', 120);
  const claimType = requiredText(input.claimType ?? 'NET_WORTH', 'claimType', 40).toUpperCase();
  const predicate = String(input.predicate ?? 'GTE').toUpperCase();
  if (!['GTE', 'LTE', 'EQ'].includes(predicate)) throw invalid('ZK_PREDICATE', 'predicate deve ser GTE, LTE ou EQ.');
  const threshold = positiveInt(input.threshold, 'threshold', 10 ** 15);
  const issuer = requiredText(input.issuer ?? 'xpartner:issuer:api', 'issuer', 80);
  const expiresAt = isoDateOrThrow(input.expiresAt, 'expiresAt', Date.now() + 30 * 86_400_000);
  if (Date.parse(expiresAt) <= Date.now()) throw invalid('ZK_EXPIRED', 'expiresAt deve estar no futuro.');
  const hash = await attestationHash({ commitment, claimType, predicate, threshold, issuer, expiresAt });
  const id = newId('att');
  try {
    await env.DB.prepare(
      `INSERT INTO web3_zk_attestations
         (id, commitment, claim_type, predicate, threshold, issuer, attestation_hash, expires_at, holder_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
    )
      .bind(id, commitment, claimType, predicate, threshold, issuer, hash, expiresAt, holderId, nowIso())
      .run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'ZK_ATTESTATION_EXISTS', 'Atestação idêntica já registrada.');
    throw error;
  }
  const anchorInfo = await anchor(env, 'WEB3_ZK_ATTESTATION', 'web3_zk_attestation', id, {
    id,
    commitment,
    claimType,
    predicate,
    threshold,
    issuer,
  });
  await queueEvent(env, { topic: 'web3.zk.attestation', type: 'AtestacaoPredicado', payload: { id, claimType } });
  return {
    attestation: attestationView((await one<AttestationRow>(env, 'SELECT * FROM web3_zk_attestations WHERE id = ?', id)) as AttestationRow),
    anchorHeight: anchorInfo.height,
  };
}

export async function revokeAttestation(env: Env, attestationId: string, holderId: string) {
  const row = await one<AttestationRow>(env, 'SELECT * FROM web3_zk_attestations WHERE id = ?', attestationId);
  if (!row) throw new HttpError(404, 'ZK_ATTESTATION_NOT_FOUND', 'Atestação não encontrada.');
  if (row.holder_id !== holderId) throw new HttpError(403, 'ZK_FORBIDDEN', 'Atestação de outro titular.');
  if (row.status !== 'ACTIVE') return { ok: true, alreadyRevoked: true };
  await env.DB.prepare("UPDATE web3_zk_attestations SET status = 'REVOKED' WHERE id = ?").bind(row.id).run();
  const anchorInfo = await anchor(env, 'WEB3_ZK_REVOKE', 'web3_zk_attestation', row.id, {
    attestationId: row.id,
    actorId: holderId,
  });
  return { ok: true, anchorHeight: anchorInfo.height };
}

export async function verifyAttestation(env: Env, holderId: string, input: Record<string, unknown>) {
  const purpose = requiredText(input.purpose ?? 'KYC', 'purpose', 60);
  const relyingParty = requiredText(input.relyingParty ?? 'xpartner:edge', 'relyingParty', 80);
  const now = Date.now();
  let row: AttestationRow | null = null;
  if (input.attestationId) {
    row = await one<AttestationRow>(env, 'SELECT * FROM web3_zk_attestations WHERE id = ?', String(input.attestationId));
  } else if (input.commitment) {
    const claimType = input.claimType ? String(input.claimType).toUpperCase() : null;
    row = claimType
      ? await one<AttestationRow>(
          env,
          "SELECT * FROM web3_zk_attestations WHERE holder_id = ? AND commitment = ? AND claim_type = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
          holderId,
          String(input.commitment),
          claimType,
        )
      : await one<AttestationRow>(
          env,
          "SELECT * FROM web3_zk_attestations WHERE holder_id = ? AND commitment = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
          holderId,
          String(input.commitment),
        );
  } else {
    throw invalid('ZK_INPUT', 'Informe attestationId ou commitment.');
  }
  if (!row) throw new HttpError(404, 'ZK_ATTESTATION_NOT_FOUND', 'Atestação ativa não encontrada.');
  if (row.holder_id !== holderId) throw new HttpError(403, 'ZK_FORBIDDEN', 'Atestação de outro titular.');
  if (row.status !== 'ACTIVE') throw invalid('ZK_ATTESTATION_REVOKED', 'Atestação revogada.');
  if (Date.parse(row.expires_at) <= now) throw invalid('ZK_EXPIRED', 'Atestação expirada.');
  const epoch = todayEpoch(now);
  const nullifier = await nullifierFor(row.commitment, purpose, epoch);
  const existing = await one<NullifierRow>(env, 'SELECT * FROM web3_zk_nullifiers WHERE nullifier = ?', nullifier);
  if (existing) throw new HttpError(409, 'ZK_NULLIFIER_REUSED', 'Nullifier já utilizado para esta finalidade.');
  await env.DB.prepare(
    'INSERT INTO web3_zk_nullifiers (nullifier, attestation_id, purpose, relying_party, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(nullifier, row.id, purpose, relyingParty, nowIso())
    .run();
  const anchorInfo = await anchor(env, 'WEB3_ZK_VERIFY', 'web3_zk_attestation', row.id, {
    attestationId: row.id,
    purpose,
    relyingParty,
    nullifier,
  });
  return {
    verified: true,
    attestationId: row.id,
    commitment: row.commitment,
    claimType: row.claim_type,
    predicate: row.predicate,
    threshold: row.threshold,
    purpose,
    relyingParty,
    nullifier,
    epoch,
    verifiedAt: nowIso(),
    anchorHeight: anchorInfo.height,
  };
}

export async function listVerifications(env: Env, holderId: string, limit?: number) {
  const rows = await all<NullifierRow & { commitment: string; claim_type: string; predicate: string; threshold: number }>(
    env,
    `SELECT n.*, a.commitment, a.claim_type, a.predicate, a.threshold
       FROM web3_zk_nullifiers n
       JOIN web3_zk_attestations a ON a.id = n.attestation_id
      WHERE a.holder_id = ?
      ORDER BY n.created_at DESC LIMIT ?`,
    holderId,
    limitOf(limit),
  );
  return {
    data: rows.map((row) => ({
      nullifier: row.nullifier,
      attestationId: row.attestation_id,
      commitment: row.commitment,
      claimType: row.claim_type,
      predicate: row.predicate,
      threshold: row.threshold,
      purpose: row.purpose,
      relyingParty: row.relying_party,
      createdAt: row.created_at,
    })),
  };
}

export async function registerProof(env: Env, holderId: string, input: Record<string, unknown>) {
  const circuit = requiredText(input.circuit ?? 'NetWorthProof', 'circuit', 60);
  const thresholdCents = positiveInt(input.thresholdCents, 'thresholdCents', 10 ** 15);
  const publicSignals = Array.isArray(input.publicSignals) ? input.publicSignals.map(String) : [];
  if (publicSignals.length < 3) throw invalid('ZK_PROOF', 'publicSignals deve conter compromisso, resultado e limiar.');
  const proof = input.proof;
  if (!proof || typeof proof !== 'object') throw invalid('ZK_PROOF', 'proof Groth16 é obrigatório.');
  const proofHash = await sha256Hex(`xpartner:zk:groth16:v1:${JSON.stringify(proof)}|${publicSignals.join(',')}`);
  const existing = await one<{ id: string }>(env, 'SELECT id FROM zk_snark_proofs WHERE proof_hash = ?', proofHash);
  if (existing) throw new HttpError(409, 'ZK_PROOF_REUSED', 'Prova já registrada.');
  const id = newId('zkp');
  const commitment = publicSignals[0] ?? '';
  await env.DB.prepare(
    `INSERT INTO zk_snark_proofs
       (id, holder_id, circuit, commitment, threshold_cents, proof_hash, public_signals, proof_json,
        verified, verifier, created_at, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'CORE_NODE_REQUIRED', ?, NULL)`,
  )
    .bind(id, holderId, circuit, commitment, thresholdCents, proofHash, JSON.stringify(publicSignals), JSON.stringify(proof), nowIso())
    .run();
  const anchorInfo = await anchor(env, 'WEB3_ZK_PROOF_REGISTER', 'zk_snark_proof', id, {
    id,
    circuit,
    thresholdCents,
    proofHash,
  });
  return {
    proof: {
      id,
      circuit,
      commitment,
      thresholdCents,
      verified: false,
      verifier: 'CORE_NODE_REQUIRED',
      message: 'Prova registrada no D1. A verificação Groth16 roda no core Node; o edge não executa snarkjs.',
    },
    anchorHeight: anchorInfo.height,
  };
}

// ── Agentes (ERC-4337) ────────────────────────────────────────────────────

async function ensurePolicy(env: Env, holderId: string, policyId?: string): Promise<PolicyRow> {
  if (policyId) {
    const policy = await one<PolicyRow>(env, 'SELECT * FROM web3_agent_policies WHERE id = ?', policyId);
    if (!policy) throw new HttpError(404, 'AGENT_POLICY_NOT_FOUND', 'Política de agente não encontrada.');
    if (policy.holder_id !== holderId) throw new HttpError(403, 'AGENT_POLICY_FORBIDDEN', 'Política de outro titular.');
    if (policy.status !== 'ACTIVE') throw invalid('AGENT_POLICY_PAUSED', 'Política pausada.');
    return policy;
  }
  const existing = await one<PolicyRow>(
    env,
    "SELECT * FROM web3_agent_policies WHERE holder_id = ? AND label = 'default'",
    holderId,
  );
  if (existing) return existing;
  const now = nowIso();
  const id = newId('agp');
  await env.DB.prepare(
    `INSERT INTO web3_agent_policies
       (id, holder_id, label, per_action_max_cents, daily_cap_cents, allowed_symbols, status, created_at)
     VALUES (?, ?, 'default', 500000, 2000000, 'NFCR,SOJA,USDX', 'ACTIVE', ?)`,
  )
    .bind(id, holderId, now)
    .run();
  return (await one<PolicyRow>(env, 'SELECT * FROM web3_agent_policies WHERE id = ?', id)) as PolicyRow;
}

export async function listSessions(env: Env, holderId: string, limit?: number) {
  const rows = await all<SessionRow>(
    env,
    'SELECT * FROM web3_agent_sessions WHERE holder_id = ? ORDER BY created_at DESC LIMIT ?',
    holderId,
    limitOf(limit),
  );
  return { data: rows.map(sessionView) };
}

export async function grantSession(env: Env, holderId: string, input: Record<string, unknown>) {
  const policy = await ensurePolicy(env, holderId, input.policyId ? String(input.policyId) : undefined);
  const network = await networkRow(env, requiredText(input.networkId, 'networkId', 80));
  const agent = requiredText(input.agent, 'agent', 80);
  const selectorsRaw = Array.isArray(input.allowedSelectors)
    ? input.allowedSelectors
    : String(input.allowedSelectors ?? '').split(',');
  const selectors = selectorsRaw.map((value) => String(value).trim()).filter(Boolean);
  if (selectors.length === 0 || selectors.length > 20) throw invalid('AGENT_SELECTORS', 'Informe de 1 a 20 seletores.');
  for (const selector of selectors) {
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(selector)) throw invalid('AGENT_SELECTORS', `Seletor inválido: ${selector}.`);
  }
  const spendCapCents = optInt(input.spendCapCents, 'spendCapCents', 1, policy.daily_cap_cents, policy.daily_cap_cents);
  const ttlSeconds = optInt(input.ttlSeconds, 'ttlSeconds', 600, 30 * 86_400, 3_600);
  const sessionKey = `sk_${randomToken(24)}`;
  const keyHash = await sessionKeyHash(sessionKey);
  const id = newId('ags');
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO web3_agent_sessions
       (id, policy_id, holder_id, network_id, agent, key_hash, allowed_selectors, spend_cap_cents, spent_cents,
        expires_at, status, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ACTIVE', ?, NULL)`,
  )
    .bind(
      id,
      policy.id,
      holderId,
      network.id,
      agent,
      keyHash,
      selectors.join(','),
      spendCapCents,
      nowIso(ttlSeconds * 1000),
      now,
    )
    .run();
  const anchorInfo = await anchor(env, 'WEB3_AGENT_SESSION', 'web3_agent_session', id, {
    id,
    holderId,
    agent,
    selectors,
    spendCapCents,
  });
  const session = await one<SessionRow>(env, 'SELECT * FROM web3_agent_sessions WHERE id = ?', id);
  return {
    session: sessionView(session as SessionRow),
    sessionKey,
    keyNotice: 'A chave de sessão aparece uma única vez e não é persistida.',
    policy: policyView(policy),
    anchorHeight: anchorInfo.height,
  };
}

export async function authorizeSession(env: Env, sessionId: string, holderId: string, input: Record<string, unknown>) {
  const session = await one<SessionRow>(env, 'SELECT * FROM web3_agent_sessions WHERE id = ?', sessionId);
  if (!session) throw new HttpError(404, 'AGENT_SESSION_NOT_FOUND', 'Sessão de agente não encontrada.');
  if (session.holder_id !== holderId) throw new HttpError(403, 'AGENT_SESSION_FORBIDDEN', 'Sessão de outro titular.');
  if (session.status !== 'ACTIVE') throw new HttpError(409, 'AGENT_SESSION_CLOSED', 'Sessão não está ativa.');
  if (Date.parse(session.expires_at) <= Date.now()) {
    await env.DB.prepare("UPDATE web3_agent_sessions SET status = 'EXPIRED' WHERE id = ?").bind(session.id).run();
    throw invalid('AGENT_SESSION_EXPIRED', 'Sessão expirada.');
  }
  const policy = await one<PolicyRow>(env, 'SELECT * FROM web3_agent_policies WHERE id = ?', session.policy_id);
  if (!policy) throw new HttpError(404, 'AGENT_POLICY_NOT_FOUND', 'Política da sessão ausente.');
  const selector = requiredText(input.selector, 'selector', 40);
  const actionSymbol = symbol(input.symbol ?? 'NFCR');
  const amountCents = optInt(input.amountCents, 'amountCents', 0, 10 ** 12, 0);
  let decision: 'APPROVE' | 'REVIEW' | 'BLOCK' = 'APPROVE';
  let reason = 'Dentro da política';

  if (!session.allowed_selectors.split(',').includes(selector)) {
    decision = 'BLOCK';
    reason = 'Seletor fora da allowlist';
  } else if (!policy.allowed_symbols.split(',').includes(actionSymbol)) {
    decision = 'BLOCK';
    reason = 'Símbolo fora da allowlist';
  } else if (amountCents > policy.per_action_max_cents) {
    decision = 'REVIEW';
    reason = 'Acima do teto por ação exige aprovação humana';
  } else if (session.spent_cents + amountCents > session.spend_cap_cents) {
    decision = 'BLOCK';
    reason = 'Teto da sessão excedido';
  } else if (Date.parse(session.expires_at) <= Date.now()) {
    decision = 'BLOCK';
    reason = 'Sessão expirada';
  } else {
    const today = todayEpoch();
    const spentToday = await one<{ total: number | null }>(
      env,
      "SELECT SUM(amount_cents) AS total FROM web3_agent_actions WHERE session_id = ? AND decision = 'APPROVE' AND created_at >= ?",
      session.id,
      `${today}T00:00:00.000Z`,
    );
    if ((spentToday?.total ?? 0) + amountCents > policy.daily_cap_cents) {
      decision = 'BLOCK';
      reason = 'Política diária excedida';
    }
  }

  const id = newId('aga');
  const now = nowIso();
  const digest = await actionDigest({ sessionId: session.id, selector, symbol: actionSymbol, amountCents, decision });
  const stmts = [
    env.DB.prepare(
      `INSERT INTO web3_agent_actions
         (id, session_id, selector, symbol, amount_cents, decision, reason, digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, session.id, selector, actionSymbol, amountCents, decision, reason, digest, now),
  ];
  if (decision === 'APPROVE') {
    stmts.push(
      env.DB.prepare('UPDATE web3_agent_sessions SET spent_cents = spent_cents + ? WHERE id = ?').bind(amountCents, session.id),
    );
  }
  await env.DB.batch(stmts);
  const anchorInfo = await anchor(env, 'WEB3_AGENT_ACTION', 'web3_agent_action', id, {
    actionId: id,
    sessionId: session.id,
    selector,
    symbol: actionSymbol,
    amountCents,
    decision,
  });
  return {
    action: { id, sessionId: session.id, selector, symbol: actionSymbol, amountCents, decision, reason, digest, createdAt: now },
    anchorHeight: anchorInfo.height,
  };
}

export async function revokeSession(env: Env, sessionId: string, holderId: string) {
  const session = await one<SessionRow>(env, 'SELECT * FROM web3_agent_sessions WHERE id = ?', sessionId);
  if (!session) throw new HttpError(404, 'AGENT_SESSION_NOT_FOUND', 'Sessão de agente não encontrada.');
  if (session.holder_id !== holderId) throw new HttpError(403, 'AGENT_SESSION_FORBIDDEN', 'Sessão de outro titular.');
  if (session.status === 'REVOKED') return { ok: true, alreadyRevoked: true };
  const now = nowIso();
  await env.DB.prepare("UPDATE web3_agent_sessions SET status = 'REVOKED', revoked_at = ? WHERE id = ?")
    .bind(now, session.id)
    .run();
  const anchorInfo = await anchor(env, 'WEB3_AGENT_REVOKE', 'web3_agent_session', session.id, {
    sessionId: session.id,
    actorId: holderId,
  });
  return { ok: true, revokedAt: now, anchorHeight: anchorInfo.height };
}

// ── Paymaster ─────────────────────────────────────────────────────────────

export async function listBudgets(env: Env, holderId: string) {
  const rows = await all<BudgetRow>(
    env,
    'SELECT * FROM web3_paymaster_budgets WHERE holder_id = ? ORDER BY created_at DESC',
    holderId,
  );
  return { data: rows.map(budgetView) };
}

export async function createBudget(env: Env, holderId: string, input: Record<string, unknown>) {
  const network = await networkRow(env, requiredText(input.networkId, 'networkId', 80));
  const label = requiredText(input.label ?? 'Patrocínio', 'label', 60);
  const capCents = positiveInt(input.capCents, 'capCents', 10 ** 12);
  const perOpMaxCents = positiveInt(input.perOpMaxCents, 'perOpMaxCents', capCents);
  const now = nowIso();
  const id = newId('pmb');
  await env.DB.prepare(
    `INSERT INTO web3_paymaster_budgets
       (id, holder_id, network_id, label, cap_cents, spent_cents, per_op_max_cents, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'ACTIVE', ?, ?)`,
  )
    .bind(id, holderId, network.id, label, capCents, perOpMaxCents, now, now)
    .run();
  const anchorInfo = await anchor(env, 'WEB3_PAYMASTER_BUDGET', 'web3_paymaster_budget', id, {
    id,
    holderId,
    capCents,
    perOpMaxCents,
  });
  return {
    budget: budgetView((await one<BudgetRow>(env, 'SELECT * FROM web3_paymaster_budgets WHERE id = ?', id)) as BudgetRow),
    anchorHeight: anchorInfo.height,
  };
}

export async function listOps(env: Env, holderId: string, limit?: number) {
  const rows = await all<PaymasterOpRow>(
    env,
    `SELECT o.* FROM web3_paymaster_ops o
      JOIN web3_paymaster_budgets b ON b.id = o.budget_id
     WHERE b.holder_id = ? ORDER BY o.created_at DESC LIMIT ?`,
    holderId,
    limitOf(limit),
  );
  return { data: rows.map(opView) };
}

export async function sponsorOp(env: Env, holderId: string, input: Record<string, unknown>) {
  const budgetId = requiredText(input.budgetId, 'budgetId', 80);
  const budget = await one<BudgetRow>(env, 'SELECT * FROM web3_paymaster_budgets WHERE id = ?', budgetId);
  if (!budget) throw new HttpError(404, 'PAYMASTER_BUDGET_NOT_FOUND', 'Orçamento de paymaster não encontrado.');
  if (budget.holder_id !== holderId) throw new HttpError(403, 'PAYMASTER_FORBIDDEN', 'Orçamento de outro titular.');
  if (budget.status !== 'ACTIVE') throw invalid('PAYMASTER_PAUSED', 'Orçamento pausado.');
  const gasCents = positiveInt(input.gasCents, 'gasCents', 10 ** 12);
  if (gasCents > budget.per_op_max_cents) {
    throw invalid('PAYMASTER_OP_LIMIT', 'Gas acima do teto por UserOp.', {
      gasCents,
      perOpMaxCents: budget.per_op_max_cents,
    });
  }
  if (budget.spent_cents + gasCents > budget.cap_cents) {
    throw invalid('PAYMASTER_CAP_EXCEEDED', 'Teto do orçamento de patrocínio seria excedido.');
  }
  const userOpHash = requiredText(input.userOpHash, 'userOpHash', 160);
  if (userOpHash.length < 8) throw invalid('PAYMASTER_USEROP', 'userOpHash inválido.');
  const existing = await one<{ id: string }>(env, 'SELECT id FROM web3_paymaster_ops WHERE user_op_hash = ?', userOpHash);
  if (existing) throw new HttpError(409, 'PAYMASTER_REPLAY', 'UserOp já patrocinada.');
  const id = newId('pmo');
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO web3_paymaster_ops (id, budget_id, user_op_hash, payer_id, gas_cents, anchor_height, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(id, budget.id, userOpHash, holderId, gasCents, now),
    env.DB.prepare('UPDATE web3_paymaster_budgets SET spent_cents = spent_cents + ?, updated_at = ? WHERE id = ?').bind(
      gasCents,
      now,
      budget.id,
    ),
  ]);
  const anchorInfo = await anchor(env, 'WEB3_PAYMASTER_SPONSOR', 'web3_paymaster_op', id, {
    id,
    budgetId: budget.id,
    gasCents,
  });
  await env.DB.prepare('UPDATE web3_paymaster_ops SET anchor_height = ? WHERE id = ?').bind(anchorInfo.height, id).run();
  return {
    op: opView((await one<PaymasterOpRow>(env, 'SELECT * FROM web3_paymaster_ops WHERE id = ?', id)) as PaymasterOpRow),
    budget: budgetView((await one<BudgetRow>(env, 'SELECT * FROM web3_paymaster_budgets WHERE id = ?', budget.id)) as BudgetRow),
    anchorHeight: anchorInfo.height,
  };
}

// ── Aladdin: risco e crédito ──────────────────────────────────────────────

export async function listRisk(env: Env, holderId: string, limit?: number) {
  const rows = await all<RiskRow>(
    env,
    'SELECT * FROM aladdin_risk_metrics WHERE holder_id = ? ORDER BY observed_at DESC LIMIT ?',
    holderId,
    limitOf(limit, 20),
  );
  return { data: rows.map((row) => riskView(row)) };
}

async function latestRisk(env: Env, holderId: string, nowMs = Date.now()): Promise<RiskRow> {
  const latest = await one<RiskRow>(
    env,
    'SELECT * FROM aladdin_risk_metrics WHERE holder_id = ? ORDER BY observed_at DESC LIMIT 1',
    holderId,
  );
  if (!latest) throw invalid('ALADDIN_RISK_MISSING', 'Sem métrica de risco para o titular.');
  if (Date.parse(latest.expires_at) <= nowMs) {
    throw invalid('ALADDIN_RISK_STALE', 'Métrica de risco expirada. Simule novamente.', {
      expiresAt: latest.expires_at,
    });
  }
  return latest;
}

async function persistRisk(
  env: Env,
  holderId: string,
  input: {
    varBps: number;
    volatilityBps: number;
    creditScore: number;
    model: string;
    source: string;
    sampleSize: number;
    ttlSeconds: number;
  },
): Promise<{ risk: ReturnType<typeof riskView>; anchorHeight: number }> {
  if (!RISK_SOURCES.has(input.source)) throw invalid('ALADDIN_SOURCE', 'source deve ser MONTE_CARLO, ORACLE_FUSION ou OPERATOR.');
  const observedAt = nowIso();
  const expiresAt = nowIso(input.ttlSeconds * 1000);
  const digest = await riskDigest({
    holderId,
    varBps: input.varBps,
    volatilityBps: input.volatilityBps,
    creditScore: input.creditScore,
    model: input.model,
    source: input.source,
    sampleSize: input.sampleSize,
    observedAt,
    expiresAt,
  });
  const id = newId('rsq');
  await env.DB.prepare(
    `INSERT OR IGNORE INTO aladdin_risk_metrics
       (id, holder_id, var_bps, volatility_bps, credit_score, model, source, sample_size,
        observed_at, expires_at, digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      holderId,
      input.varBps,
      input.volatilityBps,
      input.creditScore,
      input.model,
      input.source,
      input.sampleSize,
      observedAt,
      expiresAt,
      digest,
      observedAt,
    )
    .run();
  const row = await one<RiskRow>(env, 'SELECT * FROM aladdin_risk_metrics WHERE digest = ?', digest);
  if (!row) throw new HttpError(500, 'ALADDIN_RISK', 'Falha ao persistir métrica de risco.');
  const anchorInfo = await anchor(env, 'ALADDIN_RISK', 'aladdin_risk_metric', row.id, {
    id: row.id,
    varBps: row.var_bps,
    creditScore: row.credit_score,
    source: row.source,
  });
  await queueEvent(env, {
    topic: 'aladdin.risk.recorded',
    type: 'MetricaRisco',
    payload: { id: row.id, varBps: row.var_bps, creditScore: row.credit_score },
  });
  return { risk: riskView(row), anchorHeight: anchorInfo.height };
}

export async function simulateRisk(env: Env, holderId: string, input: Record<string, unknown>) {
  const samples = optInt(input.samples, 'samples', 100, 50_000, 2_000);
  const confidenceBps = optInt(input.confidenceBps, 'confidenceBps', 5_000, 9_999, 9_900);
  const driftBps = optInt(input.driftBps, 'driftBps', -5_000, 5_000, 5);
  const volatilityBps = optInt(input.volatilityBps, 'volatilityBps', 1, 100_000, 250);
  const ttlSeconds = optInt(input.ttlSeconds, 'ttlSeconds', 300, 7 * 86_400, 86_400);
  const window = Math.floor(Date.now() / 86_400_000);
  const simulation = await simulateMonteCarlo({
    seedParts: [holderId, window, samples, confidenceBps, driftBps, volatilityBps],
    samples,
    confidenceBps,
    driftBps,
    volatilityBps,
  });
  const creditScore = creditScoreFrom({
    varBps: simulation.varBps,
    volatilityBps: simulation.volatilityBps,
    hasCollateral: input.hasCollateral === true,
    onTimeRatioBps: optInt(input.onTimeRatioBps, 'onTimeRatioBps', 0, 10_000, 7_500),
  });
  const result = await persistRisk(env, holderId, {
    varBps: simulation.varBps,
    volatilityBps: simulation.volatilityBps,
    creditScore,
    model: 'aladdin-monte-carlo-v1',
    source: 'MONTE_CARLO',
    sampleSize: simulation.sampleSize,
    ttlSeconds,
  });
  return {
    ...result,
    simulation: {
      varBps: simulation.varBps,
      volatilityBps: simulation.volatilityBps,
      meanBps: simulation.meanBps,
      sampleSize: simulation.sampleSize,
      confidenceBps: simulation.confidenceBps,
    },
    policy: {
      minScore: ALADDIN_MIN_SCORE,
      maxVarBps: ALADDIN_MAX_VAR_BPS,
      maxLoanCents: ALADDIN_MAX_LOAN_CENTS,
      maxLoanForScore: maxLoanForScore(creditScore),
    },
  };
}

export async function recordRisk(env: Env, holderId: string, input: Record<string, unknown>) {
  const varBps = optInt(input.varBps, 'varBps', 0, 10_000, 0);
  const volatilityBps = optInt(input.volatilityBps, 'volatilityBps', 0, 100_000, 0);
  const creditScore = optInt(input.creditScore, 'creditScore', 0, 10_000, 0);
  const source = String(input.source ?? 'OPERATOR').toUpperCase();
  const sampleSize = optInt(input.sampleSize, 'sampleSize', 0, 50_000, 0);
  const ttlSeconds = optInt(input.ttlSeconds, 'ttlSeconds', 300, 7 * 86_400, 86_400);
  return persistRisk(env, holderId, {
    varBps,
    volatilityBps,
    creditScore,
    model: String(input.model ?? 'aladdin-operator-v1').slice(0, 60),
    source,
    sampleSize,
    ttlSeconds,
  });
}

export async function listLoans(env: Env, holderId: string, limit?: number) {
  const rows = await all<LoanRow>(
    env,
    `SELECT l.*, a.commitment AS commitment FROM aladdin_loans l
       JOIN web3_zk_attestations a ON a.id = l.attestation_id
      WHERE l.borrower_id = ? ORDER BY l.created_at DESC LIMIT ?`,
    holderId,
    limitOf(limit, 20),
  );
  return { data: rows.map((row) => loanView(row)) };
}

export async function getLoan(env: Env, loanId: string, holderId?: string) {
  const row = await one<LoanRow>(
    env,
    `SELECT l.*, a.commitment AS commitment FROM aladdin_loans l
       JOIN web3_zk_attestations a ON a.id = l.attestation_id
      WHERE l.id = ?`,
    loanId,
  );
  if (!row) throw new HttpError(404, 'ALADDIN_LOAN_NOT_FOUND', 'Empréstimo não encontrado.');
  if (holderId && row.borrower_id !== holderId) throw new HttpError(403, 'ALADDIN_LOAN_FORBIDDEN', 'Empréstimo de outro titular.');
  return { loan: loanView(row) };
}

export async function openLoan(env: Env, holderId: string, input: Record<string, unknown>) {
  const principalCents = positiveInt(input.principalCents, 'principalCents', 10 ** 12);
  const interestBps = optInt(input.interestBps, 'interestBps', 0, 20_000, 1_800);
  const durationDays = optInt(input.durationDays, 'durationDays', 30, 360, 60);
  const risk = await latestRisk(env, holderId);
  if (risk.credit_score < ALADDIN_MIN_SCORE) {
    throw invalid('ALADDIN_SCORE_LOW', 'Score de crédito abaixo do mínimo do motor.', {
      creditScore: risk.credit_score,
      minScore: ALADDIN_MIN_SCORE,
    });
  }
  if (risk.var_bps > ALADDIN_MAX_VAR_BPS) {
    throw invalid('ALADDIN_VAR_HIGH', 'VaR acima do limite corporativo.', {
      varBps: risk.var_bps,
      maxVarBps: ALADDIN_MAX_VAR_BPS,
    });
  }
  const maxByScore = maxLoanForScore(risk.credit_score);
  if (principalCents > maxByScore) {
    throw invalid('ALADDIN_LIMIT_EXCEEDED', 'Principal acima da linha liberada pelo score.', {
      principalCents,
      maxPrincipalCents: maxByScore,
    });
  }
  let attestation: AttestationRow | null = null;
  if (input.attestationId) {
    attestation = await one<AttestationRow>(env, 'SELECT * FROM web3_zk_attestations WHERE id = ?', String(input.attestationId));
  } else if (input.commitment) {
    attestation = await one<AttestationRow>(
      env,
      "SELECT * FROM web3_zk_attestations WHERE holder_id = ? AND commitment = ? AND claim_type = 'NET_WORTH' AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
      holderId,
      String(input.commitment),
    );
  } else {
    attestation = await one<AttestationRow>(
      env,
      "SELECT * FROM web3_zk_attestations WHERE holder_id = ? AND claim_type = 'NET_WORTH' AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
      holderId,
    );
  }
  if (!attestation) throw invalid('ZK_ATTESTATION_MISSING', 'Informe uma atestação de patrimônio ativa.');
  if (attestation.holder_id !== holderId) throw new HttpError(403, 'ZK_FORBIDDEN', 'Atestação de outro titular.');
  if (attestation.status !== 'ACTIVE' || Date.parse(attestation.expires_at) <= Date.now()) {
    throw invalid('ZK_ATTESTATION_INVALID', 'Atestação inativa ou expirada.');
  }
  if (attestation.claim_type !== 'NET_WORTH' || attestation.predicate !== 'GTE') {
    throw invalid('ZK_CLAIM', 'A atestação deve ser NET_WORTH com predicado GTE.');
  }
  if (attestation.threshold < principalCents) {
    throw invalid('ZK_THRESHOLD_LOW', 'Patrimônio comprovado abaixo do principal solicitado.', {
      thresholdCents: attestation.threshold,
      principalCents,
    });
  }
  const active = await one<{ id: string }>(
    env,
    "SELECT id FROM aladdin_loans WHERE borrower_id = ? AND status = 'OPEN' LIMIT 1",
    holderId,
  );
  if (active) throw new HttpError(409, 'ALADDIN_LOAN_ACTIVE', 'Já existe empréstimo algorítmico em aberto.', { loanId: active.id });
  const used = await one<{ id: string }>(env, 'SELECT id FROM aladdin_loans WHERE attestation_id = ?', attestation.id);
  if (used) throw new HttpError(409, 'ZK_ATTESTATION_CONSUMED', 'Atestação já vinculada a um empréstimo.');
  const interestCents = Math.round((principalCents * interestBps) / 10_000);
  const outstanding = principalCents + interestCents;
  const id = newId('ald');
  const now = nowIso();
  const dueAt = nowIso(durationDays * 86_400_000);
  const cash = await cashStatement(env, SYSTEM_USER_ID, holderId, principalCents, `Crédito Aladdin ${id}`, now);
  if (!cash) throw invalid('ALADDIN_CASH', 'Desembolso inválido.');
  try {
    await env.DB.batch([
      cash.stmt,
      env.DB.prepare(
        `INSERT INTO aladdin_loans
           (id, borrower_id, principal_cents, outstanding_cents, interest_bps, risk_metric_id, attestation_id,
            score, var_bps, status, disbursement_transfer_id, due_at, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, NULL)`,
      ).bind(
        id,
        holderId,
        principalCents,
        outstanding,
        interestBps,
        risk.id,
        attestation.id,
        risk.credit_score,
        risk.var_bps,
        cash.id,
        dueAt,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO aladdin_credit_events (id, loan_id, kind, amount_cents, transfer_id, created_at)
         VALUES (?, ?, 'DISBURSEMENT', ?, ?, ?)`,
      ).bind(newId('ace'), id, principalCents, cash.id, now),
    ]);
  } catch (error) {
    if (String(error).includes('INSUFFICIENT_FUNDS')) throw invalid('ALADDIN_INSUFFICIENT_LIQUIDITY', 'Tesouraria sem liquidez para desembolso.');
    throw error;
  }
  const anchorInfo = await anchor(env, 'ALADDIN_LOAN_OPEN', 'aladdin_loan', id, {
    id,
    borrowerId: holderId,
    principalCents,
    outstandingCents: outstanding,
    score: risk.credit_score,
    varBps: risk.var_bps,
    attestationId: attestation.id,
  });
  await queueEvent(env, {
    topic: 'aladdin.loan.opened',
    type: 'EmprestimoAlgoritmico',
    payload: { loanId: id, principalCents, score: risk.credit_score, anchorHeight: anchorInfo.height },
  });
  const loan = await one<LoanRow>(
    env,
    `SELECT l.*, a.commitment AS commitment FROM aladdin_loans l
       JOIN web3_zk_attestations a ON a.id = l.attestation_id WHERE l.id = ?`,
    id,
  );
  return { loan: loanView(loan as LoanRow), anchorHeight: anchorInfo.height };
}

export async function repayLoan(env: Env, loanId: string, holderId: string, amountCents?: number) {
  const row = await one<LoanRow>(env, 'SELECT * FROM aladdin_loans WHERE id = ?', loanId);
  if (!row) throw new HttpError(404, 'ALADDIN_LOAN_NOT_FOUND', 'Empréstimo não encontrado.');
  if (row.borrower_id !== holderId) throw new HttpError(403, 'ALADDIN_LOAN_FORBIDDEN', 'Empréstimo de outro titular.');
  if (row.status !== 'OPEN') throw new HttpError(409, 'ALADDIN_LOAN_CLOSED', 'Empréstimo já encerrado.');
  const amount = amountCents === undefined ? row.outstanding_cents : positiveInt(amountCents, 'amountCents', 10 ** 12);
  if (amount > row.outstanding_cents) throw invalid('ALADDIN_OVERPAY', 'Pagamento excede o saldo devedor.');
  const remaining = row.outstanding_cents - amount;
  const now = nowIso();
  const cash = await cashStatement(env, holderId, SYSTEM_USER_ID, amount, `Parcela Aladdin ${row.id}`, now);
  if (!cash) throw invalid('ALADDIN_CASH', 'Pagamento inválido.');
  try {
    await env.DB.batch([
      cash.stmt,
      env.DB.prepare(
        'UPDATE aladdin_loans SET outstanding_cents = ?, status = ?, updated_at = ?, closed_at = ? WHERE id = ?',
      ).bind(remaining, remaining === 0 ? 'REPAID' : 'OPEN', now, remaining === 0 ? now : null, row.id),
      env.DB.prepare(
        `INSERT INTO aladdin_credit_events (id, loan_id, kind, amount_cents, transfer_id, created_at)
         VALUES (?, ?, 'REPAYMENT', ?, ?, ?)`,
      ).bind(newId('ace'), row.id, amount, cash.id, now),
    ]);
  } catch (error) {
    if (String(error).includes('INSUFFICIENT_FUNDS')) throw invalid('ALADDIN_INSUFFICIENT_CASH', 'Saldo disponível insuficiente para a parcela.');
    throw error;
  }
  const anchorInfo = await anchor(env, 'ALADDIN_LOAN_REPAY', 'aladdin_loan', row.id, {
    loanId: row.id,
    amountCents: amount,
    remainingCents: remaining,
  });
  const loan = await one<LoanRow>(
    env,
    `SELECT l.*, a.commitment AS commitment FROM aladdin_loans l
       JOIN web3_zk_attestations a ON a.id = l.attestation_id WHERE l.id = ?`,
    row.id,
  );
  return { loan: loanView(loan as LoanRow), anchorHeight: anchorInfo.height };
}

export async function aladdinOverview(env: Env, holderId: string) {
  const risk = await one<RiskRow>(
    env,
    'SELECT * FROM aladdin_risk_metrics WHERE holder_id = ? ORDER BY observed_at DESC LIMIT 1',
    holderId,
  );
  const rows = await all<LoanRow>(
    env,
    `SELECT l.*, a.commitment AS commitment FROM aladdin_loans l
       JOIN web3_zk_attestations a ON a.id = l.attestation_id
      WHERE l.borrower_id = ? ORDER BY l.created_at DESC LIMIT 50`,
    holderId,
  );
  const open = rows.filter((loan) => loan.status === 'OPEN');
  const outstanding = open.reduce((sum, loan) => sum + loan.outstanding_cents, 0);
  const attestations = await one<{ count: number }>(
    env,
    "SELECT COUNT(*) AS count FROM web3_zk_attestations WHERE holder_id = ? AND status = 'ACTIVE'",
    holderId,
  );
  const proofs = await one<{ count: number }>(env, 'SELECT COUNT(*) AS count FROM zk_snark_proofs WHERE holder_id = ?', holderId);
  const anchors = await anchorSummary(env);
  return {
    holderId,
    risk: risk ? riskView(risk) : null,
    policy: {
      minScore: ALADDIN_MIN_SCORE,
      maxVarBps: ALADDIN_MAX_VAR_BPS,
      maxLoanCents: ALADDIN_MAX_LOAN_CENTS,
      maxLoanFormatted: formatBRL(ALADDIN_MAX_LOAN_CENTS),
      circuit: 'NetWorthProof',
      verifier: 'groth16-bn254 (core Node)',
      edgeVerifier: 'attestation+nullifier',
    },
    loans: {
      total: rows.length,
      open: open.length,
      outstandingCents: outstanding,
      outstandingFormatted: formatBRL(outstanding),
      items: rows.slice(0, 10).map((loan) => loanView(loan)),
    },
    attestations: attestations?.count ?? 0,
    proofs: proofs?.count ?? 0,
    anchors,
    generatedAt: nowIso(),
  };
}

// ── CCIP, liquidez e intents ──────────────────────────────────────────────

export async function listLanes(env: Env, status?: string) {
  const rows = status
    ? await all<LaneRow>(env, 'SELECT * FROM ccip_lanes WHERE status = ? ORDER BY created_at ASC', status.toUpperCase())
    : await all<LaneRow>(env, 'SELECT * FROM ccip_lanes ORDER BY created_at ASC');
  return { data: rows.map(laneView) };
}

export async function registerLane(env: Env, actorId: string, input: Record<string, unknown>) {
  const name = requiredText(input.name, 'name', 80);
  const sourceChainId = positiveInt(input.sourceChainId, 'sourceChainId', 2 ** 31 - 1);
  const destChainId = positiveInt(input.destChainId, 'destChainId', 2 ** 31 - 1);
  if (sourceChainId === destChainId) throw invalid('CCIP_CHAIN', 'sourceChainId e destChainId devem diferir.');
  const sourceSelector = decimalSelector(input.sourceSelector, 'sourceSelector');
  const destSelector = decimalSelector(input.destSelector, 'destSelector');
  const router = evmAddress(input.router, 'router');
  const receiver = evmAddress(input.receiver, 'receiver');
  const feeBps = optInt(input.feeBps, 'feeBps', 0, 1_000, 0);
  const maxUnits = positiveInt(input.maxUnits, 'maxUnits', 10 ** 15);
  const id = newId('ccl');
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO ccip_lanes
         (id, name, source_chain_id, dest_chain_id, source_selector, dest_selector, router, receiver,
          fee_bps, max_units, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
    )
      .bind(id, name, sourceChainId, destChainId, sourceSelector, destSelector, router, receiver, feeBps, maxUnits, now)
      .run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'CCIP_LANE_EXISTS', 'Já existe lane para esse par de chains.');
    throw error;
  }
  const anchorInfo = await anchor(env, 'CCIP_LANE_CREATE', 'ccip_lane', id, {
    id,
    sourceChainId,
    destChainId,
    sourceSelector,
    destSelector,
    actorId,
  });
  return { lane: laneView((await one<LaneRow>(env, 'SELECT * FROM ccip_lanes WHERE id = ?', id)) as LaneRow), anchorHeight: anchorInfo.height };
}

export async function listLiquidity(env: Env, filter: { laneId?: string; status?: string }) {
  const clauses: string[] = [];
  const binds: Bind[] = [];
  if (filter.laneId) {
    clauses.push('lane_id = ?');
    binds.push(filter.laneId);
  }
  if (filter.status) {
    clauses.push('status = ?');
    binds.push(filter.status.toUpperCase());
  }
  const rows = await all<LiquidityRow>(
    env,
    `SELECT * FROM ccip_liquidity${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT 200`,
    ...binds,
  );
  return { data: rows.map(liquidityView) };
}

export async function registerLiquidity(env: Env, holderId: string, input: Record<string, unknown>) {
  const laneId = requiredText(input.laneId, 'laneId', 80);
  const lane = await one<LaneRow>(env, 'SELECT * FROM ccip_lanes WHERE id = ?', laneId);
  if (!lane) throw new HttpError(404, 'CCIP_LANE_NOT_FOUND', 'Lane não encontrada.');
  if (lane.status !== 'ACTIVE') throw invalid('CCIP_LANE_PAUSED', 'Lane pausada.');
  const liquiditySymbol = symbol(input.symbol);
  const availableUnits = optInt(input.availableUnits, 'availableUnits', 0, 10 ** 15, 0);
  const rateBps = optInt(input.rateBps, 'rateBps', 0, 2_000, 0);
  const riskTier = String(input.riskTier ?? 'B').toUpperCase();
  if (!['A', 'B', 'C'].includes(riskTier)) throw invalid('CCIP_TIER', 'riskTier deve ser A, B ou C.');
  await ensureUnits(env, liquiditySymbol, holderId, availableUnits, 'CCIP_INSUFFICIENT_UNITS');
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO ccip_liquidity (holder_id, lane_id, symbol, available_units, rate_bps, risk_tier, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
     ON CONFLICT(holder_id, lane_id, symbol) DO UPDATE SET
       available_units = excluded.available_units, rate_bps = excluded.rate_bps,
       risk_tier = excluded.risk_tier, status = 'ACTIVE', updated_at = excluded.updated_at`,
  )
    .bind(holderId, lane.id, liquiditySymbol, availableUnits, rateBps, riskTier, now)
    .run();
  const anchorInfo = await anchor(env, 'CCIP_LIQUIDITY', 'ccip_liquidity', `${holderId}:${lane.id}:${liquiditySymbol}`, {
    holderId,
    laneId: lane.id,
    symbol: liquiditySymbol,
    availableUnits,
    rateBps,
    riskTier,
  });
  return {
    liquidity: liquidityView(
      (await one<LiquidityRow>(
        env,
        'SELECT * FROM ccip_liquidity WHERE holder_id = ? AND lane_id = ? AND symbol = ?',
        holderId,
        lane.id,
        liquiditySymbol,
      )) as LiquidityRow,
    ),
    anchorHeight: anchorInfo.height,
  };
}

async function quoteRows(env: Env, intent: IntentRow, lane: LaneRow) {
  const providers = await all<LiquidityRow>(
    env,
    "SELECT * FROM ccip_liquidity WHERE lane_id = ? AND symbol = ? AND status = 'ACTIVE' AND holder_id <> ? ORDER BY available_units DESC LIMIT 20",
    intent.lane_id,
    intent.symbol,
    intent.holder_id,
  );
  const now = nowIso();
  const created: QuoteRow[] = [];
  for (const provider of providers) {
    const tier = RISK_TIERS[provider.risk_tier] ?? RISK_TIERS.B;
    const destUnits = Math.max(0, Math.floor((intent.amount_units * (10_000 - provider.rate_bps)) / 10_000));
    if (destUnits < intent.min_dest_units || destUnits > provider.available_units) continue;
    const feeCents = Math.min(intent.fee_budget_cents, Math.floor((intent.fee_budget_cents * provider.rate_bps) / 10_000));
    const score = solverScore({
      amountUnits: intent.amount_units,
      destUnits,
      feeCents,
      feeBudgetCents: intent.fee_budget_cents,
      etaSeconds: tier.eta,
      riskBps: tier.riskBps,
    });
    const id = newId('qte');
    try {
      await env.DB.prepare(
        `INSERT INTO crosschain_quotes
           (id, intent_id, solver_id, provider_holder_id, dest_units, fee_cents, eta_seconds, risk_bps, score, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFERED', ?)`,
      )
        .bind(id, intent.id, provider.holder_id, provider.holder_id, destUnits, feeCents, tier.eta, tier.riskBps, score, now)
        .run();
      created.push((await one<QuoteRow>(env, 'SELECT * FROM crosschain_quotes WHERE id = ?', id)) as QuoteRow);
    } catch (error) {
      if (!String(error).includes('UNIQUE')) throw error;
    }
  }
  return created;
}

export async function createIntent(env: Env, holderId: string, input: Record<string, unknown>) {
  const laneId = requiredText(input.laneId, 'laneId', 80);
  const lane = await one<LaneRow>(env, 'SELECT * FROM ccip_lanes WHERE id = ?', laneId);
  if (!lane) throw new HttpError(404, 'CCIP_LANE_NOT_FOUND', 'Lane não encontrada.');
  if (lane.status !== 'ACTIVE') throw invalid('CCIP_LANE_PAUSED', 'Lane pausada.');
  const intentSymbol = symbol(input.symbol);
  const amountUnits = positiveInt(input.amountUnits, 'amountUnits', lane.max_units);
  const minDestUnits = positiveInt(input.minDestUnits, 'minDestUnits', 10 ** 15);
  if (minDestUnits > amountUnits) throw invalid('CCIP_INTENT', 'minDestUnits não pode exceder amountUnits.');
  const feeBudgetCents = optInt(input.feeBudgetCents, 'feeBudgetCents', 0, 10 ** 12, 0);
  const deadlineSeconds = optInt(input.deadlineSeconds, 'deadlineSeconds', 60, 86_400, 3_600);
  await ensureUnits(env, intentSymbol, holderId, amountUnits, 'INTENT_INSUFFICIENT_UNITS');
  const deadline = nowIso(deadlineSeconds * 1000);
  const digest = await intentDigest({
    holderId,
    laneId: lane.id,
    symbol: intentSymbol,
    amountUnits,
    minDestUnits,
    feeBudgetCents,
    deadline,
  });
  const id = newId('int');
  const now = nowIso();
  await env.DB.batch([
    debitUnitsStmt(env, intentSymbol, holderId, amountUnits, now),
    creditUnitsStmt(env, intentSymbol, CCIP_ESCROW_HOLDER, amountUnits, now),
    env.DB.prepare(
      `INSERT INTO crosschain_intents
         (id, holder_id, lane_id, symbol, amount_units, min_dest_units, fee_budget_cents, status,
          selected_quote_id, ai_model, deadline, digest, created_at, updated_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      id,
      holderId,
      lane.id,
      intentSymbol,
      amountUnits,
      minDestUnits,
      feeBudgetCents,
      AI_SOLVER_MODEL,
      deadline,
      digest,
      now,
      now,
    ),
  ]);
  const intent = (await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', id)) as IntentRow;
  const quotes = await quoteRows(env, intent, lane);
  if (quotes.length > 0) {
    await env.DB.prepare("UPDATE crosschain_intents SET status = 'QUOTED', updated_at = ? WHERE id = ?")
      .bind(nowIso(), id)
      .run();
  }
  const anchorInfo = await anchor(env, 'CCIP_INTENT_CREATE', 'crosschain_intent', id, {
    id,
    holderId,
    laneId: lane.id,
    symbol: intentSymbol,
    amountUnits,
    minDestUnits,
    feeBudgetCents,
  });
  const refreshed = (await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', id)) as IntentRow;
  return {
    intent: intentView(refreshed),
    escrow: { holder: CCIP_ESCROW_HOLDER, symbol: intentSymbol, units: amountUnits },
    quotes: quotes
      .sort((a, b) => b.score - a.score)
      .map(quoteView),
    anchorHeight: anchorInfo.height,
  };
}

export async function listIntents(env: Env, holderId: string, status?: string, limit?: number) {
  const rows = status
    ? await all<IntentRow>(
        env,
        'SELECT * FROM crosschain_intents WHERE holder_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
        holderId,
        status.toUpperCase(),
        limitOf(limit),
      )
    : await all<IntentRow>(
        env,
        'SELECT * FROM crosschain_intents WHERE holder_id = ? ORDER BY created_at DESC LIMIT ?',
        holderId,
        limitOf(limit),
      );
  return { data: rows.map(intentView) };
}

export async function getIntent(env: Env, intentId: string, holderId?: string) {
  const row = await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', intentId);
  if (!row) throw new HttpError(404, 'INTENT_NOT_FOUND', 'Intent não encontrada.');
  if (holderId && row.holder_id !== holderId) throw new HttpError(403, 'INTENT_FORBIDDEN', 'Intent de outro titular.');
  const quotes = await all<QuoteRow>(
    env,
    'SELECT * FROM crosschain_quotes WHERE intent_id = ? ORDER BY score DESC',
    row.id,
  );
  const messages = await all<MessageRow>(
    env,
    'SELECT * FROM ccip_messages WHERE intent_id = ? ORDER BY sequence DESC',
    row.id,
  );
  return { intent: intentView(row), quotes: quotes.map(quoteView), messages: messages.map(messageView) };
}

export async function quoteIntent(env: Env, intentId: string, holderId: string, input: Record<string, unknown>) {
  const intent = await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', intentId);
  if (!intent) throw new HttpError(404, 'INTENT_NOT_FOUND', 'Intent não encontrada.');
  if (intent.holder_id !== holderId) throw new HttpError(403, 'INTENT_FORBIDDEN', 'Intent de outro titular.');
  if (intent.status !== 'OPEN' && intent.status !== 'QUOTED') throw new HttpError(409, 'INTENT_CLOSED', 'Intent não aceita cotações.');
  const destUnits = positiveInt(input.destUnits, 'destUnits', 10 ** 15);
  if (destUnits < intent.min_dest_units) throw invalid('CCIP_QUOTE', 'destUnits abaixo do mínimo da intenção.');
  const feeCents = optInt(input.feeCents, 'feeCents', 0, intent.fee_budget_cents, 0);
  const etaSeconds = optInt(input.etaSeconds, 'etaSeconds', 1, 86_400, 60);
  const riskBps = optInt(input.riskBps, 'riskBps', 0, 10_000, 300);
  const score = solverScore({
    amountUnits: intent.amount_units,
    destUnits,
    feeCents,
    feeBudgetCents: intent.fee_budget_cents,
    etaSeconds,
    riskBps,
  });
  const id = newId('qte');
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO crosschain_quotes
         (id, intent_id, solver_id, provider_holder_id, dest_units, fee_cents, eta_seconds, risk_bps, score, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFERED', ?)`,
    )
      .bind(id, intent.id, holderId, holderId, destUnits, feeCents, etaSeconds, riskBps, score, now)
      .run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'CCIP_QUOTE_EXISTS', 'Já existe cotação deste solver.');
    throw error;
  }
  await env.DB.prepare("UPDATE crosschain_intents SET status = 'QUOTED', updated_at = ? WHERE id = ?")
    .bind(now, intent.id)
    .run();
  return {
    quote: quoteView((await one<QuoteRow>(env, 'SELECT * FROM crosschain_quotes WHERE id = ?', id)) as QuoteRow),
    intent: intentView((await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', intent.id)) as IntentRow),
  };
}

export async function selectQuote(env: Env, intentId: string, holderId: string, quoteId?: string) {
  const intent = await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', intentId);
  if (!intent) throw new HttpError(404, 'INTENT_NOT_FOUND', 'Intent não encontrada.');
  if (intent.holder_id !== holderId) throw new HttpError(403, 'INTENT_FORBIDDEN', 'Intent de outro titular.');
  if (intent.status === 'SETTLED' || intent.status === 'CANCELLED' || intent.status === 'EXPIRED') {
    throw new HttpError(409, 'INTENT_CLOSED', 'Intent encerrada.');
  }
  const quotes = await all<QuoteRow>(
    env,
    "SELECT * FROM crosschain_quotes WHERE intent_id = ? AND status = 'OFFERED' ORDER BY score DESC",
    intent.id,
  );
  if (quotes.length === 0) throw new HttpError(404, 'CCIP_QUOTE_MISSING', 'Sem cotações disponíveis.');
  const chosen = quoteId ? quotes.find((quote) => quote.id === quoteId) : quotes[0];
  if (!chosen) throw new HttpError(404, 'CCIP_QUOTE_NOT_FOUND', 'Cotação não encontrada.');
  await env.DB.batch([
    env.DB.prepare("UPDATE crosschain_quotes SET status = 'REJECTED' WHERE intent_id = ? AND id <> ?").bind(intent.id, chosen.id),
    env.DB.prepare("UPDATE crosschain_quotes SET status = 'SELECTED' WHERE id = ?").bind(chosen.id),
    env.DB.prepare("UPDATE crosschain_intents SET selected_quote_id = ?, status = 'QUOTED', updated_at = ? WHERE id = ?").bind(
      chosen.id,
      nowIso(),
      intent.id,
    ),
  ]);
  const anchorInfo = await anchor(env, 'CCIP_QUOTE_SELECT', 'crosschain_quote', chosen.id, {
    intentId: intent.id,
    quoteId: chosen.id,
    score: chosen.score,
  });
  return {
    intent: intentView((await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', intent.id)) as IntentRow),
    quote: quoteView(chosen),
    anchorHeight: anchorInfo.height,
  };
}

export async function executeIntent(env: Env, intentId: string, holderId: string) {
  const intent = await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', intentId);
  if (!intent) throw new HttpError(404, 'INTENT_NOT_FOUND', 'Intent não encontrada.');
  if (intent.holder_id !== holderId) throw new HttpError(403, 'INTENT_FORBIDDEN', 'Intent de outro titular.');
  if (intent.status === 'SETTLED') return getIntent(env, intent.id, holderId);
  if (intent.status === 'CANCELLED') throw new HttpError(409, 'INTENT_CANCELLED', 'Intent cancelada.');
  if (!intent.selected_quote_id) throw invalid('INTENT_QUOTE_REQUIRED', 'Selecione uma cotação antes de executar.');
  if (Date.parse(intent.deadline) <= Date.now()) throw invalid('INTENT_EXPIRED', 'Intent expirada.');
  const quote = await one<QuoteRow>(env, 'SELECT * FROM crosschain_quotes WHERE id = ?', intent.selected_quote_id);
  if (!quote) throw new HttpError(404, 'CCIP_QUOTE_NOT_FOUND', 'Cotação selecionada ausente.');
  const lane = await one<LaneRow>(env, 'SELECT * FROM ccip_lanes WHERE id = ?', intent.lane_id);
  if (!lane) throw new HttpError(404, 'CCIP_LANE_NOT_FOUND', 'Lane ausente.');
  const liquidity = await one<LiquidityRow>(
    env,
    'SELECT * FROM ccip_liquidity WHERE holder_id = ? AND lane_id = ? AND symbol = ?',
    quote.provider_holder_id,
    intent.lane_id,
    intent.symbol,
  );
  if (!liquidity || liquidity.status !== 'ACTIVE' || liquidity.available_units < quote.dest_units) {
    throw invalid('CCIP_LIQUIDITY_CHANGED', 'Liquidez do solver mudou; gere novas cotações.');
  }
  await ensureUnits(env, intent.symbol, quote.provider_holder_id, quote.dest_units, 'CCIP_INSUFFICIENT_UNITS');
  const now = nowIso();
  const seqRow = await one<{ value: number }>(
    env,
    "UPDATE web3_sequences SET value = value + 1 WHERE name = 'ccip' RETURNING value",
  );
  if (!seqRow) throw new Error('Sequência CCIP ausente.');
  const sequence = seqRow.value;
  const messageId = await ccipMessageId({
    laneId: lane.id,
    sequence,
    intentId: intent.id,
    receiver: lane.receiver,
    symbol: intent.symbol,
    amountUnits: intent.amount_units,
  });
  const messageRowId = newId('ccm');
  const feeStatement =
    quote.fee_cents > 0 ? await cashStatement(env, holderId, SYSTEM_USER_ID, quote.fee_cents, `Taxa intent ${intent.id}`, now) : null;
  const stmts: D1PreparedStatement[] = [
    debitUnitsStmt(env, intent.symbol, CCIP_ESCROW_HOLDER, intent.amount_units, now),
    creditUnitsStmt(env, intent.symbol, quote.provider_holder_id, intent.amount_units, now),
    debitUnitsStmt(env, intent.symbol, quote.provider_holder_id, quote.dest_units, now),
    creditUnitsStmt(env, intent.symbol, holderId, quote.dest_units, now),
    env.DB.prepare(
      "UPDATE ccip_liquidity SET available_units = available_units - ?, updated_at = ? WHERE holder_id = ? AND lane_id = ? AND symbol = ?",
    ).bind(quote.dest_units, now, quote.provider_holder_id, intent.lane_id, intent.symbol),
    env.DB.prepare(
      "UPDATE crosschain_intents SET status = 'SETTLED', updated_at = ?, settled_at = ? WHERE id = ?",
    ).bind(now, now, intent.id),
    env.DB.prepare(
      `INSERT INTO ccip_messages
         (id, intent_id, quote_id, lane_id, message_id, sequence, sender_id, receiver, symbol,
          amount_units, dest_units, fee_cents, status, digest, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SETTLED', ?, ?, ?)`,
    ).bind(
      messageRowId,
      intent.id,
      quote.id,
      lane.id,
      messageId,
      sequence,
      holderId,
      lane.receiver,
      intent.symbol,
      intent.amount_units,
      quote.dest_units,
      quote.fee_cents,
      messageId,
      now,
      now,
    ),
  ];
  if (feeStatement) stmts.push(feeStatement.stmt);
  try {
    await env.DB.batch(stmts);
  } catch (error) {
    const message = String(error);
    if (message.includes('UNIQUE')) throw new HttpError(409, 'CCIP_MESSAGE_REPLAY', 'Mensagem CCIP duplicada.');
    if (message.includes('CHECK') || message.includes('constraint')) {
      throw invalid('CCIP_INSUFFICIENT_UNITS', 'Liquidez ou saldo de unidades insuficiente.');
    }
    throw error;
  }
  const anchorInfo = await anchor(env, 'CCIP_INTENT_SETTLED', 'ccip_message', messageRowId, {
    intentId: intent.id,
    messageId,
    sequence,
    destUnits: quote.dest_units,
    feeCents: quote.fee_cents,
  });
  await queueEvent(env, {
    topic: 'ccip.intent.settled',
    type: 'IntentLiquidada',
    payload: { intentId: intent.id, messageId, sequence, destUnits: quote.dest_units, anchorHeight: anchorInfo.height },
  });
  const message = (await one<MessageRow>(env, 'SELECT * FROM ccip_messages WHERE id = ?', messageRowId)) as MessageRow;
  return {
    intent: intentView((await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', intent.id)) as IntentRow),
    quote: quoteView(quote),
    message: messageView(message),
    anchorHeight: anchorInfo.height,
  };
}

export async function cancelIntent(env: Env, intentId: string, holderId: string) {
  const intent = await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', intentId);
  if (!intent) throw new HttpError(404, 'INTENT_NOT_FOUND', 'Intent não encontrada.');
  if (intent.holder_id !== holderId) throw new HttpError(403, 'INTENT_FORBIDDEN', 'Intent de outro titular.');
  if (intent.status === 'SETTLED') throw new HttpError(409, 'INTENT_SETTLED', 'Intent já liquidada.');
  if (intent.status === 'CANCELLED') return getIntent(env, intent.id, holderId);
  const now = nowIso();
  await env.DB.batch([
    debitUnitsStmt(env, intent.symbol, CCIP_ESCROW_HOLDER, intent.amount_units, now),
    creditUnitsStmt(env, intent.symbol, holderId, intent.amount_units, now),
    env.DB.prepare("UPDATE crosschain_intents SET status = 'CANCELLED', updated_at = ? WHERE id = ?").bind(now, intent.id),
    env.DB.prepare("UPDATE crosschain_quotes SET status = 'REJECTED' WHERE intent_id = ? AND status = 'OFFERED'").bind(intent.id),
  ]);
  const anchorInfo = await anchor(env, 'CCIP_INTENT_CANCEL', 'crosschain_intent', intent.id, {
    intentId: intent.id,
    holderId,
  });
  return {
    intent: intentView((await one<IntentRow>(env, 'SELECT * FROM crosschain_intents WHERE id = ?', intent.id)) as IntentRow),
    anchorHeight: anchorInfo.height,
  };
}

export async function listMessages(env: Env, laneId?: string, limit?: number) {
  const rows = laneId
    ? await all<MessageRow>(
        env,
        'SELECT * FROM ccip_messages WHERE lane_id = ? ORDER BY sequence DESC LIMIT ?',
        laneId,
        limitOf(limit),
      )
    : await all<MessageRow>(env, 'SELECT * FROM ccip_messages ORDER BY sequence DESC LIMIT ?', limitOf(limit));
  return { data: rows.map(messageView) };
}

export async function crosschainOverview(env: Env, holderId: string) {
  const lanes = await one<{ count: number }>(env, "SELECT COUNT(*) AS count FROM ccip_lanes WHERE status = 'ACTIVE'");
  const liquidity = await one<{ count: number; units: number | null }>(
    env,
    "SELECT COUNT(*) AS count, SUM(available_units) AS units FROM ccip_liquidity WHERE status = 'ACTIVE'",
  );
  const intents = await all<IntentRow>(
    env,
    'SELECT * FROM crosschain_intents WHERE holder_id = ? ORDER BY created_at DESC LIMIT 50',
    holderId,
  );
  const settled = intents.filter((intent) => intent.status === 'SETTLED');
  return {
    holderId,
    lanes: lanes?.count ?? 0,
    liquidity: { providers: liquidity?.count ?? 0, availableUnits: liquidity?.units ?? 0 },
    intents: {
      total: intents.length,
      open: intents.filter((intent) => intent.status === 'OPEN' || intent.status === 'QUOTED').length,
      settled: settled.length,
      items: intents.slice(0, 10).map(intentView),
    },
    ai: { model: AI_SOLVER_MODEL, priceWeight: 0.45, feeWeight: 0.2, speedWeight: 0.2, riskWeight: 0.15 },
    anchors: await anchorSummary(env),
    generatedAt: nowIso(),
  };
}

// ── Visão consolidada ─────────────────────────────────────────────────────

export async function web3Overview(env: Env, holderId: string) {
  const counts = await one<{
    networks: number;
    feeds: number;
    offers: number;
    openOffers: number;
    trades: number;
    cashVolume: number;
    agro: number;
    agroOutstanding: number;
    attestations: number;
    activeAttestations: number;
    verifications: number;
    sessions: number;
    activeSessions: number;
    budgets: number;
    budgetCap: number;
    budgetSpent: number;
  }>(
    env,
    `SELECT
       (SELECT COUNT(*) FROM web3_networks) AS networks,
       (SELECT COUNT(*) FROM web3_oracle_feeds) AS feeds,
       (SELECT COUNT(*) FROM web3_dvp_offers) AS offers,
       (SELECT COUNT(*) FROM web3_dvp_offers WHERE status = 'OPEN') AS openOffers,
       (SELECT COUNT(*) FROM web3_dvp_trades) AS trades,
       (SELECT COALESCE(SUM(cash_cents), 0) FROM web3_dvp_trades) AS cashVolume,
       (SELECT COUNT(*) FROM web3_agro_contracts WHERE status = 'OPEN') AS agro,
       (SELECT COALESCE(SUM(outstanding_cents), 0) FROM web3_agro_contracts WHERE status = 'OPEN') AS agroOutstanding,
       (SELECT COUNT(*) FROM web3_zk_attestations WHERE holder_id = ?) AS attestations,
       (SELECT COUNT(*) FROM web3_zk_attestations WHERE holder_id = ? AND status = 'ACTIVE') AS activeAttestations,
       (SELECT COUNT(*) FROM web3_zk_nullifiers n JOIN web3_zk_attestations a ON a.id = n.attestation_id WHERE a.holder_id = ?) AS verifications,
       (SELECT COUNT(*) FROM web3_agent_sessions WHERE holder_id = ?) AS sessions,
       (SELECT COUNT(*) FROM web3_agent_sessions WHERE holder_id = ? AND status = 'ACTIVE') AS activeSessions,
       (SELECT COUNT(*) FROM web3_paymaster_budgets WHERE holder_id = ?) AS budgets,
       (SELECT COALESCE(SUM(cap_cents), 0) FROM web3_paymaster_budgets WHERE holder_id = ?) AS budgetCap,
       (SELECT COALESCE(SUM(spent_cents), 0) FROM web3_paymaster_budgets WHERE holder_id = ?) AS budgetSpent`,
    holderId,
    holderId,
    holderId,
    holderId,
    holderId,
    holderId,
    holderId,
    holderId,
  );
  const holdings = await all<HoldingRow>(
    env,
    'SELECT * FROM web3_holdings WHERE holder_id = ? ORDER BY asset_symbol ASC',
    holderId,
  );
  const anchors = await anchorSummary(env);
  const chain = await verifyAnchorChainEdge(env);
  const risk = await one<RiskRow>(
    env,
    'SELECT * FROM aladdin_risk_metrics WHERE holder_id = ? ORDER BY observed_at DESC LIMIT 1',
    holderId,
  );
  return {
    holderId,
    networks: counts?.networks ?? 0,
    feeds: counts?.feeds ?? 0,
    holdings: holdings.map((row) => ({
      symbol: row.asset_symbol,
      units: row.units,
      updatedAt: row.updated_at,
    })),
    dvp: {
      offers: counts?.offers ?? 0,
      openOffers: counts?.openOffers ?? 0,
      trades: counts?.trades ?? 0,
      cashVolumeCents: counts?.cashVolume ?? 0,
      cashVolumeFormatted: formatBRL(counts?.cashVolume ?? 0),
    },
    agro: {
      contracts: counts?.agro ?? 0,
      outstandingCents: counts?.agroOutstanding ?? 0,
      outstandingFormatted: formatBRL(counts?.agroOutstanding ?? 0),
    },
    zk: {
      attestations: counts?.attestations ?? 0,
      active: counts?.activeAttestations ?? 0,
      verifications: counts?.verifications ?? 0,
      groth16: 'core-node',
    },
    agents: {
      sessions: counts?.sessions ?? 0,
      activeSessions: counts?.activeSessions ?? 0,
    },
    paymaster: {
      budgets: counts?.budgets ?? 0,
      capCents: counts?.budgetCap ?? 0,
      capFormatted: formatBRL(counts?.budgetCap ?? 0),
      spentCents: counts?.budgetSpent ?? 0,
      spentFormatted: formatBRL(counts?.budgetSpent ?? 0),
    },
    aladdin: {
      risk: risk ? riskView(risk) : null,
      minScore: ALADDIN_MIN_SCORE,
      maxVarBps: ALADDIN_MAX_VAR_BPS,
      maxLoanCents: ALADDIN_MAX_LOAN_CENTS,
      maxLoanFormatted: formatBRL(ALADDIN_MAX_LOAN_CENTS),
    },
    anchors,
    integrity: chain,
    generatedAt: nowIso(),
  };
}

export async function capabilities(env: Env) {
  const counts = await one<{ networks: number; feeds: number; lanes: number; offers: number; providers: number }>(
    env,
    `SELECT
       (SELECT COUNT(*) FROM web3_networks) AS networks,
       (SELECT COUNT(*) FROM web3_oracle_feeds) AS feeds,
       (SELECT COUNT(*) FROM ccip_lanes) AS lanes,
       (SELECT COUNT(*) FROM web3_dvp_offers WHERE status = 'OPEN') AS offers,
       (SELECT COUNT(*) FROM ccip_liquidity WHERE status = 'ACTIVE') AS providers`,
  );
  return {
    service: 'xpartner-bank-edge',
    layer: 'web3',
    capabilities: {
      dvp: true,
      regulatedRwa: true,
      agroOracle: true,
      zkAttestations: true,
      zkGroth16: 'core-node',
      accountAbstraction: true,
      paymaster: true,
      aladdinRisk: true,
      aladdinCredit: true,
      ccipModel: true,
      intents: true,
      p2pLiquidity: true,
    },
    networks: counts?.networks ?? 0,
    feeds: counts?.feeds ?? 0,
    lanes: counts?.lanes ?? 0,
    openOffers: counts?.offers ?? 0,
    liquidityProviders: counts?.providers ?? 0,
    ledger: 'D1 + trigger de dupla entrada',
    verifier: 'attestation+nullifier no edge; Groth16/BN254 no core Node',
    generatedAt: nowIso(),
  };
}
