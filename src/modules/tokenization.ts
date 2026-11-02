import type { Db } from '../kernel/db.ts';
import { addSeconds, audit, nowIso, tx } from '../kernel/db.ts';
import { appendAnchor, latestAnchor, listAnchors, verifyAnchorChain } from '../kernel/anchor.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { assertNonEmptyString, sha256Hex } from '../kernel/crypto.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId, randomToken } from '../kernel/ids.ts';
import { bps, formatBRL } from '../kernel/money.ts';
import { postGroup } from '../domain/ledger.ts';
import type { EntryInput } from '../domain/ledger.ts';
import type { MerkleProof } from '../domain/zk.ts';
import {
  buildMerkleTree,
  commitClaim,
  merkleProof,
  verifyCommitment,
  verifyMerkleProof,
} from '../domain/zk.ts';

export type TokenKind = 'RWA' | 'DEBT' | 'BIO' | 'DEPIN' | 'KNOWLEDGE' | 'COMPUTE';
const TOKEN_KINDS: TokenKind[] = ['RWA', 'DEBT', 'BIO', 'DEPIN', 'KNOWLEDGE', 'COMPUTE'];

export type BridgeRail = 'PIX' | 'LIGHTNING' | 'DREX' | 'TCA';
const RAIL_META: Record<BridgeRail, { feeBps: number; label: string; rate: string }> = {
  PIX: { feeBps: 30, label: 'Pix / SPI', rate: '1 BRL = 1 BRL · liquidação D+0' },
  LIGHTNING: { feeBps: 45, label: 'Bitcoin Lightning', rate: '1 BRL ≈ 1.000 sat · simulado' },
  DREX: { feeBps: 20, label: 'Drex (CBDC)', rate: '1 BRL = 1 DREX · piloto' },
  TCA: { feeBps: 60, label: 'TCA (crédito tokenizado)', rate: '1 BRL = 1 TCA · paridade de lastro' },
};

const GOVERNANCE_SYMBOL = 'ADLA';
const DEPIN_CENTS_PER_UNIT = 2;
const MAX_UNITS = 1_000_000_000_000;

function positiveInt(value: unknown, field: string, max = MAX_UNITS): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw Errors.validation(`${field} deve ser um inteiro positivo.`);
  }
  return value;
}

function optionalText(value: unknown, field: string, max = 500): string | null {
  if (value === undefined || value === null || value === '') return null;
  return assertNonEmptyString(value, field, max);
}

function holderId(value: unknown, field = 'holderId'): string {
  const id = assertNonEmptyString(value, field, 80);
  if (!/^[A-Za-z0-9_.:@-]{3,80}$/.test(id)) {
    throw Errors.validation(`${field} contém caracteres inválidos.`);
  }
  return id;
}

function normalizeSymbol(value: unknown): string {
  const symbol = assertNonEmptyString(value, 'symbol', 12).toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(symbol)) {
    throw Errors.validation('symbol deve ter de 3 a 12 caracteres alfanuméricos.');
  }
  return symbol;
}

interface AssetRow {
  id: string;
  merchant_id: string;
  kind: TokenKind;
  name: string;
  symbol: string;
  description: string | null;
  backing_per_unit_cents: number;
  supply_units: number;
  max_units: number;
  reserve_cents: number;
  status: 'ACTIVE' | 'SUSPENDED' | 'REDEEMED';
  metadata_hash: string;
  maturity_at: string | null;
  coupon_bps: number | null;
  created_at: string;
  updated_at: string;
}

