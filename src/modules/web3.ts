import type { Db } from '../kernel/db.ts';
import { addSeconds, audit, nowIso, tx } from '../kernel/db.ts';
import { appendAnchor, latestAnchor } from '../kernel/anchor.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { assertNonEmptyString, constantTimeEqualHex, sha256Hex } from '../kernel/crypto.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId, randomToken } from '../kernel/ids.ts';
import { bps, formatBRL } from '../kernel/money.ts';
import { listBalances, postGroup } from '../domain/ledger.ts';
import type { EntryInput } from '../domain/ledger.ts';
import {
  AGRO_ESCROW_HOLDER,
  attestationHash,
  dvpOfferDigest,
  loanToValueBps,
  normalizeWeb3Symbol,
  nullifierFor,
  optionalAddress,
  oracleCentsPerUnit,
  sessionKeyHash,
  todayEpoch,
} from '../domain/web3.ts';

const NETWORK_KINDS = ['APPCHAIN', 'SUBNET', 'L2', 'L1'] as const;
const ORACLE_SOURCES = ['CHAINLINK', 'BAND', 'XPARTNER'] as const;
const DVP_KINDS = ['CASH_FOR_TOKEN', 'TOKEN_FOR_TOKEN'] as const;
const PREDICATES = ['GTE', 'LTE', 'EQ'] as const;
const MAX_NOTIONAL_CENTS = 100_000_000;
const MAX_PRICE_UNITS = 1_000_000_000_000;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

type NetworkKind = (typeof NETWORK_KINDS)[number];
type OracleSource = (typeof ORACLE_SOURCES)[number];
type DvpKind = (typeof DVP_KINDS)[number];
type Predicate = (typeof PREDICATES)[number];
type Decision = 'APPROVE' | 'REVIEW' | 'BLOCK';

function positiveInt(value: unknown, field: string, max = MAX_NOTIONAL_CENTS): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw Errors.validation(`${field} deve ser um inteiro positivo.`);
  }
  return value;
}

function boundedBps(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw Errors.validation(`${field} deve estar entre 0 e ${max} basis points.`);
  }
  return value;
}

function boundedInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw Errors.validation(`${field} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return value;
}

function optionalText(value: unknown, field: string, max = 500): string | null {
  if (value === undefined || value === null || value === '') return null;
  return assertNonEmptyString(value, field, max);
}

function holderId(value: unknown, field = 'id'): string {
  const id = assertNonEmptyString(value, field, 80);
  if (!/^[A-Za-z0-9_.:@-]{3,80}$/.test(id)) throw Errors.validation(`${field} contém caracteres inválidos.`);
  return id;
}

function decodeJsonList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

interface NetworkRow {
  id: string;
  name: string;
  chain_id: number;
  kind: NetworkKind;
  rpc_url: string;
  explorer_url: string | null;
  native_symbol: string;
  bridge_contract: string | null;
  token_contract: string | null;
  dvp_contract: string | null;
  paymaster_contract: string | null;
  finality_seconds: number;
  governance: string;
  status: 'ACTIVE' | 'PAUSED';
  created_at: string;
}

function publicNetwork(row: NetworkRow) {
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

interface FeedRow {
  symbol: string;
  source: OracleSource;
  decimals: number;
  max_age_seconds: number;
  status: 'ACTIVE' | 'PAUSED';
  created_at: string;
  updated_at: string;
}

function publicFeed(row: FeedRow) {
  return {
    symbol: row.symbol,
    source: row.source,
    decimals: row.decimals,
    maxAgeSeconds: row.max_age_seconds,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

interface OfferRow {
  id: string;
  network_id: string;
  maker_id: string;
  taker_id: string | null;
  kind: DvpKind;
  sell_symbol: string;
  sell_units: number;
  buy_symbol: string | null;
  buy_units: number | null;
  cash_cents: number;
  fee_bps: number;
  nonce: string;
  digest: string;
  expires_at: string;
  status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
  created_at: string;
  settled_at: string | null;
}

function publicOffer(row: OfferRow) {
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
  tx_digest: string;
  anchor_height: number | null;
  created_at: string;
}

function publicTrade(row: TradeRow) {
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
    txDigest: row.tx_digest,
    anchorHeight: row.anchor_height,
    createdAt: row.created_at,
  };
}

interface AgroRow {
  id: string;
  network_id: string;
  merchant_id: string;
  collateral_symbol: string;
  collateral_units: number;
  principal_cents: number;
  outstanding_cents: number;
  interest_bps: number;
  ltv_bps: number;
  liquidation_ltv_bps: number;
  liquidation_bonus_bps: number;
  oracle_symbol: string;
  status: 'OPEN' | 'REPAID' | 'LIQUIDATED';
  due_at: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function publicAgro(row: AgroRow, priceCents?: number) {
  const rawCollateralValue = priceCents === undefined ? null : row.collateral_units * priceCents;
  const collateralValueCents =
    rawCollateralValue !== null && Number.isSafeInteger(rawCollateralValue) ? rawCollateralValue : null;
  return {
    id: row.id,
    networkId: row.network_id,
    merchantId: row.merchant_id,
    collateralSymbol: row.collateral_symbol,
    collateralUnits: row.collateral_units,
    principalCents: row.principal_cents,
    principalFormatted: formatBRL(row.principal_cents),
    outstandingCents: row.outstanding_cents,
    outstandingFormatted: formatBRL(row.outstanding_cents),
    interestBps: row.interest_bps,
    ltvBps: row.ltv_bps,
    liquidationLtvBps: row.liquidation_ltv_bps,
    liquidationBonusBps: row.liquidation_bonus_bps,
    oracleSymbol: row.oracle_symbol,
    oracleCentsPerUnit: priceCents ?? null,
    collateralValueCents,
    collateralValueFormatted: collateralValueCents === null ? null : formatBRL(collateralValueCents),
    currentLtvBps: collateralValueCents === null ? null : loanToValueBps(row.outstanding_cents, collateralValueCents),
    status: row.status,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

interface AttestationRow {
  id: string;
  commitment: string;
  claim_type: string;
  predicate: Predicate;
  threshold: number;
  issuer: string;
  attestation_hash: string;
  expires_at: string;
  status: 'ACTIVE' | 'REVOKED';
  created_at: string;
}

function publicAttestation(row: AttestationRow) {
  return {
    id: row.id,
    commitment: row.commitment,
    claimType: row.claim_type,
    predicate: row.predicate,
    threshold: row.threshold,
    issuer: row.issuer,
    attestationHash: row.attestation_hash,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

interface SessionRow {
  id: string;
  policy_id: string;
  merchant_id: string;
  network_id: string;
  agent: string;
  key_hash: string;
  allowed_selectors: string;
  spend_cap_cents: number;
  spent_cents: number;
  expires_at: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  created_at: string;
  revoked_at: string | null;
}

function publicSession(row: SessionRow) {
  return {
    id: row.id,
    policyId: row.policy_id,
    merchantId: row.merchant_id,
    networkId: row.network_id,
    agent: row.agent,
    allowedSelectors: decodeJsonList(row.allowed_selectors),
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

interface PolicyRow {
  id: string;
  merchant_id: string;
  name: string;
  allowed_symbols: string;
  max_notional_cents: number;
  daily_limit_cents: number;
  human_approval_above_cents: number;
  status: 'ACTIVE' | 'PAUSED';
  created_at: string;
}

interface BudgetRow {
  id: string;
  merchant_id: string;
  network_id: string;
  label: string;
  cap_cents: number;
  spent_cents: number;
  per_op_max_cents: number;
  status: 'ACTIVE' | 'PAUSED';
  created_at: string;
  updated_at: string;
}

function publicBudget(row: BudgetRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
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
    updatedAt: row.updated_at,
  };
}

interface DecisionRow {
  id: string;
  policy_id: string;
  merchant_id: string;
  agent: string;
  action: string;
  symbol: string;
  notional_cents: number;
  decision: Decision;
  reasons: string;
  anchor_height: number | null;
  created_at: string;
}

interface TokenAssetRow {
  id: string;
  symbol: string;
  status: string;
  max_units: number;
  supply_units: number;
}

export class Web3Hub {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ── Redes / AppChains ────────────────────────────────────────────────────

  registerNetwork(input: {
    name: string;
    chainId: number;
    kind: string;
    rpcUrl: string;
    explorerUrl?: string;
    nativeSymbol?: string;
    bridgeContract?: string;
    tokenContract?: string;
    dvpContract?: string;
    paymasterContract?: string;
    finalitySeconds?: number;
    governance?: string;
  }) {
    const name = assertNonEmptyString(input.name, 'name', 120);
    const chainId = positiveInt(input.chainId, 'chainId', 2_147_483_647);
    const kind = String(input.kind ?? '').toUpperCase() as NetworkKind;
    if (!NETWORK_KINDS.includes(kind)) throw Errors.validation('kind deve ser APPCHAIN, SUBNET, L2 ou L1.');
    const rpcUrl = assertNonEmptyString(input.rpcUrl, 'rpcUrl', 300);
    if (!/^https?:\/\/[^\s]+$/i.test(rpcUrl)) throw Errors.validation('rpcUrl deve ser uma URL http(s) válida.');
    const explorerUrl = optionalText(input.explorerUrl, 'explorerUrl', 300);
    if (explorerUrl && !/^https?:\/\/[^\s]+$/i.test(explorerUrl)) {
      throw Errors.validation('explorerUrl deve ser uma URL http(s) válida.');
    }
    const nativeSymbol = input.nativeSymbol ? normalizeWeb3Symbol(input.nativeSymbol, 'nativeSymbol') : 'BRLT';
    const contracts: Record<string, string | null> = {
      bridge: optionalAddress(input.bridgeContract, 'bridgeContract'),
      token: optionalAddress(input.tokenContract, 'tokenContract'),
      dvp: optionalAddress(input.dvpContract, 'dvpContract'),
      paymaster: optionalAddress(input.paymasterContract, 'paymasterContract'),
    };
    const finalitySeconds =
      input.finalitySeconds === undefined ? 2 : positiveInt(input.finalitySeconds, 'finalitySeconds', 3600);
    const governance = input.governance
      ? assertNonEmptyString(input.governance, 'governance', 120)
      : 'XPARTNER_COUNCIL';
    const id = newId('net');
    const now = nowIso();

    return tx(this.db, () => {
      if (this.db.prepare('SELECT 1 AS found FROM web3_networks WHERE chain_id = ?').get(chainId)) {
        throw Errors.conflict('chainId já registrado.');
      }
      this.db
        .prepare(
          `INSERT INTO web3_networks
             (id, name, chain_id, kind, rpc_url, explorer_url, native_symbol, bridge_contract, token_contract,
              dvp_contract, paymaster_contract, finality_seconds, governance, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        )
        .run(
          id,
          name,
          chainId,
          kind,
          rpcUrl,
          explorerUrl,
          nativeSymbol,
          contracts.bridge,
          contracts.token,
          contracts.dvp,
          contracts.paymaster,
          finalitySeconds,
          governance,
          now,
        );
      const anchor = appendAnchor(this.db, { type: 'WEB3_NETWORK_REGISTERED', networkId: id, chainId, kind }, now);
      audit(this.db, 'web3', 'WEB3_NETWORK_REGISTERED', id, { chainId, kind, governance });
      return { network: publicNetwork(this.networkRow(id)), anchorHeight: anchor.height };
    });
  }

  listNetworks(status?: string) {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM web3_networks WHERE status = ? ORDER BY chain_id ASC').all(status.toUpperCase())
        : this.db.prepare('SELECT * FROM web3_networks ORDER BY chain_id ASC').all()
    ) as unknown as NetworkRow[];
    return rows.map(publicNetwork);
  }

  getNetwork(idOrChainId: string) {
    return publicNetwork(this.networkRow(idOrChainId));
  }

  // ── Oráculo com staleness ───────────────────────────────────────────────

  registerFeed(input: {
    symbol: string;
    source: string;
    decimals?: number;
    maxAgeSeconds?: number;
  }) {
    const symbol = normalizeWeb3Symbol(input.symbol);
    const source = String(input.source ?? 'XPARTNER').toUpperCase() as OracleSource;
    if (!ORACLE_SOURCES.includes(source)) throw Errors.validation('source deve ser CHAINLINK, BAND ou XPARTNER.');
    const decimals = input.decimals === undefined ? 2 : boundedInt(input.decimals, 'decimals', 0, 8);
    const maxAgeSeconds =
      input.maxAgeSeconds === undefined ? 3600 : positiveInt(input.maxAgeSeconds, 'maxAgeSeconds', 604_800);
    const now = nowIso();

    return tx(this.db, () => {
      if (this.db.prepare('SELECT 1 AS found FROM web3_oracle_feeds WHERE symbol = ?').get(symbol)) {
        throw Errors.conflict('Feed de oráculo já registrado.');
      }
      this.db
        .prepare(
          `INSERT INTO web3_oracle_feeds (symbol, source, decimals, max_age_seconds, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .run(symbol, source, decimals, maxAgeSeconds, now, now);
      const anchor = appendAnchor(this.db, { type: 'WEB3_ORACLE_FEED', symbol, source, decimals, maxAgeSeconds }, now);
      audit(this.db, 'web3', 'WEB3_ORACLE_FEED', symbol, { source, decimals, maxAgeSeconds });
      return { feed: publicFeed(this.feedRow(symbol)), anchorHeight: anchor.height };
    });
  }

  listFeeds() {
    const rows = this.db.prepare('SELECT * FROM web3_oracle_feeds ORDER BY symbol ASC').all() as unknown as FeedRow[];
    return rows.map((row) => {
      const latest = this.latestPriceRow(row.symbol);
      return {
        ...publicFeed(row),
        latest: latest
          ? {
              priceUnits: latest.price_units,
              centsPerUnit: oracleCentsPerUnit(latest.price_units, row.decimals),
              round: latest.round_id,
              source: latest.source,
              publishedAt: latest.published_at,
            }
          : null,
      };
    });
  }

  publishPrice(input: { symbol: string; priceUnits: number; source?: string; publishedAt?: string }) {
    const symbol = normalizeWeb3Symbol(input.symbol);
    const priceUnits = positiveInt(input.priceUnits, 'priceUnits', MAX_PRICE_UNITS);
    const now = nowIso();
    const publishedAt = input.publishedAt ? this.isoDateOrThrow(input.publishedAt, 'publishedAt') : now;

    return tx(this.db, () => {
      const feed = this.feedRow(symbol);
      if (feed.status !== 'ACTIVE') throw Errors.conflict('Feed de oráculo pausado.');
      const source = input.source ? String(input.source).toUpperCase() : feed.source;
      if (!ORACLE_SOURCES.includes(source as OracleSource)) throw Errors.validation('source inválido.');
      const last = this.db
        .prepare('SELECT COALESCE(MAX(round_id), 0) AS round FROM web3_oracle_prices WHERE symbol = ?')
        .get(symbol) as { round: number };
      const round = last.round + 1;
      const id = newId('orp');
      this.db
        .prepare(
          `INSERT INTO web3_oracle_prices (id, symbol, price_units, round_id, source, published_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, symbol, priceUnits, round, source, publishedAt, now);
      const anchor = appendAnchor(this.db, { type: 'WEB3_ORACLE_PRICE', symbol, priceUnits, round, source }, now);
      const centsPerUnit = oracleCentsPerUnit(priceUnits, feed.decimals);
      enqueueEvent(this.db, {
        topic: 'web3.oracle.price',
        type: 'PrecoOracle',
        key: symbol,
        payload: { symbol, priceUnits, centsPerUnit, round, source, anchorHeight: anchor.height },
      });
      audit(this.db, 'oracle', 'WEB3_ORACLE_PRICE', symbol, { priceUnits, round, source });
      return {
        price: {
          id,
          symbol,
          priceUnits,
          centsPerUnit,
          centsPerUnitFormatted: formatBRL(centsPerUnit),
          round,
          source,
          publishedAt,
          anchorHeight: anchor.height,
        },
      };
    });
  }

  readPrice(symbolInput: string, nowMs: number = Date.now()) {
    const symbol = normalizeWeb3Symbol(symbolInput);
    const feed = this.feedRow(symbol);
    if (feed.status !== 'ACTIVE') throw new AppError('ORACLE_PAUSED', 'Feed de oráculo pausado.', 422);
    const latest = this.latestPriceRow(symbol);
    if (!latest) throw new AppError('ORACLE_MISSING', 'Sem preço publicado para o feed.', 422);
    const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(latest.published_at)) / 1000));
    if (ageSeconds > feed.max_age_seconds) {
      throw new AppError('ORACLE_STALE', `Preço do oráculo ${symbol} está defasado (${ageSeconds}s).`, 422, {
        symbol,
        ageSeconds,
        maxAgeSeconds: feed.max_age_seconds,
        publishedAt: latest.published_at,
      });
    }
    const centsPerUnit = oracleCentsPerUnit(latest.price_units, feed.decimals);
    return {
      symbol,
      source: latest.source,
      decimals: feed.decimals,
      priceUnits: latest.price_units,
      centsPerUnit,
      centsPerUnitFormatted: formatBRL(centsPerUnit),
      round: latest.round_id,
      publishedAt: latest.published_at,
      ageSeconds,
      maxAgeSeconds: feed.max_age_seconds,
    };
  }

  priceSnapshot(symbol: string, nowMs: number = Date.now()): number | undefined {
    try {
      return this.readPrice(symbol, nowMs).centsPerUnit;
    } catch {
      return undefined;
    }
  }

  // ── DVP atômico ──────────────────────────────────────────────────────────

  createOffer(input: {
    networkId: string;
    makerId: string;
    takerId?: string;
    kind: string;
    sellSymbol: string;
    sellUnits: number;
    buySymbol?: string;
    buyUnits?: number;
    cashCents?: number;
    feeBps?: number;
    nonce?: string;
    expiresInSeconds?: number;
    now?: number;
  }) {
    const maker = holderId(input.makerId, 'makerId');
    this.ensureMerchant(maker);
    const taker = input.takerId ? holderId(input.takerId, 'takerId') : null;
    if (taker) this.ensureMerchant(taker);
    if (taker === maker) throw Errors.validation('Maker e taker devem ser diferentes.');
    const kind = String(input.kind ?? '').toUpperCase() as DvpKind;
    if (!DVP_KINDS.includes(kind)) throw Errors.validation('kind deve ser CASH_FOR_TOKEN ou TOKEN_FOR_TOKEN.');
    const sellSymbol = normalizeWeb3Symbol(input.sellSymbol, 'sellSymbol');
    const sellUnits = positiveInt(input.sellUnits, 'sellUnits', 1_000_000_000_000);
    const feeBps = boundedBps(input.feeBps ?? 0, 'feeBps', 1000);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    const seconds = input.expiresInSeconds === undefined ? 3600 : positiveInt(input.expiresInSeconds, 'expiresInSeconds', 604_800);
    if (seconds < 60) throw Errors.validation('expiresInSeconds mínimo é 60.');
    const expiresAt = addSeconds(now, seconds);
    const nonce = input.nonce ? assertNonEmptyString(input.nonce, 'nonce', 64) : randomToken(12);

    let cashCents = 0;
    let buySymbol: string | null = null;
    let buyUnits: number | null = null;
    if (kind === 'CASH_FOR_TOKEN') {
      cashCents = positiveInt(input.cashCents, 'cashCents', MAX_NOTIONAL_CENTS);
      if (input.buySymbol || input.buyUnits) {
        throw Errors.validation('Oferta cash-for-token não aceita buySymbol/buyUnits.');
      }
    } else {
      buySymbol = normalizeWeb3Symbol(input.buySymbol, 'buySymbol');
      if (buySymbol === sellSymbol) throw Errors.validation('Ativos da oferta devem ser diferentes.');
      buyUnits = positiveInt(input.buyUnits, 'buyUnits', 1_000_000_000_000);
      if (input.cashCents) throw Errors.validation('Oferta token-for-token não aceita cashCents.');
      if (feeBps !== 0) throw Errors.validation('feeBps só se aplica à perna em dinheiro.');
    }

    const network = this.networkRow(input.networkId);
    if (network.status !== 'ACTIVE') throw Errors.conflict('Rede pausada.');
    if (!network.dvp_contract) {
      throw new AppError('WEB3_CONTRACT', 'Rede sem contrato DVP registrado.', 422);
    }
    const digest = dvpOfferDigest(
      { chainId: network.chain_id, verifyingContract: network.dvp_contract },
      { maker, taker, sellSymbol, sellUnits, buySymbol, buyUnits, cashCents, feeBps, nonce, expiresAt },
    );

    return tx(this.db, () => {
      const sellAsset = this.tokenAsset(sellSymbol);
      if (this.holdingUnits(sellAsset.id, maker) < sellUnits) {
        throw new AppError('DVP_INSUFFICIENT_UNITS', 'Maker não possui as unidades ofertadas.', 422);
      }
      if (this.db.prepare('SELECT 1 AS found FROM web3_dvp_offers WHERE maker_id = ? AND nonce = ?').get(maker, nonce)) {
        throw Errors.conflict('Nonce de oferta já utilizado pelo maker.');
      }
      const id = newId('dvp');
      this.db
        .prepare(
          `INSERT INTO web3_dvp_offers
             (id, network_id, maker_id, taker_id, kind, sell_symbol, sell_units, buy_symbol, buy_units, cash_cents,
              fee_bps, nonce, digest, expires_at, status, created_at, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL)`,
        )
        .run(
          id,
          network.id,
          maker,
          taker,
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
        );
      const anchor = appendAnchor(
        this.db,
        { type: 'WEB3_DVP_OFFER', offerId: id, networkId: network.id, maker, kind, sellSymbol, sellUnits, digest },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'web3.dvp.offer',
        type: 'OfertaDVP',
        key: maker,
        payload: { offerId: id, networkId: network.id, kind, sellSymbol, sellUnits, cashCents, digest, anchorHeight: anchor.height },
      });
      audit(this.db, maker, 'WEB3_DVP_OFFER', id, { kind, sellSymbol, sellUnits, cashCents });
      return { offer: publicOffer(this.offerRow(id)), anchorHeight: anchor.height };
    });
  }

  listOffers(filter?: { status?: string; makerId?: string; limit?: number }) {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status.toUpperCase());
    }
    if (filter?.makerId) {
      clauses.push('maker_id = ?');
      params.push(filter.makerId);
    }
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const sql = `SELECT * FROM web3_dvp_offers ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as unknown as OfferRow[];
    return rows.map(publicOffer);
  }

  getOffer(offerId: string) {
    return publicOffer(this.offerRow(offerId));
  }

  cancelOffer(offerId: string, actorId: string) {
    const actor = holderId(actorId, 'actorId');
    return tx(this.db, () => {
      const offer = this.offerRow(offerId);
      if (offer.maker_id !== actor) throw Errors.forbidden('Somente o maker cancela a oferta.');
      if (offer.status !== 'OPEN') throw Errors.conflict('Oferta não está aberta.');
      const now = nowIso();
      this.db.prepare("UPDATE web3_dvp_offers SET status = 'CANCELLED' WHERE id = ?").run(offer.id);
      const anchor = appendAnchor(this.db, { type: 'WEB3_DVP_CANCELLED', offerId: offer.id, maker: actor }, now);
      audit(this.db, actor, 'WEB3_DVP_CANCELLED', offer.id, {});
      return { offer: publicOffer(this.offerRow(offer.id)), anchorHeight: anchor.height };
    });
  }

  acceptOffer(input: { offerId: string; takerId: string; now?: number }) {
    const taker = holderId(input.takerId, 'takerId');
    this.ensureMerchant(taker);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);

    const outcome = tx(this.db, () => {
      const offer = this.offerRow(input.offerId);
      if (offer.status !== 'OPEN') throw Errors.conflict('Oferta não está aberta.');
      if (nowMs >= Date.parse(offer.expires_at)) {
        this.db.prepare("UPDATE web3_dvp_offers SET status = 'EXPIRED' WHERE id = ?").run(offer.id);
        return null;
      }
      if (offer.taker_id && offer.taker_id !== taker) throw Errors.forbidden('Oferta reservada a outro taker.');
      if (offer.maker_id === taker) throw Errors.validation('Maker e taker devem ser diferentes.');

      const sellAsset = this.tokenAsset(offer.sell_symbol);
      if (this.holdingUnits(sellAsset.id, offer.maker_id) < offer.sell_units) {
        throw new AppError('DVP_INSUFFICIENT_UNITS', 'Maker não possui mais as unidades ofertadas.', 422);
      }

      let feeCents = 0;
      if (offer.kind === 'CASH_FOR_TOKEN') {
        feeCents = bps(offer.cash_cents, offer.fee_bps);
        const netCents = offer.cash_cents - feeCents;
        const available = this.merchantAvailable(taker);
        if (available < offer.cash_cents) {
          throw new AppError('DVP_INSUFFICIENT_CASH', 'Taker sem saldo disponível para a perna em dinheiro.', 422);
        }
        const entries: EntryInput[] = [
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: taker,
            direction: 'DEBIT',
            amountCents: offer.cash_cents,
            memo: `DVP ${offer.sell_symbol} · perna BRL`,
          },
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: offer.maker_id,
            direction: 'CREDIT',
            amountCents: netCents,
            memo: `DVP ${offer.sell_symbol} · recebimento`,
          },
        ];
        if (feeCents > 0) {
          entries.push({
            kind: 'FEE_REVENUE',
            direction: 'CREDIT',
            amountCents: feeCents,
            memo: 'Tarifa DVP',
          });
        }
        this.moveTokenUnits(sellAsset.id, offer.maker_id, taker, offer.sell_units, now);
        postGroup(this.db, { groupId: newId('dvl'), groupKind: 'DVP_CASH_LEG', createdAt: now, entries });
      } else {
        if (!offer.buy_symbol || !offer.buy_units) throw Errors.conflict('Oferta token-for-token incompleta.');
        const buyAsset = this.tokenAsset(offer.buy_symbol);
        if (this.holdingUnits(buyAsset.id, taker) < offer.buy_units) {
          throw new AppError('DVP_INSUFFICIENT_UNITS', 'Taker não possui as unidades exigidas.', 422);
        }
        this.moveTokenUnits(sellAsset.id, offer.maker_id, taker, offer.sell_units, now);
        this.moveTokenUnits(buyAsset.id, taker, offer.maker_id, offer.buy_units, now);
      }

      this.db
        .prepare("UPDATE web3_dvp_offers SET status = 'FILLED', settled_at = ? WHERE id = ?")
        .run(now, offer.id);
      const tradeId = newId('dvt');
      const txDigest = sha256Hex(`${offer.digest}|${taker}|${now}`);
      this.db
        .prepare(
          `INSERT INTO web3_dvp_trades
             (id, offer_id, network_id, maker_id, taker_id, sell_symbol, sell_units, buy_symbol, buy_units,
              cash_cents, fee_cents, tx_digest, anchor_height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          tradeId,
          offer.id,
          offer.network_id,
          offer.maker_id,
          taker,
          offer.sell_symbol,
          offer.sell_units,
          offer.buy_symbol,
          offer.buy_units,
          offer.cash_cents,
          feeCents,
          txDigest,
          now,
        );
      const anchor = appendAnchor(
        this.db,
        {
          type: 'WEB3_DVP_TRADE',
          tradeId,
          offerId: offer.id,
          maker: offer.maker_id,
          taker,
          sellSymbol: offer.sell_symbol,
          sellUnits: offer.sell_units,
          buySymbol: offer.buy_symbol,
          buyUnits: offer.buy_units,
          cashCents: offer.cash_cents,
          feeCents,
          txDigest,
        },
        now,
      );
      this.db.prepare('UPDATE web3_dvp_trades SET anchor_height = ? WHERE id = ?').run(anchor.height, tradeId);
      enqueueEvent(this.db, {
        topic: 'web3.dvp.settled',
        type: 'LiquidacaoDVP',
        key: offer.id,
        payload: {
          tradeId,
          offerId: offer.id,
          maker: offer.maker_id,
          taker,
          sellSymbol: offer.sell_symbol,
          cashCents: offer.cash_cents,
          feeCents,
          anchorHeight: anchor.height,
        },
      });
      audit(this.db, taker, 'WEB3_DVP_TRADE', tradeId, { offerId: offer.id, cashCents: offer.cash_cents, feeCents });
      return {
        trade: publicTrade(this.tradeRow(tradeId)),
        offer: publicOffer(this.offerRow(offer.id)),
        anchorHeight: anchor.height,
      };
    });

    if (!outcome) throw Errors.conflict('Oferta expirada; crie uma nova.');
    return outcome;
  }

  listTrades(filter?: { merchantId?: string; limit?: number }) {
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const rows = (
      filter?.merchantId
        ? this.db
            .prepare(
              `SELECT * FROM web3_dvp_trades WHERE maker_id = ? OR taker_id = ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(filter.merchantId, filter.merchantId, limit)
        : this.db.prepare('SELECT * FROM web3_dvp_trades ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as unknown as TradeRow[];
    return rows.map(publicTrade);
  }

  // ── Crédito agro com colateral tokenizado ───────────────────────────────

  openAgroContract(input: {
    networkId: string;
    merchantId: string;
    collateralSymbol: string;
    collateralUnits: number;
    principalCents: number;
    interestBps?: number;
    ltvBps?: number;
    liquidationLtvBps?: number;
    liquidationBonusBps?: number;
    oracleSymbol?: string;
    durationDays?: number;
    now?: number;
  }) {
    const merchant = holderId(input.merchantId, 'merchantId');
    this.ensureMerchant(merchant);
    const network = this.networkRow(input.networkId);
    if (network.status !== 'ACTIVE') throw Errors.conflict('Rede pausada.');
    const collateralSymbol = normalizeWeb3Symbol(input.collateralSymbol, 'collateralSymbol');
    const units = positiveInt(input.collateralUnits, 'collateralUnits', 1_000_000_000_000);
    const principal = positiveInt(input.principalCents, 'principalCents', MAX_NOTIONAL_CENTS);
    const interestBps = boundedBps(input.interestBps ?? 1200, 'interestBps', 20_000);
    const ltvBps = boundedBps(input.ltvBps ?? 6000, 'ltvBps', 9000);
    if (ltvBps === 0) throw Errors.validation('ltvBps deve ser maior que zero.');
    const liquidationLtvBps = boundedBps(input.liquidationLtvBps ?? 8000, 'liquidationLtvBps', 10_000);
    if (liquidationLtvBps < ltvBps) throw Errors.validation('liquidationLtvBps deve ser maior ou igual ao ltvBps.');
    const bonusBps = boundedBps(input.liquidationBonusBps ?? 2000, 'liquidationBonusBps', 5000);
    const oracleSymbol = normalizeWeb3Symbol(input.oracleSymbol ?? collateralSymbol, 'oracleSymbol');
    const durationDays = input.durationDays === undefined ? 180 : positiveInt(input.durationDays, 'durationDays', 720);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);

    const price = this.readPrice(oracleSymbol, nowMs);
    const collateralValue = units * price.centsPerUnit;
    if (!Number.isSafeInteger(collateralValue)) throw Errors.validation('Valor do colateral excede o limite numérico.');
    const maxPrincipal = Math.floor((collateralValue * ltvBps) / 10_000);
    if (principal > maxPrincipal) {
      throw new AppError('AGRO_LTV_EXCEEDED', 'Principal acima do limite de LTV para o colateral.', 422, {
        principalCents: principal,
        maxPrincipalCents: maxPrincipal,
        ltvBps,
        collateralValueCents: collateralValue,
      });
    }
    const interestCents = bps(principal, interestBps);
    const outstanding = principal + interestCents;

    return tx(this.db, () => {
      const asset = this.tokenAsset(collateralSymbol);
      if (this.holdingUnits(asset.id, merchant) < units) {
        throw new AppError('AGRO_INSUFFICIENT_COLLATERAL', 'Saldo insuficiente do ativo de colateral.', 422);
      }
      const id = newId('agr');
      this.moveTokenUnits(asset.id, merchant, AGRO_ESCROW_HOLDER, units, now);
      postGroup(this.db, {
        groupId: id,
        groupKind: 'AGRO_DISBURSEMENT',
        createdAt: now,
        entries: [
          { kind: 'CASH', direction: 'DEBIT', amountCents: principal, memo: `Desembolso agro ${id}` },
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: merchant,
            direction: 'CREDIT',
            amountCents: principal,
            memo: `Crédito agro ${collateralSymbol}`,
          },
        ],
      });
      this.db
        .prepare(
          `INSERT INTO web3_agro_contracts
             (id, network_id, merchant_id, collateral_symbol, collateral_units, principal_cents, outstanding_cents,
              interest_bps, ltv_bps, liquidation_ltv_bps, liquidation_bonus_bps, oracle_symbol, status, due_at,
              created_at, updated_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, NULL)`,
        )
        .run(
          id,
          network.id,
          merchant,
          collateralSymbol,
          units,
          principal,
          outstanding,
          interestBps,
          ltvBps,
          liquidationLtvBps,
          bonusBps,
          oracleSymbol,
          addSeconds(now, durationDays * 86_400),
          now,
          now,
        );
      const anchor = appendAnchor(
        this.db,
        {
          type: 'WEB3_AGRO_OPEN',
          contractId: id,
          merchant,
          collateralSymbol,
          collateralUnits: units,
          principalCents: principal,
          outstandingCents: outstanding,
          oracleCentsPerUnit: price.centsPerUnit,
          ltvBps,
        },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'web3.agro.opened',
        type: 'CreditoAgro',
        key: merchant,
        payload: { contractId: id, principalCents: principal, collateralSymbol, collateralUnits: units, anchorHeight: anchor.height },
      });
      audit(this.db, merchant, 'WEB3_AGRO_OPEN', id, { principal, collateralSymbol, collateralUnits: units, ltvBps });
      return { contract: publicAgro(this.agroRow(id), price.centsPerUnit), anchorHeight: anchor.height };
    });
  }

  listAgroContracts(filter?: { merchantId?: string; status?: string; limit?: number }) {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.merchantId) {
      clauses.push('merchant_id = ?');
      params.push(filter.merchantId);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status.toUpperCase());
    }
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const sql = `SELECT * FROM web3_agro_contracts ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as unknown as AgroRow[];
    return rows.map((row) => publicAgro(row, this.priceSnapshot(row.oracle_symbol)));
  }

  getAgroContract(contractId: string) {
    const row = this.agroRow(contractId);
    return publicAgro(row, this.priceSnapshot(row.oracle_symbol));
  }

  repayAgro(input: { contractId: string; merchantId: string; amountCents?: number; now?: number }) {
    const merchant = holderId(input.merchantId, 'merchantId');
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);

    return tx(this.db, () => {
      const contract = this.agroRow(input.contractId);
      if (contract.merchant_id !== merchant) throw Errors.forbidden('Contrato de outro titular.');
      if (contract.status !== 'OPEN') throw Errors.conflict('Contrato não está aberto.');
      const amount = input.amountCents === undefined ? contract.outstanding_cents : positiveInt(input.amountCents, 'amountCents');
      if (amount > contract.outstanding_cents) throw Errors.validation('Pagamento excede o saldo devedor.');
      if (this.merchantAvailable(merchant) < amount) {
        throw new AppError('AGRO_INSUFFICIENT_CASH', 'Saldo disponível insuficiente para a parcela.', 422);
      }
      postGroup(this.db, {
        groupId: newId('agr'),
        groupKind: 'AGRO_REPAYMENT',
        createdAt: now,
        entries: [
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: merchant,
            direction: 'DEBIT',
            amountCents: amount,
            memo: `Parcela agro ${contract.id}`,
          },
          { kind: 'CASH', direction: 'CREDIT', amountCents: amount, memo: `Recebimento agro ${contract.id}` },
        ],
      });
      const remaining = contract.outstanding_cents - amount;
      const closed = remaining === 0;
      this.db
        .prepare(
          `UPDATE web3_agro_contracts SET outstanding_cents = ?, status = ?, updated_at = ?, closed_at = ?
            WHERE id = ?`,
        )
        .run(remaining, closed ? 'REPAID' : 'OPEN', now, closed ? now : null, contract.id);
      if (closed) {
        const asset = this.tokenAsset(contract.collateral_symbol);
        this.moveTokenUnits(asset.id, AGRO_ESCROW_HOLDER, merchant, contract.collateral_units, now);
      }
      const anchor = appendAnchor(
        this.db,
        { type: 'WEB3_AGRO_REPAY', contractId: contract.id, merchant, amountCents: amount, remainingCents: remaining, closed },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'web3.agro.repaid',
        type: 'ParcelaAgro',
        key: merchant,
        payload: { contractId: contract.id, amountCents: amount, remainingCents: remaining, closed, anchorHeight: anchor.height },
      });
      audit(this.db, merchant, 'WEB3_AGRO_REPAY', contract.id, { amount, remaining });
      return { contract: publicAgro(this.agroRow(contract.id), this.priceSnapshot(contract.oracle_symbol)), anchorHeight: anchor.height };
    });
  }

  liquidateAgro(input: { contractId: string; liquidatorId: string; now?: number }) {
    const liquidator = holderId(input.liquidatorId, 'liquidatorId');
    this.ensureMerchant(liquidator);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);

    return tx(this.db, () => {
      const contract = this.agroRow(input.contractId);
      if (contract.status !== 'OPEN') throw Errors.conflict('Contrato não está aberto.');
      const price = this.readPrice(contract.oracle_symbol, nowMs);
      const collateralValue = contract.collateral_units * price.centsPerUnit;
      const ltv = loanToValueBps(contract.outstanding_cents, collateralValue);
      if (ltv < contract.liquidation_ltv_bps) {
        throw new AppError('AGRO_NOT_LIQUIDATABLE', 'LTV abaixo do gatilho de liquidação.', 422, {
          ltvBps: ltv,
          liquidationLtvBps: contract.liquidation_ltv_bps,
        });
      }
      if (this.merchantAvailable(liquidator) < contract.outstanding_cents) {
        throw new AppError('AGRO_INSUFFICIENT_CASH', 'Liquidante sem saldo para assumir a dívida.', 422);
      }
      const debt = contract.outstanding_cents;
      const bonusCents = Math.max(0, collateralValue - debt);
      postGroup(this.db, {
        groupId: newId('agl'),
        groupKind: 'AGRO_LIQUIDATION',
        createdAt: now,
        entries: [
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: liquidator,
            direction: 'DEBIT',
            amountCents: debt,
            memo: `Liquidação agro ${contract.id}`,
          },
          { kind: 'CASH', direction: 'CREDIT', amountCents: debt, memo: `Liquidação agro ${contract.id}` },
        ],
      });
      const asset = this.tokenAsset(contract.collateral_symbol);
      this.moveTokenUnits(asset.id, AGRO_ESCROW_HOLDER, liquidator, contract.collateral_units, now);
      this.db
        .prepare(
          `UPDATE web3_agro_contracts SET outstanding_cents = 0, status = 'LIQUIDATED', updated_at = ?, closed_at = ?
            WHERE id = ?`,
        )
        .run(now, now, contract.id);
      const anchor = appendAnchor(
        this.db,
        {
          type: 'WEB3_AGRO_LIQUIDATED',
          contractId: contract.id,
          liquidator,
          debtCents: debt,
          collateralCents: collateralValue,
          bonusCents,
        },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'web3.agro.liquidated',
        type: 'LiquidacaoAgro',
        key: contract.merchant_id,
        payload: { contractId: contract.id, liquidator, debtCents: debt, bonusCents, anchorHeight: anchor.height },
      });
      audit(this.db, liquidator, 'WEB3_AGRO_LIQUIDATED', contract.id, { debt, bonusCents });
      return {
        contract: publicAgro(this.agroRow(contract.id), price.centsPerUnit),
        liquidation: {
          liquidatorId: liquidator,
          debtCents: debt,
          debtFormatted: formatBRL(debt),
          collateralValueCents: collateralValue,
          collateralValueFormatted: formatBRL(collateralValue),
          bonusCents,
          bonusFormatted: formatBRL(bonusCents),
          ltvBps: ltv,
        },
        anchorHeight: anchor.height,
      };
    });
  }

  // ── Conformidade com atestação e nullifier ───────────────────────────────

  attestClaim(input: {
    commitment: string;
    claimType: string;
    predicate: string;
    threshold: number;
    issuer: string;
    expiresInSeconds?: number;
    now?: number;
  }) {
    const commitment = String(input.commitment ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(commitment)) throw Errors.validation('commitment deve ser um SHA-256 hexadecimal.');
    const claimType = assertNonEmptyString(input.claimType, 'claimType', 80).toUpperCase();
    const predicate = String(input.predicate ?? '').toUpperCase() as Predicate;
    if (!PREDICATES.includes(predicate)) throw Errors.validation('predicate deve ser GTE, LTE ou EQ.');
    if (!Number.isSafeInteger(input.threshold) || input.threshold < 0) {
      throw Errors.validation('threshold deve ser inteiro não negativo.');
    }
    const issuer = assertNonEmptyString(input.issuer, 'issuer', 120);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    const seconds = input.expiresInSeconds === undefined ? 2_592_000 : positiveInt(input.expiresInSeconds, 'expiresInSeconds', 31_536_000);
    const expiresAt = addSeconds(now, seconds);
    const hash = attestationHash({ commitment, claimType, predicate, threshold: input.threshold, issuer, expiresAt });
    const id = newId('zkt');

    return tx(this.db, () => {
      if (this.db.prepare('SELECT 1 AS found FROM web3_zk_attestations WHERE attestation_hash = ?').get(hash)) {
        throw Errors.conflict('Atestação já registrada.');
      }
      this.db
        .prepare(
          `INSERT INTO web3_zk_attestations
             (id, commitment, claim_type, predicate, threshold, issuer, attestation_hash, expires_at, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        )
        .run(id, commitment, claimType, predicate, input.threshold, issuer, hash, expiresAt, now);
      const anchor = appendAnchor(
        this.db,
        { type: 'WEB3_ZK_ATTESTATION', attestationId: id, claimType, predicate, threshold: input.threshold, issuer, hash },
        now,
      );
      audit(this.db, issuer, 'WEB3_ZK_ATTESTATION', id, { claimType, predicate, threshold: input.threshold });
      return { attestation: publicAttestation(this.attestationRow(id)), anchorHeight: anchor.height };
    });
  }

  listAttestations(commitment?: string) {
    const rows = (
      commitment
        ? this.db
            .prepare('SELECT * FROM web3_zk_attestations WHERE commitment = ? ORDER BY created_at DESC LIMIT 100')
            .all(commitment)
        : this.db.prepare('SELECT * FROM web3_zk_attestations ORDER BY created_at DESC LIMIT 100').all()
    ) as unknown as AttestationRow[];
    return rows.map(publicAttestation);
  }

  verifyClaim(input: {
    attestationId: string;
    purpose: string;
    relyingParty?: string;
    now?: number;
  }) {
    const purpose = assertNonEmptyString(input.purpose, 'purpose', 120);
    const relyingParty = input.relyingParty
      ? holderId(input.relyingParty, 'relyingParty')
      : 'xpartner';
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);

    return tx(this.db, () => {
      const attestation = this.attestationRow(input.attestationId);
      if (attestation.status !== 'ACTIVE') throw Errors.conflict('Atestação revogada.');
      if (nowMs >= Date.parse(attestation.expires_at)) throw Errors.conflict('Atestação expirada.');
      const nullifier = nullifierFor(attestation.commitment, purpose, todayEpoch(nowMs));
      if (this.db.prepare('SELECT 1 AS found FROM web3_zk_nullifiers WHERE nullifier = ?').get(nullifier)) {
        throw new AppError('ZK_NULLIFIER_REUSED', 'Nullifier já utilizado para esta finalidade.', 409);
      }
      this.db
        .prepare(
          `INSERT INTO web3_zk_nullifiers (nullifier, attestation_id, purpose, relying_party, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(nullifier, attestation.id, purpose, relyingParty, now);
      const anchor = appendAnchor(
        this.db,
        { type: 'WEB3_ZK_VERIFIED', nullifier, attestationId: attestation.id, purpose, relyingParty },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'web3.zk.verified',
        type: 'ProvaConformidade',
        key: relyingParty,
        payload: { attestationId: attestation.id, purpose, claimType: attestation.claim_type, anchorHeight: anchor.height },
      });
      audit(this.db, relyingParty, 'WEB3_ZK_VERIFIED', attestation.id, { purpose });
      return {
        verified: true,
        nullifier,
        epoch: todayEpoch(nowMs),
        disclosed: {
          claimType: attestation.claim_type,
          predicate: attestation.predicate,
          threshold: attestation.threshold,
          issuer: attestation.issuer,
          commitment: attestation.commitment,
        },
        attestation: publicAttestation(attestation),
        anchorHeight: anchor.height,
      };
    });
  }

  revokeAttestation(attestationId: string, actor = 'compliance') {
    return tx(this.db, () => {
      const attestation = this.attestationRow(attestationId);
      if (attestation.status === 'REVOKED') throw Errors.conflict('Atestação já revogada.');
      const now = nowIso();
      this.db.prepare("UPDATE web3_zk_attestations SET status = 'REVOKED' WHERE id = ?").run(attestation.id);
      const anchor = appendAnchor(this.db, { type: 'WEB3_ZK_REVOKED', attestationId: attestation.id }, now);
      audit(this.db, actor, 'WEB3_ZK_REVOKED', attestation.id, {});
      return { attestation: publicAttestation(this.attestationRow(attestation.id)), anchorHeight: anchor.height };
    });
  }

  listVerifications(limit = 50) {
    const rows = this.db
      .prepare(
        `SELECT n.nullifier, n.purpose, n.relying_party, n.created_at, a.claim_type, a.predicate, a.threshold
           FROM web3_zk_nullifiers n JOIN web3_zk_attestations a ON a.id = n.attestation_id
          ORDER BY n.created_at DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 200)) as Array<{
      nullifier: string;
      purpose: string;
      relying_party: string;
      created_at: string;
      claim_type: string;
      predicate: string;
      threshold: number;
    }>;
    return rows.map((row) => ({
      nullifier: row.nullifier,
      purpose: row.purpose,
      relyingParty: row.relying_party,
      claimType: row.claim_type,
      predicate: row.predicate,
      threshold: row.threshold,
      createdAt: row.created_at,
    }));
  }

  // ── Sessões de agente (ERC-4337 session keys com política) ───────────────

  grantAgentSession(input: {
    policyId: string;
    merchantId: string;
    networkId: string;
    agent: string;
    allowedSelectors: unknown[];
    spendCapCents: number;
    ttlSeconds?: number;
    now?: number;
  }) {
    const merchant = holderId(input.merchantId, 'merchantId');
    this.ensureMerchant(merchant);
    const network = this.networkRow(input.networkId);
    if (network.status !== 'ACTIVE') throw Errors.conflict('Rede pausada.');
    const agent = assertNonEmptyString(input.agent, 'agent', 80);
    if (!Array.isArray(input.allowedSelectors) || input.allowedSelectors.length === 0 || input.allowedSelectors.length > 20) {
      throw Errors.validation('allowedSelectors deve ter de 1 a 20 seletores.');
    }
    const selectors = Array.from(
      new Set(
        input.allowedSelectors.map((selector) => {
          const text = String(selector ?? '').trim().toLowerCase();
          if (!/^0x[0-9a-f]{8}$/.test(text)) {
            throw Errors.validation('Cada seletor deve ter o formato 0x + 8 hexadecimais.');
          }
          return text;
        }),
      ),
    );
    const cap = positiveInt(input.spendCapCents, 'spendCapCents', MAX_NOTIONAL_CENTS);
    const ttl = input.ttlSeconds === undefined ? 3600 : positiveInt(input.ttlSeconds, 'ttlSeconds', 2_592_000);
    if (ttl < 300) throw Errors.validation('ttlSeconds mínimo é 300.');
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    const sessionKey = randomToken(32);
    const keyHash = sessionKeyHash(sessionKey);
    const id = newId('ags');

    return tx(this.db, () => {
      const policy = this.policyRow(input.policyId);
      if (policy.merchant_id !== merchant) throw Errors.forbidden('Política de outro titular.');
      if (policy.status !== 'ACTIVE') throw Errors.conflict('Política pausada.');
      this.db
        .prepare(
          `INSERT INTO web3_agent_sessions
             (id, policy_id, merchant_id, network_id, agent, key_hash, allowed_selectors, spend_cap_cents, spent_cents,
              expires_at, status, created_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ACTIVE', ?, NULL)`,
        )
        .run(id, policy.id, merchant, network.id, agent, keyHash, JSON.stringify(selectors), cap, addSeconds(now, ttl), now);
      const anchor = appendAnchor(
        this.db,
        { type: 'WEB3_AGENT_SESSION', sessionId: id, policyId: policy.id, merchant, agent, selectors, cap },
        now,
      );
      audit(this.db, merchant, 'WEB3_AGENT_SESSION', id, { policyId: policy.id, selectors, cap });
      return {
        session: publicSession(this.sessionRow(id)),
        sessionKey,
        anchorHeight: anchor.height,
        note: 'A chave de sessão é exibida uma única vez; o core guarda apenas o hash.',
      };
    });
  }

  listAgentSessions(filter?: { merchantId?: string; limit?: number }) {
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const rows = (
      filter?.merchantId
        ? this.db
            .prepare('SELECT * FROM web3_agent_sessions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(filter.merchantId, limit)
        : this.db.prepare('SELECT * FROM web3_agent_sessions ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as unknown as SessionRow[];
    return rows.map(publicSession);
  }

  authorizeAgentAction(input: {
    sessionId: string;
    sessionKey: string;
    action: string;
    selector: string;
    symbol: string;
    notionalCents: number;
    humanApproved?: boolean;
    now?: number;
  }) {
    const action = assertNonEmptyString(input.action, 'action', 80);
    const selector = String(input.selector ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{8}$/.test(selector)) throw Errors.validation('selector inválido.');
    const symbol = normalizeWeb3Symbol(input.symbol);
    const notional = positiveInt(input.notionalCents, 'notionalCents', MAX_NOTIONAL_CENTS);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);

    const outcome = tx(this.db, () => {
      const session = this.sessionRow(input.sessionId);
      if (session.status === 'REVOKED') throw Errors.conflict('Sessão revogada.');
      if (session.status === 'EXPIRED') throw Errors.conflict('Sessão expirada.');
      if (nowMs >= Date.parse(session.expires_at)) {
        this.db.prepare("UPDATE web3_agent_sessions SET status = 'EXPIRED' WHERE id = ?").run(session.id);
        return null;
      }
      if (!constantTimeEqualHex(session.key_hash, sessionKeyHash(String(input.sessionKey ?? '')))) {
        throw Errors.forbidden('Chave de sessão inválida.');
      }
      const policy = this.policyRow(session.policy_id);
      if (policy.status !== 'ACTIVE') throw Errors.conflict('Política pausada.');
      if (policy.merchant_id !== session.merchant_id) throw Errors.forbidden('Sessão inconsistente com a política.');

      const selectors = decodeJsonList(session.allowed_selectors);
      const reasons: string[] = [];
      let decision: Decision = 'APPROVE';

      if (!selectors.includes(selector)) {
        reasons.push(`Seletor ${selector} fora da allowlist da sessão.`);
        decision = 'BLOCK';
      }
      const allowedSymbols = decodeJsonList(policy.allowed_symbols);
      if (!allowedSymbols.includes(symbol)) {
        reasons.push(`Símbolo ${symbol} fora da política.`);
        decision = 'BLOCK';
      }
      if (notional > policy.max_notional_cents) {
        reasons.push(`Notional ${formatBRL(notional)} acima do limite por ação.`);
        decision = 'BLOCK';
      }
      const dayStart = new Date(nowMs);
      dayStart.setHours(0, 0, 0, 0);
      const used = this.db
        .prepare(
          `SELECT COALESCE(SUM(notional_cents), 0) AS cents FROM agent_decisions
            WHERE policy_id = ? AND decision <> 'BLOCK' AND created_at >= ?`,
        )
        .get(policy.id, dayStart.toISOString()) as { cents: number };
      if (used.cents + notional > policy.daily_limit_cents) {
        reasons.push('Limite diário da política seria excedido.');
        decision = 'BLOCK';
      }
      if (session.spent_cents + notional > session.spend_cap_cents) {
        reasons.push('Teto de gasto da sessão seria excedido.');
        decision = 'BLOCK';
      }
      if (decision !== 'BLOCK' && policy.human_approval_above_cents > 0 && notional >= policy.human_approval_above_cents) {
        if (input.humanApproved === true) {
          reasons.push('Aprovação humana registrada para valor acima da autonomia.');
        } else {
          reasons.push('Acima do limite de autonomia: exige aprovação humana.');
          decision = 'REVIEW';
        }
      }
      if (reasons.length === 0) reasons.push('Dentro dos guardrails da política e da sessão.');

      const decisionId = newId('agd');
      this.db
        .prepare(
          `INSERT INTO agent_decisions
             (id, policy_id, merchant_id, agent, action, symbol, notional_cents, decision, reasons, anchor_height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          decisionId,
          policy.id,
          session.merchant_id,
          session.agent,
          action,
          symbol,
          notional,
          decision,
          JSON.stringify(reasons),
          now,
        );
      if (decision === 'APPROVE') {
        this.db
          .prepare('UPDATE web3_agent_sessions SET spent_cents = spent_cents + ? WHERE id = ?')
          .run(notional, session.id);
      }
      const anchor = appendAnchor(
        this.db,
        {
          type: 'WEB3_AGENT_ACTION',
          decisionId,
          sessionId: session.id,
          policyId: policy.id,
          action,
          selector,
          symbol,
          notionalCents: notional,
          decision,
        },
        now,
      );
      this.db.prepare('UPDATE agent_decisions SET anchor_height = ? WHERE id = ?').run(anchor.height, decisionId);
      enqueueEvent(this.db, {
        topic: 'web3.agent.action',
        type: 'AcaoAgente',
        key: session.merchant_id,
        payload: { decisionId, sessionId: session.id, action, selector, symbol, notionalCents: notional, decision, anchorHeight: anchor.height },
      });
      audit(this.db, session.agent, 'WEB3_AGENT_ACTION', session.id, { action, selector, symbol, notional, decision });

      return {
        decision: {
          id: decisionId,
          policyId: policy.id,
          sessionId: session.id,
          agent: session.agent,
          action,
          selector,
          symbol,
          notionalCents: notional,
          notionalFormatted: formatBRL(notional),
          decision,
          reasons,
          anchorHeight: anchor.height,
          createdAt: now,
        },
        executed: decision === 'APPROVE',
        session: publicSession(this.sessionRow(session.id)),
        anchorHeight: anchor.height,
      };
    });

    if (!outcome) throw Errors.conflict('Sessão expirada.');
    return outcome;
  }

  revokeAgentSession(sessionId: string, actorId: string) {
    const actor = holderId(actorId, 'actorId');
    return tx(this.db, () => {
      const session = this.sessionRow(sessionId);
      if (session.merchant_id !== actor) throw Errors.forbidden('Sessão de outro titular.');
      if (session.status !== 'ACTIVE') throw Errors.conflict('Sessão não está ativa.');
      const now = nowIso();
      this.db
        .prepare("UPDATE web3_agent_sessions SET status = 'REVOKED', revoked_at = ? WHERE id = ?")
        .run(now, session.id);
      const anchor = appendAnchor(this.db, { type: 'WEB3_AGENT_REVOKED', sessionId: session.id, merchant: actor }, now);
      audit(this.db, actor, 'WEB3_AGENT_REVOKED', session.id, {});
      return { session: publicSession(this.sessionRow(session.id)), anchorHeight: anchor.height };
    });
  }

  // ── Paymaster (patrocínio de UserOps) ────────────────────────────────────

  createPaymasterBudget(input: {
    merchantId: string;
    networkId: string;
    label: string;
    capCents: number;
    perOpMaxCents: number;
  }) {
    const merchant = holderId(input.merchantId, 'merchantId');
    this.ensureMerchant(merchant);
    const network = this.networkRow(input.networkId);
    if (network.status !== 'ACTIVE') throw Errors.conflict('Rede pausada.');
    if (!network.paymaster_contract) {
      throw new AppError('WEB3_CONTRACT', 'Rede sem contrato de paymaster registrado.', 422);
    }
    const label = assertNonEmptyString(input.label, 'label', 80);
    const cap = positiveInt(input.capCents, 'capCents', MAX_NOTIONAL_CENTS);
    const perOp = positiveInt(input.perOpMaxCents, 'perOpMaxCents', cap);
    const id = newId('pmb');
    const now = nowIso();

    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO web3_paymaster_budgets
             (id, merchant_id, network_id, label, cap_cents, spent_cents, per_op_max_cents, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, 'ACTIVE', ?, ?)`,
        )
        .run(id, merchant, network.id, label, cap, perOp, now, now);
      const anchor = appendAnchor(this.db, { type: 'WEB3_PAYMASTER_BUDGET', budgetId: id, merchant, cap, perOp }, now);
      audit(this.db, merchant, 'WEB3_PAYMASTER_BUDGET', id, { cap, perOp });
      return { budget: publicBudget(this.budgetRow(id)), anchorHeight: anchor.height };
    });
  }

  listPaymasterBudgets(filter?: { merchantId?: string; limit?: number }) {
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const rows = (
      filter?.merchantId
        ? this.db
            .prepare('SELECT * FROM web3_paymaster_budgets WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(filter.merchantId, limit)
        : this.db.prepare('SELECT * FROM web3_paymaster_budgets ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as unknown as BudgetRow[];
    return rows.map(publicBudget);
  }

  sponsorUserOp(input: {
    budgetId: string;
    merchantId: string;
    userOpHash: string;
    gasCents: number;
  }) {
    const merchant = holderId(input.merchantId, 'merchantId');
    const userOpHash = String(input.userOpHash ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(userOpHash)) throw Errors.validation('userOpHash deve ser 0x + 64 hexadecimais.');
    const gas = positiveInt(input.gasCents, 'gasCents', MAX_NOTIONAL_CENTS);

    return tx(this.db, () => {
      const budget = this.budgetRow(input.budgetId);
      if (budget.merchant_id !== merchant) throw Errors.forbidden('Orçamento de outro titular.');
      if (budget.status !== 'ACTIVE') throw Errors.conflict('Orçamento de paymaster pausado.');
      if (gas > budget.per_op_max_cents) {
        throw new AppError('PAYMASTER_OP_LIMIT', 'Gas acima do teto por UserOp.', 422, {
          gasCents: gas,
          perOpMaxCents: budget.per_op_max_cents,
        });
      }
      if (budget.spent_cents + gas > budget.cap_cents) {
        throw new AppError('PAYMASTER_CAP_EXCEEDED', 'Teto do orçamento de patrocínio seria excedido.', 422);
      }
      if (this.db.prepare('SELECT 1 AS found FROM web3_paymaster_ops WHERE user_op_hash = ?').get(userOpHash)) {
        throw Errors.conflict('UserOp já patrocinada (replay).');
      }
      const now = nowIso();
      const id = newId('pmo');
      this.db
        .prepare(
          `INSERT INTO web3_paymaster_ops (id, budget_id, user_op_hash, payer_id, gas_cents, anchor_height, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(id, budget.id, userOpHash, merchant, gas, now);
      this.db
        .prepare('UPDATE web3_paymaster_budgets SET spent_cents = spent_cents + ?, updated_at = ? WHERE id = ?')
        .run(gas, now, budget.id);
      const anchor = appendAnchor(
        this.db,
        { type: 'WEB3_PAYMASTER_OP', opId: id, budgetId: budget.id, userOpHash, gasCents: gas },
        now,
      );
      this.db.prepare('UPDATE web3_paymaster_ops SET anchor_height = ? WHERE id = ?').run(anchor.height, id);
      enqueueEvent(this.db, {
        topic: 'web3.paymaster.sponsored',
        type: 'UserOpPatrocinada',
        key: merchant,
        payload: { opId: id, budgetId: budget.id, gasCents: gas, anchorHeight: anchor.height },
      });
      audit(this.db, merchant, 'WEB3_PAYMASTER_OP', id, { budgetId: budget.id, gas });
      return {
        op: {
          id,
          budgetId: budget.id,
          userOpHash,
          payerId: merchant,
          gasCents: gas,
          gasFormatted: formatBRL(gas),
          status: 'SPONSORED',
          anchorHeight: anchor.height,
          createdAt: now,
        },
        budget: publicBudget(this.budgetRow(budget.id)),
        anchorHeight: anchor.height,
      };
    });
  }

  listPaymasterOps(filter?: { merchantId?: string; limit?: number }) {
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const rows = (
      filter?.merchantId
        ? this.db
            .prepare(
              `SELECT o.* FROM web3_paymaster_ops o JOIN web3_paymaster_budgets b ON b.id = o.budget_id
                WHERE b.merchant_id = ? ORDER BY o.created_at DESC LIMIT ?`,
            )
            .all(filter.merchantId, limit)
        : this.db.prepare('SELECT * FROM web3_paymaster_ops ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as Array<{ id: string; budget_id: string; user_op_hash: string; payer_id: string; gas_cents: number; anchor_height: number | null; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      budgetId: row.budget_id,
      userOpHash: row.user_op_hash,
      payerId: row.payer_id,
      gasCents: row.gas_cents,
      gasFormatted: formatBRL(row.gas_cents),
      anchorHeight: row.anchor_height,
      createdAt: row.created_at,
    }));
  }

  // ── Visão geral ──────────────────────────────────────────────────────────

  overview(merchantId: string) {
    const networks = this.db.prepare('SELECT COUNT(*) AS total FROM web3_networks').get() as { total: number };
    const offers = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END), 0) AS open
           FROM web3_dvp_offers WHERE maker_id = ?`,
      )
      .get(merchantId) as { total: number; open: number };
    const trades = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(cash_cents), 0) AS cashCents
           FROM web3_dvp_trades WHERE maker_id = ? OR taker_id = ?`,
      )
      .get(merchantId, merchantId) as { total: number; cashCents: number };
    const agro = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'OPEN' THEN outstanding_cents ELSE 0 END), 0) AS outstanding,
                COUNT(*) AS total
           FROM web3_agro_contracts WHERE merchant_id = ?`,
      )
      .get(merchantId) as { outstanding: number; total: number };
    const openAgro = this.db
      .prepare("SELECT * FROM web3_agro_contracts WHERE merchant_id = ? AND status = 'OPEN'")
      .all(merchantId) as unknown as AgroRow[];
    let liquidatable = 0;
    for (const row of openAgro) {
      const price = this.priceSnapshot(row.oracle_symbol);
      if (price === undefined) continue;
      if (loanToValueBps(row.outstanding_cents, row.collateral_units * price) >= row.liquidation_ltv_bps) {
        liquidatable += 1;
      }
    }
    const attestations = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) AS active
           FROM web3_zk_attestations`,
      )
      .get() as { total: number; active: number };
    const verifications = this.db.prepare('SELECT COUNT(*) AS total FROM web3_zk_nullifiers').get() as { total: number };
    const agents = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(spent_cents), 0) AS spent
           FROM web3_agent_sessions WHERE merchant_id = ?`,
      )
      .get(merchantId) as { total: number; active: number; spent: number };
    const paymaster = this.db
      .prepare(
        `SELECT COALESCE(SUM(cap_cents), 0) AS cap, COALESCE(SUM(spent_cents), 0) AS spent, COUNT(*) AS budgets
           FROM web3_paymaster_budgets WHERE merchant_id = ?`,
      )
      .get(merchantId) as { cap: number; spent: number; budgets: number };
    const anchors = latestAnchor(this.db);

    return {
      networks: networks.total,
      dvp: {
        offers: offers.total,
        openOffers: offers.open,
        trades: trades.total,
        cashVolumeCents: trades.cashCents,
        cashVolumeFormatted: formatBRL(trades.cashCents),
      },
      agro: {
        contracts: agro.total,
        outstandingCents: agro.outstanding,
        outstandingFormatted: formatBRL(agro.outstanding),
        liquidatable,
      },
      zk: { attestations: attestations.total, active: attestations.active, verifications: verifications.total },
      agents: {
        sessions: agents.total,
        activeSessions: agents.active,
        spentCents: agents.spent,
        spentFormatted: formatBRL(agents.spent),
      },
      paymaster: {
        budgets: paymaster.budgets,
        capCents: paymaster.cap,
        capFormatted: formatBRL(paymaster.cap),
        spentCents: paymaster.spent,
        spentFormatted: formatBRL(paymaster.spent),
      },
      anchors: { height: anchors?.height ?? 0, latestHash: anchors?.anchorHash ?? null },
      generatedAt: nowIso(),
    };
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  private isoDateOrThrow(value: string, field: string): string {
    const time = Date.parse(value);
    if (Number.isNaN(time)) throw Errors.validation(`${field} deve ser uma data ISO válida.`);
    return new Date(time).toISOString();
  }

  private networkRow(idOrChainId: string): NetworkRow {
    const numeric = Number(idOrChainId);
    const row = (
      Number.isSafeInteger(numeric) && numeric > 0
        ? this.db.prepare('SELECT * FROM web3_networks WHERE id = ? OR chain_id = ?').get(idOrChainId, numeric)
        : this.db.prepare('SELECT * FROM web3_networks WHERE id = ?').get(idOrChainId)
    ) as NetworkRow | undefined;
    if (!row) throw Errors.notFound('Rede Web3 não encontrada.');
    return row;
  }

  private feedRow(symbol: string): FeedRow {
    const row = this.db.prepare('SELECT * FROM web3_oracle_feeds WHERE symbol = ?').get(symbol) as FeedRow | undefined;
    if (!row) throw Errors.notFound('Feed de oráculo não encontrado.');
    return row;
  }

  private latestPriceRow(symbol: string): PriceRow | undefined {
    return this.db
      .prepare('SELECT * FROM web3_oracle_prices WHERE symbol = ? ORDER BY round_id DESC LIMIT 1')
      .get(symbol) as PriceRow | undefined;
  }

  private offerRow(offerId: string): OfferRow {
    const row = this.db.prepare('SELECT * FROM web3_dvp_offers WHERE id = ?').get(offerId) as OfferRow | undefined;
    if (!row) throw Errors.notFound('Oferta DVP não encontrada.');
    return row;
  }

  private tradeRow(tradeId: string): TradeRow {
    const row = this.db.prepare('SELECT * FROM web3_dvp_trades WHERE id = ?').get(tradeId) as TradeRow | undefined;
    if (!row) throw Errors.notFound('Trade DVP não encontrado.');
    return row;
  }

  private agroRow(contractId: string): AgroRow {
    const row = this.db.prepare('SELECT * FROM web3_agro_contracts WHERE id = ?').get(contractId) as AgroRow | undefined;
    if (!row) throw Errors.notFound('Contrato agro não encontrado.');
    return row;
  }

  private attestationRow(attestationId: string): AttestationRow {
    const row = this.db
      .prepare('SELECT * FROM web3_zk_attestations WHERE id = ?')
      .get(attestationId) as AttestationRow | undefined;
    if (!row) throw Errors.notFound('Atestação não encontrada.');
    return row;
  }

  private sessionRow(sessionId: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM web3_agent_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
    if (!row) throw Errors.notFound('Sessão de agente não encontrada.');
    return row;
  }

  private policyRow(policyId: string): PolicyRow {
    const row = this.db.prepare('SELECT * FROM agent_policies WHERE id = ?').get(policyId) as PolicyRow | undefined;
    if (!row) throw Errors.notFound('Política de agente não encontrada.');
    return row;
  }

  private budgetRow(budgetId: string): BudgetRow {
    const row = this.db.prepare('SELECT * FROM web3_paymaster_budgets WHERE id = ?').get(budgetId) as BudgetRow | undefined;
    if (!row) throw Errors.notFound('Orçamento de paymaster não encontrado.');
    return row;
  }

  private ensureMerchant(merchantId: string): void {
    const row = this.db.prepare('SELECT id, status FROM merchants WHERE id = ?').get(merchantId) as
      | { id: string; status: string }
      | undefined;
    if (!row) throw Errors.notFound('Estabelecimento não encontrado.');
    if (row.status !== 'ACTIVE') throw Errors.conflict('Estabelecimento não está ativo.');
  }

  private merchantAvailable(merchantId: string): number {
    const balances = listBalances(this.db, { ownerType: 'MERCHANT', ownerId: merchantId });
    const available = balances.find((row) => row.kind === 'MERCHANT_AVAILABLE');
    return available ? available.creditCents - available.debitCents : 0;
  }

  private tokenAsset(symbol: string): TokenAssetRow {
    const row = this.db
      .prepare('SELECT id, symbol, status, max_units, supply_units FROM token_assets WHERE symbol = ?')
      .get(symbol) as TokenAssetRow | undefined;
    if (!row) throw Errors.notFound(`Ativo tokenizado ${symbol} não encontrado.`);
    if (row.status === 'REDEEMED') throw Errors.conflict(`Ativo ${symbol} encerrado.`);
    return row;
  }

  private holdingUnits(assetId: string, holder: string): number {
    const row = this.db
      .prepare('SELECT units FROM token_holdings WHERE asset_id = ? AND holder_id = ?')
      .get(assetId, holder) as { units: number } | undefined;
    return row?.units ?? 0;
  }

  /** Movimenta unidades dentro da transação corrente do chamador. */
  private moveTokenUnits(assetId: string, from: string, to: string, units: number, now: string): void {
    if (from === to) throw Errors.validation('Origem e destino das unidades devem ser diferentes.');
    const balance = this.holdingUnits(assetId, from);
    if (balance < units) throw new AppError('TOKEN_INSUFFICIENT_UNITS', 'Saldo de unidades insuficiente.', 422);
    if (balance - units === 0) {
      this.db.prepare('DELETE FROM token_holdings WHERE asset_id = ? AND holder_id = ?').run(assetId, from);
    } else {
      this.db
        .prepare('UPDATE token_holdings SET units = ?, updated_at = ? WHERE asset_id = ? AND holder_id = ?')
        .run(balance - units, now, assetId, from);
    }
    this.db
      .prepare(
        `INSERT INTO token_holdings (asset_id, holder_id, units, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (asset_id, holder_id) DO UPDATE SET units = units + excluded.units, updated_at = excluded.updated_at`,
      )
      .run(assetId, to, units, now);
    this.db
      .prepare(
        `INSERT INTO token_events (id, asset_id, kind, from_holder, to_holder, units, reserve_cents, anchor_height, created_at)
         VALUES (?, ?, 'TRANSFER', ?, ?, ?, 0, NULL, ?)`,
      )
      .run(newId('tke'), assetId, from, to, units, now);
  }
}