function publicAsset(row: AssetRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    kind: row.kind,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    backingPerUnitCents: row.backing_per_unit_cents,
    backingPerUnitFormatted: formatBRL(row.backing_per_unit_cents),
    supplyUnits: row.supply_units,
    maxUnits: row.max_units,
    reserveCents: row.reserve_cents,
    reserveFormatted: formatBRL(row.reserve_cents),
    status: row.status,
    metadataHash: row.metadata_hash,
    maturityAt: row.maturity_at,
    couponBps: row.coupon_bps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface EventRow {
  id: string;
  asset_id: string;
  kind: 'MINT' | 'TRANSFER' | 'REDEEM';
  from_holder: string | null;
  to_holder: string | null;
  units: number;
  reserve_cents: number;
  anchor_height: number | null;
  created_at: string;
}

function publicEvent(row: EventRow) {
  return {
    id: row.id,
    assetId: row.asset_id,
    kind: row.kind,
    fromHolder: row.from_holder,
    toHolder: row.to_holder,
    units: row.units,
    reserveCents: row.reserve_cents,
    anchorHeight: row.anchor_height,
    createdAt: row.created_at,
  };
}

interface BioRow {
  id: string;
  merchant_id: string;
  name: string;
  subject_pseudonym: string;
  consent_hash: string;
  consent_scope: string;
  dataset_hash: string;
  royalty_bps: number;
  status: 'PENDING' | 'ADMITTED' | 'REVOKED';
  admission_proposal_id: string | null;
  created_at: string;
  updated_at: string;
}

function publicBio(row: BioRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    subjectPseudonym: row.subject_pseudonym,
    consentHash: row.consent_hash,
    consentScope: row.consent_scope,
    datasetHash: row.dataset_hash,
    royaltyBps: row.royalty_bps,
    status: row.status,
    admissionProposalId: row.admission_proposal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface DeviceRow {
  id: string;
  merchant_id: string;
  model: string;
  capacity_units: number;
  proof_hash: string;
  status: 'ACTIVE' | 'SLASHED' | 'RETIRED';
  last_proof_at: string | null;
  created_at: string;
}

function publicDevice(row: DeviceRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    model: row.model,
    capacityUnits: row.capacity_units,
    proofHash: row.proof_hash,
    status: row.status,
    lastProofAt: row.last_proof_at,
    createdAt: row.created_at,
  };
}

interface ProposalRow {
  id: string;
  proposer_id: string;
  kind: 'ADMIT_BIO_SOURCE' | 'TREASURY_SPEND' | 'PARAMETER_CHANGE';
  subject: string;
  title: string;
  description: string;
  governance_symbol: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED';
  votes_for: number;
  votes_against: number;
  quorum_units: number;
  closes_at: string;
  created_at: string;
  decided_at: string | null;
}

function publicProposal(row: ProposalRow) {
  return {
    id: row.id,
    proposerId: row.proposer_id,
    kind: row.kind,
    subject: row.subject,
    title: row.title,
    description: row.description,
    governanceSymbol: row.governance_symbol,
    status: row.status,
    votesFor: row.votes_for,
    votesAgainst: row.votes_against,
    quorumUnits: row.quorum_units,
    closesAt: row.closes_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
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

function publicPolicy(row: PolicyRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    allowedSymbols: JSON.parse(row.allowed_symbols) as string[],
    maxNotionalCents: row.max_notional_cents,
    maxNotionalFormatted: formatBRL(row.max_notional_cents),
    dailyLimitCents: row.daily_limit_cents,
    dailyLimitFormatted: formatBRL(row.daily_limit_cents),
    humanApprovalAboveCents: row.human_approval_above_cents,
    humanApprovalAboveFormatted: formatBRL(row.human_approval_above_cents),
    status: row.status,
    createdAt: row.created_at,
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
  decision: 'APPROVE' | 'REVIEW' | 'BLOCK';
  reasons: string;
  anchor_height: number | null;
  created_at: string;
}

function publicDecision(row: DecisionRow) {
  return {
    id: row.id,
    policyId: row.policy_id,
    merchantId: row.merchant_id,
    agent: row.agent,
    action: row.action,
    symbol: row.symbol,
    notionalCents: row.notional_cents,
    notionalFormatted: formatBRL(row.notional_cents),
    decision: row.decision,
    reasons: JSON.parse(row.reasons) as string[],
    anchorHeight: row.anchor_height,
    createdAt: row.created_at,
  };
}

interface BridgeRow {
  id: string;
  merchant_id: string;
  rail: BridgeRail;
  direction: 'IN' | 'OUT';
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  rate: string;
  status: 'QUOTED' | 'SETTLED' | 'EXPIRED';
  expires_at: string;
  settled_at: string | null;
  anchor_height: number | null;
  created_at: string;
}

function publicBridge(row: BridgeRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    rail: row.rail,
    railLabel: RAIL_META[row.rail].label,
    direction: row.direction,
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    feeCents: row.fee_cents,
    feeFormatted: formatBRL(row.fee_cents),
    netCents: row.net_cents,
    netFormatted: formatBRL(row.net_cents),
    rate: row.rate,
    status: row.status,
    expiresAt: row.expires_at,
    settledAt: row.settled_at,
    anchorHeight: row.anchor_height,
    createdAt: row.created_at,
  };
}

export class TokenizationHub {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ── Ativos tokenizados ───────────────────────────────────────────────────

  createAsset(input: {
    merchantId: string;
    kind: string;
    name: string;
    symbol: string;
    description?: string;
    backingPerUnitCents: number;
    maxUnits: number;
    maturityAt?: string;
    couponBps?: number;
  }) {
    const merchant = this.db.prepare('SELECT id FROM merchants WHERE id = ?').get(input.merchantId);
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    const kind = String(input.kind).toUpperCase() as TokenKind;
    if (!TOKEN_KINDS.includes(kind)) throw Errors.validation('kind inválido.');
    const name = assertNonEmptyString(input.name, 'name', 120);
    const symbol = normalizeSymbol(input.symbol);
    const description = optionalText(input.description, 'description', 500);
    const backing = positiveInt(input.backingPerUnitCents, 'backingPerUnitCents', 100_000_000);
    const maxUnits = positiveInt(input.maxUnits, 'maxUnits');
    const couponBps =
      input.couponBps === undefined
        ? null
        : Number.isSafeInteger(input.couponBps) && input.couponBps >= 0 && input.couponBps <= 10_000
          ? input.couponBps
          : (() => {
              throw Errors.validation('couponBps deve estar entre 0 e 10000.');
            })();
    const maturityAt = optionalText(input.maturityAt, 'maturityAt', 40);
    const metadata = {
      merchantId: input.merchantId,
      kind,
      name,
      symbol,
      backingPerUnitCents: backing,
      maxUnits,
      couponBps,
      maturityAt,
    };
    const metadataHash = sha256Hex(`asset:${JSON.stringify(metadata)}`);
    const id = newId('tka');
    const now = nowIso();

    return tx(this.db, () => {
      const clash = this.db.prepare('SELECT id FROM token_assets WHERE symbol = ?').get(symbol);
      if (clash) throw Errors.conflict('Símbolo de token já utilizado.');
      this.db
        .prepare(
          `INSERT INTO token_assets
             (id, merchant_id, kind, name, symbol, description, backing_per_unit_cents, supply_units, max_units,
              reserve_cents, status, metadata_hash, maturity_at, coupon_bps, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 'ACTIVE', ?, ?, ?, ?, ?)`,
        )
        .run(id, input.merchantId, kind, name, symbol, description, backing, maxUnits, metadataHash, maturityAt, couponBps, now, now);
      const anchor = appendAnchor(this.db, { type: 'TOKEN_ASSET_CREATED', assetId: id, symbol, metadataHash }, now);
      audit(this.db, input.merchantId, 'TOKEN_ASSET_CREATED', id, { kind, symbol, backing, maxUnits });
      const row = this.assetRow(id);
      return { asset: publicAsset(row), anchorHeight: anchor.height, anchorHash: anchor.anchorHash };
    });
  }

  listAssets(merchantId?: string) {
    const rows = (
      merchantId
        ? this.db.prepare('SELECT * FROM token_assets WHERE merchant_id = ? ORDER BY created_at DESC').all(merchantId)
        : this.db.prepare('SELECT * FROM token_assets ORDER BY created_at DESC').all()
    ) as unknown as AssetRow[];
    return rows.map((row) => {
      const holders = this.db
        .prepare('SELECT COUNT(*) AS count FROM token_holdings WHERE asset_id = ?')
        .get(row.id) as { count: number };
      return { ...publicAsset(row), holders: holders.count };
    });
  }

  getAsset(assetIdOrSymbol: string) {
    return publicAsset(this.assetRow(assetIdOrSymbol));
  }

  getAssetHoldings(assetIdOrSymbol: string) {
    const asset = this.assetRow(assetIdOrSymbol);
    const rows = this.db
      .prepare('SELECT holder_id, units, updated_at FROM token_holdings WHERE asset_id = ? ORDER BY units DESC')
      .all(asset.id) as Array<{ holder_id: string; units: number; updated_at: string }>;
    return rows.map((row) => ({ holderId: row.holder_id, units: row.units, updatedAt: row.updated_at }));
  }

  listEvents(assetIdOrSymbol: string, limit = 30) {
    const asset = this.assetRow(assetIdOrSymbol);
    const rows = this.db
      .prepare('SELECT * FROM token_events WHERE asset_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(asset.id, Math.min(Math.max(limit, 1), 200)) as unknown as EventRow[];
    return rows.map(publicEvent);
  }

  mint(input: { assetId: string; holderId: string; units: number; actor?: string }) {
    const holder = holderId(input.holderId);
    const units = positiveInt(input.units, 'units');
    const actor = input.actor ?? 'tokenization';
    return tx(this.db, () => {
      const asset = this.assetRow(input.assetId);
      if (asset.status !== 'ACTIVE') throw Errors.conflict('Ativo não está apto a novas emissões.');
      if (asset.supply_units + units > asset.max_units) {
        throw new AppError('TOKEN_SUPPLY_LIMIT', 'Emissão excede o teto de unidades.', 422);
      }
      const reserve = units * asset.backing_per_unit_cents;
      if (!Number.isSafeInteger(reserve)) throw Errors.validation('Lastro excede o limite numérico.');
      const eventId = newId('tke');
      const now = nowIso();

      postGroup(this.db, {
        groupId: eventId,
        groupKind: 'TOKEN_MINT',
        createdAt: now,
        entries: [
          { kind: 'TOKEN_RESERVE', direction: 'DEBIT', amountCents: reserve, memo: `Lastro ${asset.symbol}` },
          { kind: 'TOKEN_LIABILITY', direction: 'CREDIT', amountCents: reserve, memo: `Emissão ${asset.symbol}` },
        ],
      });

      this.db
        .prepare(
          `INSERT INTO token_holdings (asset_id, holder_id, units, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (asset_id, holder_id) DO UPDATE SET units = units + excluded.units, updated_at = excluded.updated_at`,
        )
        .run(asset.id, holder, units, now);
      this.db
        .prepare(
          `INSERT INTO token_events (id, asset_id, kind, from_holder, to_holder, units, reserve_cents, created_at)
           VALUES (?, ?, 'MINT', NULL, ?, ?, ?, ?)`,
        )
        .run(eventId, asset.id, holder, units, reserve, now);
      const anchor = appendAnchor(
        this.db,
        { type: 'TOKEN_MINT', eventId, assetId: asset.id, holder, units, reserveCents: reserve },
        now,
      );
      this.db
        .prepare('UPDATE token_assets SET supply_units = supply_units + ?, reserve_cents = reserve_cents + ?, updated_at = ? WHERE id = ?')
        .run(units, reserve, now, asset.id);
      this.db.prepare('UPDATE token_events SET anchor_height = ? WHERE id = ?').run(anchor.height, eventId);
      enqueueEvent(this.db, {
        topic: 'token.minted',
        type: 'TokenEmitido',
        key: asset.id,
        payload: { assetId: asset.id, symbol: asset.symbol, holderId: holder, units, reserveCents: reserve, anchorHeight: anchor.height },
      });
      audit(this.db, actor, 'TOKEN_MINT', asset.id, { holder, units, reserveCents: reserve });

      return {
        asset: publicAsset(this.assetRow(asset.id)),
        event: publicEvent(this.db.prepare('SELECT * FROM token_events WHERE id = ?').get(eventId) as unknown as EventRow),
        anchorHeight: anchor.height,
      };
    });
  }

  transfer(input: { assetId: string; fromHolder: string; toHolder: string; units: number; actor?: string }) {
    const from = holderId(input.fromHolder, 'fromHolder');
    const to = holderId(input.toHolder, 'toHolder');
    if (from === to) throw Errors.validation('Origem e destino devem ser diferentes.');
    const units = positiveInt(input.units, 'units');
    const actor = input.actor ?? from;
    return tx(this.db, () => {
      const asset = this.assetRow(input.assetId);
      if (asset.status === 'REDEEMED') throw Errors.conflict('Ativo encerrado.');
      const balance = this.holdingUnits(asset.id, from);
      if (balance < units) throw new AppError('TOKEN_INSUFFICIENT_UNITS', 'Saldo de unidades insuficiente.', 422);

      const now = nowIso();
      const eventId = newId('tke');
      if (balance - units === 0) {
        this.db.prepare('DELETE FROM token_holdings WHERE asset_id = ? AND holder_id = ?').run(asset.id, from);
      } else {
        this.db
          .prepare('UPDATE token_holdings SET units = ?, updated_at = ? WHERE asset_id = ? AND holder_id = ?')
          .run(balance - units, now, asset.id, from);
      }
      this.db
        .prepare(
          `INSERT INTO token_holdings (asset_id, holder_id, units, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (asset_id, holder_id) DO UPDATE SET units = units + excluded.units, updated_at = excluded.updated_at`,
        )
        .run(asset.id, to, units, now);
      this.db
        .prepare(
          `INSERT INTO token_events (id, asset_id, kind, from_holder, to_holder, units, reserve_cents, created_at)
           VALUES (?, ?, 'TRANSFER', ?, ?, ?, 0, ?)`,
        )
        .run(eventId, asset.id, from, to, units, now);
      const anchor = appendAnchor(this.db, { type: 'TOKEN_TRANSFER', eventId, assetId: asset.id, from, to, units }, now);
      this.db.prepare('UPDATE token_events SET anchor_height = ? WHERE id = ?').run(anchor.height, eventId);
      enqueueEvent(this.db, {
        topic: 'token.transferred',
        type: 'TokenTransferido',
        key: asset.id,
        payload: { assetId: asset.id, symbol: asset.symbol, fromHolder: from, toHolder: to, units, anchorHeight: anchor.height },
      });
      audit(this.db, actor, 'TOKEN_TRANSFER', asset.id, { from, to, units });

      return {
        asset: publicAsset(this.assetRow(asset.id)),
        event: publicEvent(this.db.prepare('SELECT * FROM token_events WHERE id = ?').get(eventId) as unknown as EventRow),
        anchorHeight: anchor.height,
      };
    });
  }

  redeem(input: { assetId: string; holderId: string; units: number; actor?: string }) {
    const holder = holderId(input.holderId);
    const units = positiveInt(input.units, 'units');
    const actor = input.actor ?? holder;
    return tx(this.db, () => {
      const asset = this.assetRow(input.assetId);
      if (asset.status === 'REDEEMED') throw Errors.conflict('Ativo encerrado.');
      const balance = this.holdingUnits(asset.id, holder);
      if (balance < units) throw new AppError('TOKEN_INSUFFICIENT_UNITS', 'Saldo de unidades insuficiente.', 422);

      const reserve = units * asset.backing_per_unit_cents;
      const now = nowIso();
      const eventId = newId('tke');
      postGroup(this.db, {
        groupId: eventId,
        groupKind: 'TOKEN_REDEEM',
        createdAt: now,
        entries: [
          { kind: 'TOKEN_LIABILITY', direction: 'DEBIT', amountCents: reserve, memo: `Resgate ${asset.symbol}` },
          { kind: 'TOKEN_RESERVE', direction: 'CREDIT', amountCents: reserve, memo: `Baixa de lastro ${asset.symbol}` },
        ],
      });
      this.db
        .prepare(
          `INSERT INTO token_events (id, asset_id, kind, from_holder, to_holder, units, reserve_cents, created_at)
           VALUES (?, ?, 'REDEEM', ?, NULL, ?, ?, ?)`,
        )
        .run(eventId, asset.id, holder, units, reserve, now);
      if (balance - units === 0) {
        this.db.prepare('DELETE FROM token_holdings WHERE asset_id = ? AND holder_id = ?').run(asset.id, holder);
      } else {
        this.db
          .prepare('UPDATE token_holdings SET units = ?, updated_at = ? WHERE asset_id = ? AND holder_id = ?')
          .run(balance - units, now, asset.id, holder);
      }
      const anchor = appendAnchor(
        this.db,
        { type: 'TOKEN_REDEEM', eventId, assetId: asset.id, holder, units, reserveCents: reserve },
        now,
      );
      this.db.prepare('UPDATE token_events SET anchor_height = ? WHERE id = ?').run(anchor.height, eventId);
      this.db
        .prepare('UPDATE token_assets SET supply_units = supply_units - ?, reserve_cents = reserve_cents - ?, updated_at = ? WHERE id = ?')
        .run(units, reserve, now, asset.id);
      enqueueEvent(this.db, {
        topic: 'token.redeemed',
        type: 'TokenResgatado',
        key: asset.id,
        payload: { assetId: asset.id, symbol: asset.symbol, holderId: holder, units, reserveCents: reserve, anchorHeight: anchor.height },
      });
      audit(this.db, actor, 'TOKEN_REDEEM', asset.id, { holder, units, reserveCents: reserve });

      return {
        asset: publicAsset(this.assetRow(asset.id)),
        event: publicEvent(this.db.prepare('SELECT * FROM token_events WHERE id = ?').get(eventId) as unknown as EventRow),
        anchorHeight: anchor.height,
      };
    });
  }

  // ── Bioativos com consentimento verificável ──────────────────────────────

  createBioAsset(input: {
    merchantId: string;
    name: string;
    subjectPseudonym: string;
    consent: string;
    consentScope: string;
    datasetId: string;
    royaltyBps: number;
  }) {
    const merchant = this.db.prepare('SELECT id FROM merchants WHERE id = ?').get(input.merchantId);
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    const name = assertNonEmptyString(input.name, 'name', 120);
    const subject = assertNonEmptyString(input.subjectPseudonym, 'subjectPseudonym', 80);
    const consent = assertNonEmptyString(input.consent, 'consent', 2000);
    if (consent.length < 24) throw Errors.validation('Consentimento deve descrever a finalidade com pelo menos 24 caracteres.');
    const consentScope = assertNonEmptyString(input.consentScope, 'consentScope', 200);
    const datasetId = assertNonEmptyString(input.datasetId, 'datasetId', 200);
    if (!Number.isSafeInteger(input.royaltyBps) || input.royaltyBps < 0 || input.royaltyBps > 3000) {
      throw Errors.validation('royaltyBps deve estar entre 0 e 3000 (0% a 30%).');
    }
    const consentHash = sha256Hex(`consent:${consent}`);
    const datasetHash = sha256Hex(`dataset:${datasetId}`);
    const id = newId('bio');
    const now = nowIso();

    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO bio_assets
             (id, merchant_id, name, subject_pseudonym, consent_hash, consent_scope, dataset_hash, royalty_bps,
              status, admission_proposal_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?, ?)`,
        )
        .run(id, input.merchantId, name, subject, consentHash, consentScope, datasetHash, input.royaltyBps, now, now);
      const anchor = appendAnchor(
        this.db,
        { type: 'BIO_ASSET_REGISTERED', bioAssetId: id, consentHash, datasetHash, royaltyBps: input.royaltyBps },
        now,
      );
      audit(this.db, input.merchantId, 'BIO_ASSET_REGISTERED', id, { consentHash, datasetHash, royaltyBps: input.royaltyBps });
      return {
        bioAsset: publicBio(this.bioRow(id)),
        anchorHeight: anchor.height,
        consentHash,
        datasetHash,
      };
    });
  }

  listBioAssets(merchantId?: string) {
    const rows = (
      merchantId
        ? this.db.prepare('SELECT * FROM bio_assets WHERE merchant_id = ? ORDER BY created_at DESC').all(merchantId)
        : this.db.prepare('SELECT * FROM bio_assets ORDER BY created_at DESC').all()
    ) as unknown as BioRow[];
    return rows.map((row) => {
      const royalties = this.db
        .prepare('SELECT COALESCE(SUM(royalty_cents), 0) AS cents, COUNT(*) AS count FROM bio_royalties WHERE bio_asset_id = ?')
        .get(row.id) as { cents: number; count: number };
      return {
        ...publicBio(row),
        royaltyPaidCents: royalties.cents,
        royaltyPaidFormatted: formatBRL(royalties.cents),
        royaltyCount: royalties.count,
      };
    });
  }

  getBioAsset(bioId: string) {
    return publicBio(this.bioRow(bioId));
  }

  revokeBioAsset(bioId: string, reason: string, actor = 'dao') {
    const justification = assertNonEmptyString(reason, 'reason', 500);
    return tx(this.db, () => {
      const bio = this.bioRow(bioId);
      if (bio.status === 'REVOKED') throw Errors.conflict('Bioativo já revogado.');
      const now = nowIso();
      this.db.prepare("UPDATE bio_assets SET status = 'REVOKED', updated_at = ? WHERE id = ?").run(now, bio.id);
      const anchor = appendAnchor(this.db, { type: 'BIO_ASSET_REVOKED', bioAssetId: bio.id, reason: justification }, now);
      enqueueEvent(this.db, {
        topic: 'bio.revoked',
        type: 'BioativoRevogado',
        key: bio.merchant_id,
        payload: { bioAssetId: bio.id, reason: justification, anchorHeight: anchor.height },
      });
      audit(this.db, actor, 'BIO_ASSET_REVOKED', bio.id, { reason: justification });
      return { bioAsset: publicBio(this.bioRow(bio.id)), anchorHeight: anchor.height };
    });
  }

  /** Royalty pago por uso do dataset: lastro contábil no mesmo grupo do pagamento. */
  payRoyalty(input: { bioAssetId: string; payerId: string; grossCents: number }) {
    const payer = holderId(input.payerId, 'payerId');
    const gross = positiveInt(input.grossCents, 'grossCents', 100_000_000);
    return tx(this.db, () => {
      const bio = this.bioRow(input.bioAssetId);
      if (bio.status !== 'ADMITTED') throw new AppError('BIO_NOT_ADMITTED', 'Bioativo precisa ser admitido pela DAO.', 422);
      const royalty = bio.royalty_bps > 0 ? Math.max(0, bps(gross, bio.royalty_bps)) : 0;
      const fee = gross - royalty;
      const now = nowIso();
      const id = newId('roy');
      const entries: EntryInput[] = [
        { kind: 'CASH', direction: 'DEBIT', amountCents: gross, memo: `Licença ${bio.name}` },
      ];
      if (royalty > 0) {
        entries.push({
          kind: 'ROYALTY_PAYABLE' as const,
          ownerType: 'MERCHANT' as const,
          ownerId: bio.merchant_id,
          direction: 'CREDIT' as const,
          amountCents: royalty,
          memo: `Royalty ${bio.royalty_bps} bps`,
        });
      }
      if (fee > 0) {
        entries.push({
          kind: 'FEE_REVENUE' as const,
          direction: 'CREDIT' as const,
          amountCents: fee,
          memo: 'Margem de licenciamento de dados',
        });
      }
      if (entries.length < 2) throw Errors.validation('Valor de royalty inválido.');

      this.db
        .prepare(
          `INSERT INTO bio_royalties
             (id, bio_asset_id, payer_id, gross_cents, royalty_cents, platform_fee_cents, holder_id, anchor_height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(id, bio.id, payer, gross, royalty, fee, bio.merchant_id, now);
      postGroup(this.db, { groupId: id, groupKind: 'BIO_ROYALTY', createdAt: now, entries });
      const anchor = appendAnchor(
        this.db,
        { type: 'BIO_ROYALTY_PAID', royaltyId: id, bioAssetId: bio.id, payerId: payer, grossCents: gross, royaltyCents: royalty },
        now,
      );
      this.db.prepare('UPDATE bio_royalties SET anchor_height = ? WHERE id = ?').run(anchor.height, id);
      enqueueEvent(this.db, {
        topic: 'bio.royalty_paid',
        type: 'RoyaltyPago',
        key: bio.merchant_id,
        payload: { bioAssetId: bio.id, royaltyCents: royalty, grossCents: gross, anchorHeight: anchor.height },
      });
      audit(this.db, payer, 'BIO_ROYALTY_PAID', bio.id, { gross, royalty, fee });

      return {
        royalty: {
          id,
          bioAssetId: bio.id,
          payerId: payer,
          grossCents: gross,
          grossFormatted: formatBRL(gross),
          royaltyCents: royalty,
          royaltyFormatted: formatBRL(royalty),
          platformFeeCents: fee,
          platformFeeFormatted: formatBRL(fee),
          beneficiaryId: bio.merchant_id,
          anchorHeight: anchor.height,
          createdAt: now,
        },
        anchorHeight: anchor.height,
      };
    });
  }

  listRoyalties(bioAssetId: string) {
    const rows = this.db
      .prepare('SELECT * FROM bio_royalties WHERE bio_asset_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(bioAssetId) as Array<{
      id: string;
      bio_asset_id: string;
      payer_id: string;
      gross_cents: number;
      royalty_cents: number;
      platform_fee_cents: number;
      holder_id: string;
      anchor_height: number | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      bioAssetId: row.bio_asset_id,
      payerId: row.payer_id,
      grossCents: row.gross_cents,
      grossFormatted: formatBRL(row.gross_cents),
      royaltyCents: row.royalty_cents,
      royaltyFormatted: formatBRL(row.royalty_cents),
      platformFeeCents: row.platform_fee_cents,
      beneficiaryId: row.holder_id,
      anchorHeight: row.anchor_height,
      createdAt: row.created_at,
    }));
  }

  // ── DePIN / Proof of Physical Work ───────────────────────────────────────

  registerDevice(input: { merchantId: string; model: string; capacityUnits: number; proof: string }) {
    const merchant = this.db.prepare('SELECT id FROM merchants WHERE id = ?').get(input.merchantId);
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    const model = assertNonEmptyString(input.model, 'model', 120);
    const capacity = positiveInt(input.capacityUnits, 'capacityUnits');
    const proof = assertNonEmptyString(input.proof, 'proof', 500);
    const proofHash = sha256Hex(`depin:${proof}`);
    const id = newId('dpn');
    const now = nowIso();

    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO depin_devices (id, merchant_id, model, capacity_units, proof_hash, status, last_proof_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', NULL, ?)`,
        )
        .run(id, input.merchantId, model, capacity, proofHash, now);
      const anchor = appendAnchor(this.db, { type: 'DEPIN_DEVICE_REGISTERED', deviceId: id, proofHash, capacity }, now);
      audit(this.db, input.merchantId, 'DEPIN_DEVICE_REGISTERED', id, { model, capacity, proofHash });
      return { device: publicDevice(this.deviceRow(id)), anchorHeight: anchor.height };
    });
  }

  listDevices(merchantId?: string) {
    const rows = (
      merchantId
        ? this.db.prepare('SELECT * FROM depin_devices WHERE merchant_id = ? ORDER BY created_at DESC').all(merchantId)
        : this.db.prepare('SELECT * FROM depin_devices ORDER BY created_at DESC').all()
    ) as unknown as DeviceRow[];
    return rows.map((row) => {
      const rewards = this.db
        .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS cents, COALESCE(SUM(units), 0) AS units, COUNT(*) AS count FROM depin_rewards WHERE device_id = ?')
        .get(row.id) as { cents: number; units: number; count: number };
      return {
        ...publicDevice(row),
        rewardCents: rewards.cents,
        rewardFormatted: formatBRL(rewards.cents),
        rewardUnits: rewards.units,
        rewardCount: rewards.count,
      };
    });
  }

  rewardDevice(input: { deviceId: string; units: number; proof: string }) {
    const units = positiveInt(input.units, 'units');
    const proof = assertNonEmptyString(input.proof, 'proof', 500);
    return tx(this.db, () => {
      const device = this.deviceRow(input.deviceId);
      if (device.status !== 'ACTIVE') throw Errors.conflict('Dispositivo não está ativo.');
      if (units > device.capacity_units) throw Errors.validation('Unidades acima da capacidade declarada do dispositivo.');
      const amount = units * DEPIN_CENTS_PER_UNIT;
      const proofHash = sha256Hex(`depin-proof:${proof}`);
      const now = nowIso();
      const id = newId('dpr');

      this.db
        .prepare(
          `INSERT INTO depin_rewards (id, device_id, merchant_id, units, amount_cents, proof_hash, anchor_height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(id, device.id, device.merchant_id, units, amount, proofHash, now);
      postGroup(this.db, {
        groupId: id,
        groupKind: 'DEPIN_REWARD',
        createdAt: now,
        entries: [
          { kind: 'DEPIN_REWARD_EXPENSE', direction: 'DEBIT', amountCents: amount, memo: `PoPW ${device.model}` },
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: device.merchant_id,
            direction: 'CREDIT',
            amountCents: amount,
            memo: `Recompensa DePIN ${device.id}`,
          },
        ],
      });
      const anchor = appendAnchor(
        this.db,
        { type: 'DEPIN_REWARD', rewardId: id, deviceId: device.id, units, amountCents: amount, proofHash },
        now,
      );
      this.db.prepare('UPDATE depin_rewards SET anchor_height = ? WHERE id = ?').run(anchor.height, id);
      this.db.prepare('UPDATE depin_devices SET last_proof_at = ? WHERE id = ?').run(now, device.id);
      enqueueEvent(this.db, {
        topic: 'depin.rewarded',
        type: 'RecompensaDePIN',
        key: device.merchant_id,
        payload: { deviceId: device.id, units, amountCents: amount, anchorHeight: anchor.height },
      });
      audit(this.db, device.merchant_id, 'DEPIN_REWARD', device.id, { units, amountCents: amount, proofHash });

      return {
        reward: {
          id,
          deviceId: device.id,
          merchantId: device.merchant_id,
          units,
          amountCents: amount,
          amountFormatted: formatBRL(amount),
          proofHash,
          anchorHeight: anchor.height,
          createdAt: now,
        },
        anchorHeight: anchor.height,
      };
    });
  }

  // ── Governança DAO (ADLA) ────────────────────────────────────────────────

  createProposal(input: {
    proposerId: string;
    kind: string;
    subject: string;
    title: string;
    description: string;
    quorumUnits?: number;
    durationHours?: number;
    now?: number;
  }) {
    const proposer = holderId(input.proposerId, 'proposerId');
    const kind = String(input.kind).toUpperCase() as ProposalRow['kind'];
    if (!['ADMIT_BIO_SOURCE', 'TREASURY_SPEND', 'PARAMETER_CHANGE'].includes(kind)) {
      throw Errors.validation('kind de proposta inválido.');
    }
    const subject = assertNonEmptyString(input.subject, 'subject', 120);
    const title = assertNonEmptyString(input.title, 'title', 160);
    const description = assertNonEmptyString(input.description, 'description', 1000);
    const quorum = input.quorumUnits === undefined ? 100 : positiveInt(input.quorumUnits, 'quorumUnits');
    const durationHours = input.durationHours === undefined ? 72 : positiveInt(input.durationHours, 'durationHours', 720);
    if (kind === 'ADMIT_BIO_SOURCE') {
      const bio = this.db.prepare('SELECT id FROM bio_assets WHERE id = ?').get(subject);
      if (!bio) throw Errors.notFound('Bioativo da proposta não encontrado.');
    }
    const now = nowIso(input.now);
    const id = newId('dao');

    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO dao_proposals
             (id, proposer_id, kind, subject, title, description, governance_symbol, status, votes_for, votes_against,
              quorum_units, closes_at, created_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', 0, 0, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          proposer,
          kind,
          subject,
          title,
          description,
          GOVERNANCE_SYMBOL,
          quorum,
          addSeconds(now, durationHours * 3600),
          now,
        );
      const anchor = appendAnchor(this.db, { type: 'DAO_PROPOSAL_CREATED', proposalId: id, kind, subject }, now);
      enqueueEvent(this.db, {
        topic: 'dao.proposal_created',
        type: 'PropostaDAO',
        key: id,
        payload: { proposalId: id, kind, subject, title, anchorHeight: anchor.height },
      });
      audit(this.db, proposer, 'DAO_PROPOSAL_CREATED', id, { kind, subject, quorum });
      return { proposal: publicProposal(this.proposalRow(id)), anchorHeight: anchor.height };
    });
  }

  listProposals(status?: string) {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM dao_proposals WHERE status = ? ORDER BY created_at DESC').all(status.toUpperCase())
        : this.db.prepare('SELECT * FROM dao_proposals ORDER BY created_at DESC').all()
    ) as unknown as ProposalRow[];
    return rows.map(publicProposal);
  }

  getProposal(proposalId: string) {
    const proposal = this.proposalRow(proposalId);
    const votes = this.db
      .prepare('SELECT voter_id, units, choice, created_at FROM dao_votes WHERE proposal_id = ? ORDER BY created_at ASC')
      .all(proposal.id) as Array<{ voter_id: string; units: number; choice: 'FOR' | 'AGAINST'; created_at: string }>;
    return {
      ...publicProposal(proposal),
      votes: votes.map((vote) => ({
        voterId: vote.voter_id,
        units: vote.units,
        choice: vote.choice,
        createdAt: vote.created_at,
      })),
    };
  }

  vote(input: { proposalId: string; voterId: string; choice: string; now?: number }) {
    const voter = holderId(input.voterId, 'voterId');
    const choice = String(input.choice).toUpperCase();
    if (choice !== 'FOR' && choice !== 'AGAINST') throw Errors.validation('choice deve ser FOR ou AGAINST.');
    const now = nowIso(input.now);

    return tx(this.db, () => {
      const proposal = this.proposalRow(input.proposalId);
      if (proposal.status !== 'OPEN') throw Errors.conflict('Proposta encerrada.');
      if (now >= proposal.closes_at) throw Errors.conflict('Janela de votação encerrada.');
      const governance = this.assetRowOrNull(GOVERNANCE_SYMBOL);
      if (!governance) throw new AppError('GOVERNANCE_TOKEN_MISSING', `Token ${GOVERNANCE_SYMBOL} não emitido.`, 503);
      const weight = this.holdingUnits(governance.id, voter);
      if (weight <= 0) throw Errors.forbidden(`Somente detentores de ${GOVERNANCE_SYMBOL} podem votar.`);
      if (this.db.prepare('SELECT 1 AS found FROM dao_votes WHERE proposal_id = ? AND voter_id = ?').get(proposal.id, voter)) {
        throw Errors.conflict('Voto já registrado para esta proposta.');
      }

      this.db
        .prepare('INSERT INTO dao_votes (proposal_id, voter_id, units, choice, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(proposal.id, voter, weight, choice, now);
      const column = choice === 'FOR' ? 'votes_for' : 'votes_against';
      this.db.prepare(`UPDATE dao_proposals SET ${column} = ${column} + ? WHERE id = ?`).run(weight, proposal.id);
      const anchor = appendAnchor(
        this.db,
        { type: 'DAO_VOTE', proposalId: proposal.id, voterId: voter, choice, weight },
        now,
      );
      audit(this.db, voter, 'DAO_VOTE', proposal.id, { choice, weight });
      return {
        proposal: publicProposal(this.proposalRow(proposal.id)),
        vote: { voterId: voter, units: weight, choice },
        anchorHeight: anchor.height,
      };
    });
  }

  closeProposal(proposalId: string, nowMs: number = Date.now()) {
    const now = nowIso(nowMs);
    return tx(this.db, () => {
      const proposal = this.proposalRow(proposalId);
      if (proposal.status !== 'OPEN') throw Errors.conflict('Proposta já decidida.');
      if (now < proposal.closes_at) throw Errors.conflict('Janela de votação ainda aberta.');

      const approved = proposal.votes_for >= proposal.quorum_units && proposal.votes_for > proposal.votes_against;
      const status = approved ? 'APPROVED' : 'REJECTED';
      this.db.prepare('UPDATE dao_proposals SET status = ?, decided_at = ? WHERE id = ?').run(status, now, proposal.id);

      if (approved && proposal.kind === 'ADMIT_BIO_SOURCE') {
        this.db
          .prepare("UPDATE bio_assets SET status = 'ADMITTED', admission_proposal_id = ?, updated_at = ? WHERE id = ?")
          .run(proposal.id, now, proposal.subject);
      }
      const anchor = appendAnchor(
        this.db,
        { type: 'DAO_PROPOSAL_DECIDED', proposalId: proposal.id, status, votesFor: proposal.votes_for, votesAgainst: proposal.votes_against },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'dao.proposal_decided',
        type: 'PropostaDecidida',
        key: proposal.id,
        payload: { proposalId: proposal.id, status, subject: proposal.subject, anchorHeight: anchor.height },
      });
      audit(this.db, 'dao', 'DAO_PROPOSAL_DECIDED', proposal.id, { status });
      return { proposal: publicProposal(this.proposalRow(proposal.id)), anchorHeight: anchor.height };
    });
  }

  // ── Agentes autônomos com guardrails ─────────────────────────────────────

  createAgentPolicy(input: {
    merchantId: string;
    name: string;
    allowedSymbols: string[];
    maxNotionalCents: number;
    dailyLimitCents: number;
    humanApprovalAboveCents: number;
  }) {
    const merchant = this.db.prepare('SELECT id FROM merchants WHERE id = ?').get(input.merchantId);
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    const name = assertNonEmptyString(input.name, 'name', 120);
    if (!Array.isArray(input.allowedSymbols)) throw Errors.validation('allowedSymbols deve ser uma lista de símbolos.');
    const symbols = Array.from(new Set(input.allowedSymbols.map((symbol) => normalizeSymbol(symbol))));
    if (symbols.length === 0 || symbols.length > 20) throw Errors.validation('allowedSymbols deve ter de 1 a 20 símbolos.');
    const maxNotional = positiveInt(input.maxNotionalCents, 'maxNotionalCents', 100_000_000);
    const dailyLimit = positiveInt(input.dailyLimitCents, 'dailyLimitCents', 100_000_000);
    if (dailyLimit < maxNotional) throw Errors.validation('dailyLimitCents deve ser maior ou igual ao limite por ação.');
    if (!Number.isSafeInteger(input.humanApprovalAboveCents) || input.humanApprovalAboveCents < 0) {
      throw Errors.validation('humanApprovalAboveCents inválido.');
    }
    const id = newId('agp');
    const now = nowIso();

    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO agent_policies
             (id, merchant_id, name, allowed_symbols, max_notional_cents, daily_limit_cents,
              human_approval_above_cents, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        )
        .run(id, input.merchantId, name, JSON.stringify(symbols), maxNotional, dailyLimit, input.humanApprovalAboveCents, now);
      const anchor = appendAnchor(this.db, { type: 'AGENT_POLICY_CREATED', policyId: id, symbols, maxNotional, dailyLimit }, now);
      audit(this.db, input.merchantId, 'AGENT_POLICY_CREATED', id, { symbols, maxNotional, dailyLimit });
      return { policy: publicPolicy(this.policyRow(id)), anchorHeight: anchor.height };
    });
  }

  listPolicies(merchantId?: string) {
    const rows = (
      merchantId
        ? this.db.prepare('SELECT * FROM agent_policies WHERE merchant_id = ? ORDER BY created_at DESC').all(merchantId)
        : this.db.prepare('SELECT * FROM agent_policies ORDER BY created_at DESC').all()
    ) as unknown as PolicyRow[];
    return rows.map(publicPolicy);
  }

  listDecisions(merchantId?: string, limit = 30) {
    const rows = (
      merchantId
        ? this.db
            .prepare('SELECT * FROM agent_decisions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(merchantId, Math.min(Math.max(limit, 1), 200))
        : this.db
            .prepare('SELECT * FROM agent_decisions ORDER BY created_at DESC LIMIT ?')
            .all(Math.min(Math.max(limit, 1), 200))
    ) as unknown as DecisionRow[];
    return rows.map(publicDecision);
  }

  evaluateAgentAction(input: {
    policyId: string;
    agent: string;
    action: string;
    symbol: string;
    notionalCents: number;
    now?: number;
  }) {
    const agent = assertNonEmptyString(input.agent, 'agent', 80);
    const action = assertNonEmptyString(input.action, 'action', 80);
    const symbol = normalizeSymbol(input.symbol);
    const notional = positiveInt(input.notionalCents, 'notionalCents', 100_000_000);
    const nowMs = input.now ?? Date.now();

    return tx(this.db, () => {
      const policy = this.policyRow(input.policyId);
      if (policy.status !== 'ACTIVE') throw Errors.conflict('Política pausada.');
      const allowed = JSON.parse(policy.allowed_symbols) as string[];
      const reasons: string[] = [];
      let decision: DecisionRow['decision'] = 'APPROVE';

      if (!allowed.includes(symbol)) {
        reasons.push(`Símbolo ${symbol} fora da lista autorizada.`);
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
      if (decision !== 'BLOCK' && policy.human_approval_above_cents > 0 && notional >= policy.human_approval_above_cents) {
        reasons.push('Acima do limite de autonomia: exige aprovação humana.');
        decision = 'REVIEW';
      }
      if (reasons.length === 0) reasons.push('Dentro dos guardrails da política.');

      const id = newId('agd');
      const now = nowIso(nowMs);
      this.db
        .prepare(
          `INSERT INTO agent_decisions
             (id, policy_id, merchant_id, agent, action, symbol, notional_cents, decision, reasons, anchor_height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(id, policy.id, policy.merchant_id, agent, action, symbol, notional, decision, JSON.stringify(reasons), now);
      const anchor = appendAnchor(
        this.db,
        { type: 'AGENT_DECISION', decisionId: id, policyId: policy.id, agent, symbol, notional, decision },
        now,
      );
      this.db.prepare('UPDATE agent_decisions SET anchor_height = ? WHERE id = ?').run(anchor.height, id);
      enqueueEvent(this.db, {
        topic: 'agent.decision',
        type: 'DecisaoAgente',
        key: policy.merchant_id,
        payload: { decisionId: id, policyId: policy.id, agent, symbol, notionalCents: notional, decision, anchorHeight: anchor.height },
      });
      audit(this.db, agent, 'AGENT_DECISION', policy.id, { symbol, notional, decision });

      return {
        decision: publicDecision(this.db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(id) as unknown as DecisionRow),
        anchorHeight: anchor.height,
      };
    });
  }

  // ── Pontes multi-trilho (Pix, Lightning, Drex, TCA) ──────────────────────

  quoteBridge(input: {
    merchantId: string;
    rail: string;
    direction: string;
    amountCents: number;
    now?: number;
  }) {
    const merchant = this.db.prepare('SELECT id FROM merchants WHERE id = ?').get(input.merchantId);
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    const rail = String(input.rail).toUpperCase() as BridgeRail;
    if (!RAIL_META[rail]) throw Errors.validation('rail inválido.');
    const direction = String(input.direction).toUpperCase() as 'IN' | 'OUT';
    if (direction !== 'IN' && direction !== 'OUT') throw Errors.validation('direction deve ser IN ou OUT.');
    const amount = positiveInt(input.amountCents, 'amountCents', 100_000_000);
    const meta = RAIL_META[rail];
    const fee = Math.max(50, bps(amount, meta.feeBps));
    const net = amount - fee;
    if (net <= 0) throw Errors.validation('Valor insuficiente para cobrir a tarifa da trilha.');
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    const id = newId('brg');

    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO bridge_intents
             (id, merchant_id, rail, direction, amount_cents, fee_cents, net_cents, rate, status, expires_at,
              settled_at, anchor_height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUOTED', ?, NULL, NULL, ?)`,
        )
        .run(id, input.merchantId, rail, direction, amount, fee, net, meta.rate, addSeconds(now, 300), now);
      const anchor = appendAnchor(
        this.db,
        { type: 'BRIDGE_QUOTED', intentId: id, rail, direction, amountCents: amount, feeCents: fee, netCents: net },
        now,
      );
      this.db.prepare('UPDATE bridge_intents SET anchor_height = ? WHERE id = ?').run(anchor.height, id);
      audit(this.db, input.merchantId, 'BRIDGE_QUOTED', id, { rail, direction, amount, fee, net });
      return { intent: publicBridge(this.bridgeRow(id)), anchorHeight: anchor.height };
    });
  }

  settleBridge(intentId: string, nowMs: number = Date.now()) {
    const now = nowIso(nowMs);
    const outcome = tx(this.db, () => {
      const intent = this.bridgeRow(intentId);
      if (intent.status !== 'QUOTED') throw Errors.conflict('Intenção não está cotada.');
      if (now >= intent.expires_at) {
        this.db.prepare("UPDATE bridge_intents SET status = 'EXPIRED' WHERE id = ?").run(intent.id);
        return null;
      }
      this.db.prepare("UPDATE bridge_intents SET status = 'SETTLED', settled_at = ? WHERE id = ?").run(now, intent.id);
      const anchor = appendAnchor(
        this.db,
        { type: 'BRIDGE_SETTLED', intentId: intent.id, rail: intent.rail, direction: intent.direction, netCents: intent.net_cents },
        now,
      );
      this.db.prepare('UPDATE bridge_intents SET anchor_height = ? WHERE id = ?').run(anchor.height, intent.id);
      enqueueEvent(this.db, {
        topic: 'bridge.settled',
        type: 'PonteLiquidada',
        key: intent.merchant_id,
        payload: { intentId: intent.id, rail: intent.rail, netCents: intent.net_cents, anchorHeight: anchor.height },
      });
      audit(this.db, intent.merchant_id, 'BRIDGE_SETTLED', intent.id, { rail: intent.rail, netCents: intent.net_cents });
      return { intent: publicBridge(this.bridgeRow(intent.id)), anchorHeight: anchor.height };
    });
    if (!outcome) throw Errors.conflict('Cotação expirada; gere uma nova.');
    return outcome;
  }

  listBridges(merchantId?: string) {
    const rows = (
      merchantId
        ? this.db.prepare('SELECT * FROM bridge_intents WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 30').all(merchantId)
        : this.db.prepare('SELECT * FROM bridge_intents ORDER BY created_at DESC LIMIT 30').all()
    ) as unknown as BridgeRow[];
    return rows.map(publicBridge);
  }

  bridgeRails() {
    return (Object.keys(RAIL_META) as BridgeRail[]).map((rail) => ({
      rail,
      label: RAIL_META[rail].label,
      feeBps: RAIL_META[rail].feeBps,
      rate: RAIL_META[rail].rate,
      minFeeCents: 50,
    }));
  }

  // ── Credenciais e prova de inclusão ──────────────────────────────────────

  issueCredential(input: { subjectId: string; claimType: string; salt?: string; value: string }) {
    const subjectId = holderId(input.subjectId, 'subjectId');
    const claimType = assertNonEmptyString(input.claimType, 'claimType', 80);
    const value = assertNonEmptyString(input.value, 'value', 500);
    const salt = input.salt ? assertNonEmptyString(input.salt, 'salt', 200) : randomToken(16);
    const commitment = commitClaim({ subjectId, claimType, salt, value });
    const id = newId('zkc');
    const now = nowIso();

    return tx(this.db, () => {
      if (this.db.prepare('SELECT 1 AS found FROM zk_credentials WHERE commitment = ?').get(commitment)) {
        throw Errors.conflict('Credencial já registrada.');
      }
      this.db
        .prepare('INSERT INTO zk_credentials (id, subject_id, claim_type, commitment, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, subjectId, claimType, commitment, now);
      const anchor = appendAnchor(this.db, { type: 'ZK_CREDENTIAL_ISSUED', credentialId: id, claimType, commitment }, now);
      audit(this.db, subjectId, 'ZK_CREDENTIAL_ISSUED', id, { claimType, commitment });
      return { id, subjectId, claimType, commitment, salt, anchorHeight: anchor.height, createdAt: now };
    });
  }

  listCredentials(subjectId: string) {
    const rows = this.db
      .prepare('SELECT id, subject_id, claim_type, commitment, created_at FROM zk_credentials WHERE subject_id = ? ORDER BY created_at DESC')
      .all(subjectId) as Array<{ id: string; subject_id: string; claim_type: string; commitment: string; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      subjectId: row.subject_id,
      claimType: row.claim_type,
      commitment: row.commitment,
      createdAt: row.created_at,
    }));
  }

  proveCredential(input: { subjectId: string; claimType: string; salt: string; value: string }) {
    const commitment = commitClaim(input);
    const rows = this.db
      .prepare('SELECT commitment FROM zk_credentials WHERE claim_type = ? ORDER BY created_at ASC')
      .all(input.claimType) as Array<{ commitment: string }>;
    const commitments = rows.map((row) => row.commitment);
    if (!commitments.includes(commitment)) throw Errors.notFound('Credencial não encontrada para o conjunto informado.');
    const proof = merkleProof(buildMerkleTree(commitments), commitments.indexOf(commitment));
    const anchor = latestAnchor(this.db);
    return {
      commitment,
      claimType: input.claimType,
      root: proof.root,
      proof,
      valid: verifyMerkleProof(proof),
      setSize: commitments.length,
      anchorHeight: anchor?.height ?? 0,
    };
  }

  verifyProof(proof: MerkleProof) {
    if (!proof || typeof proof !== 'object') throw Errors.validation('Prova inválida.');
    return { valid: verifyMerkleProof(proof), root: proof.root };
  }

  verifyCommitment(commitment: string, input: { subjectId: string; claimType: string; salt: string; value: string }) {
    return { valid: verifyCommitment(commitment, input) };
  }

  // ── Visão geral ──────────────────────────────────────────────────────────

  anchorStatus() {
    const chain = verifyAnchorChain(this.db);
    const latest = latestAnchor(this.db);
    return {
      height: latest?.height ?? 0,
      latestHash: latest?.anchorHash ?? null,
      latestAt: latest?.createdAt ?? null,
      chain,
    };
  }

  listAnchors(limit = 50) {
    return listAnchors(this.db, limit);
  }

  overview(merchantId: string) {
    const assets = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(supply_units), 0) AS supplyUnits, COALESCE(SUM(reserve_cents), 0) AS reserveCents
           FROM token_assets WHERE merchant_id = ?`,
      )
      .get(merchantId) as { count: number; supplyUnits: number; reserveCents: number };
    const bio = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'ADMITTED' THEN 1 ELSE 0 END), 0) AS admitted
           FROM bio_assets WHERE merchant_id = ?`,
      )
      .get(merchantId) as { total: number; admitted: number };
    const royalties = this.db
      .prepare(
        `SELECT COALESCE(SUM(r.royalty_cents), 0) AS cents, COUNT(*) AS count
           FROM bio_royalties r JOIN bio_assets b ON b.id = r.bio_asset_id
          WHERE b.merchant_id = ?`,
      )
      .get(merchantId) as { cents: number; count: number };
    const depin = this.db
      .prepare(
        `SELECT COUNT(DISTINCT d.id) AS devices, COALESCE(SUM(r.amount_cents), 0) AS cents, COALESCE(SUM(r.units), 0) AS units
           FROM depin_devices d LEFT JOIN depin_rewards r ON r.device_id = d.id
          WHERE d.merchant_id = ?`,
      )
      .get(merchantId) as { devices: number; cents: number; units: number };
    const dao = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END), 0) AS openProposals,
                COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END), 0) AS approved,
                COALESCE(SUM(votes_for + votes_against), 0) AS votes
           FROM dao_proposals`,
      )
      .get() as { openProposals: number; approved: number; votes: number };
    const agents = this.db
      .prepare(
        `SELECT COUNT(DISTINCT p.id) AS policies,
                COUNT(d.id) AS decisions,
                COALESCE(SUM(CASE WHEN d.decision = 'BLOCK' THEN 1 ELSE 0 END), 0) AS blocked,
                COALESCE(SUM(CASE WHEN d.decision = 'REVIEW' THEN 1 ELSE 0 END), 0) AS review
           FROM agent_policies p LEFT JOIN agent_decisions d ON d.policy_id = p.id
          WHERE p.merchant_id = ?`,
      )
      .get(merchantId) as { policies: number; decisions: number; blocked: number; review: number };
    const bridges = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN net_cents ELSE 0 END), 0) AS volumeCents
           FROM bridge_intents WHERE merchant_id = ?`,
      )
      .get(merchantId) as { total: number; volumeCents: number };
    const anchors = this.anchorStatus();

    return {
      assets: {
        count: assets.count,
        supplyUnits: assets.supplyUnits,
        reserveCents: assets.reserveCents,
        reserveFormatted: formatBRL(assets.reserveCents),
      },
      bio: {
        total: bio.total,
        admitted: bio.admitted,
        royaltyCents: royalties.cents,
        royaltyFormatted: formatBRL(royalties.cents),
        royaltyCount: royalties.count,
      },
      depin: {
        devices: depin.devices,
        rewardCents: depin.cents,
        rewardFormatted: formatBRL(depin.cents),
        units: depin.units,
      },
      dao,
      agents,
      bridges: {
        total: bridges.total,
        volumeCents: bridges.volumeCents,
        volumeFormatted: formatBRL(bridges.volumeCents),
      },
      anchors: { height: anchors.height, latestHash: anchors.latestHash, valid: anchors.chain.valid },
      generatedAt: nowIso(),
    };
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  private assetRow(assetIdOrSymbol: string): AssetRow {
    const row = this.assetRowOrNull(assetIdOrSymbol);
    if (!row) throw Errors.notFound('Ativo tokenizado não encontrado.');
    return row;
  }

  private assetRowOrNull(assetIdOrSymbol: string): AssetRow | undefined {
    return this.db
      .prepare('SELECT * FROM token_assets WHERE id = ? OR symbol = ?')
      .get(assetIdOrSymbol, assetIdOrSymbol.toUpperCase()) as AssetRow | undefined;
  }

  private holdingUnits(assetId: string, holder: string): number {
    const row = this.db
      .prepare('SELECT units FROM token_holdings WHERE asset_id = ? AND holder_id = ?')
      .get(assetId, holder) as { units: number } | undefined;
    return row?.units ?? 0;
  }

  private bioRow(bioId: string): BioRow {
    const row = this.db.prepare('SELECT * FROM bio_assets WHERE id = ?').get(bioId) as BioRow | undefined;
    if (!row) throw Errors.notFound('Bioativo não encontrado.');
    return row;
  }

  private deviceRow(deviceId: string): DeviceRow {
    const row = this.db.prepare('SELECT * FROM depin_devices WHERE id = ?').get(deviceId) as DeviceRow | undefined;
    if (!row) throw Errors.notFound('Dispositivo DePIN não encontrado.');
    return row;
  }

  private proposalRow(proposalId: string): ProposalRow {
    const row = this.db.prepare('SELECT * FROM dao_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
    if (!row) throw Errors.notFound('Proposta não encontrada.');
    return row;
  }

  private policyRow(policyId: string): PolicyRow {
    const row = this.db.prepare('SELECT * FROM agent_policies WHERE id = ?').get(policyId) as PolicyRow | undefined;
    if (!row) throw Errors.notFound('Política de agente não encontrada.');
    return row;
  }

  private bridgeRow(intentId: string): BridgeRow {
    const row = this.db.prepare('SELECT * FROM bridge_intents WHERE id = ?').get(intentId) as BridgeRow | undefined;
    if (!row) throw Errors.notFound('Intenção de ponte não encontrada.');
    return row;
  }
}
