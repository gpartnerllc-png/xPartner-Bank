import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { log } from '../kernel/logger.ts';
import type { TokenizationHub } from './tokenization.ts';
import { DEMO_MERCHANT_ID } from './seed.ts';

const RISK_COMMITTEE = 'usr_comite_risco';
const AUDIT = 'usr_auditoria';
const DATA_LAB = 'usr_data_lab';

/**
 * Popula o ecossistema de tokenização na demonstração: ADLA, RWA, dívida, bioativo
 * admitido por DAO, dispositivo DePIN, agente com guardrails e pontes liquidadas.
 */
export function seedTokenization(db: Db, hub: TokenizationHub, config: AppConfig): void {
  if (!config.demoMode || !config.seedDemo) return;
  const existing = db.prepare('SELECT COUNT(*) AS count FROM token_assets').get() as { count: number };
  if (existing.count > 0) return;

  try {
    seedEcosystem(hub);
    log.info('seed.tokenization', { merchantId: DEMO_MERCHANT_ID });
  } catch (error) {
    log.error('seed.tokenization_failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

function seedEcosystem(hub: TokenizationHub): void {
  const now = Date.now();

  const governance = hub.createAsset({
    merchantId: DEMO_MERCHANT_ID,
    kind: 'RWA',
    name: 'ADLA — Governança xPartner',
    symbol: 'ADLA',
    description: 'Token de governança do consórcio xPartner, ponderado por unidades e sem promessa de renda.',
    backingPerUnitCents: 100,
    maxUnits: 10_000_000,
  });
  hub.mint({ assetId: governance.asset.id, holderId: DEMO_MERCHANT_ID, units: 100_000, actor: 'seed' });
  hub.mint({ assetId: governance.asset.id, holderId: RISK_COMMITTEE, units: 25_000, actor: 'seed' });
  hub.mint({ assetId: governance.asset.id, holderId: AUDIT, units: 10_000, actor: 'seed' });

  const receivables = hub.createAsset({
    merchantId: DEMO_MERCHANT_ID,
    kind: 'RWA',
    name: 'Recebíveis NFC-e — Lote SP',
    symbol: 'NFCR',
    description: 'Cessão tokenizada de recebíveis de cartão conciliados com NFC-e autorizada.',
    backingPerUnitCents: 1_000,
    maxUnits: 1_000_000,
    maturityAt: new Date(now + 45 * 86_400_000).toISOString(),
  });
  hub.mint({ assetId: receivables.asset.id, holderId: DEMO_MERCHANT_ID, units: 5_000, actor: 'seed' });
  hub.mint({ assetId: receivables.asset.id, holderId: DATA_LAB, units: 750, actor: 'seed' });
  hub.transfer({
    assetId: receivables.asset.id,
    fromHolder: DEMO_MERCHANT_ID,
    toHolder: AUDIT,
    units: 250,
    actor: 'seed',
  });

  const debt = hub.createAsset({
    merchantId: DEMO_MERCHANT_ID,
    kind: 'DEBT',
    name: 'TCA — Lote 2026-Q4',
    symbol: 'TCA26',
    description: 'Cotítulo de antecipação com lastro em recebíveis e cupom de 14,50% a.a.',
    backingPerUnitCents: 1_000,
    maxUnits: 500_000,
    maturityAt: new Date(now + 180 * 86_400_000).toISOString(),
    couponBps: 1_450,
  });
  hub.mint({ assetId: debt.asset.id, holderId: DEMO_MERCHANT_ID, units: 2_000, actor: 'seed' });
  hub.mint({ assetId: debt.asset.id, holderId: RISK_COMMITTEE, units: 500, actor: 'seed' });

  const bio = hub.createBioAsset({
    merchantId: DEMO_MERCHANT_ID,
    name: 'Mapa de demanda anônimo — Coorte SP',
    subjectPseudonym: 'subj_coorte_sp_0421',
    consent:
      'Consentimento TCLE-xp-2026-0421: uso anonimizado do histórico agregado de consumo para pesquisa de crédito PJ, revogável a qualquer momento.',
    consentScope: 'Pesquisa de demanda e modelagem de crédito PJ',
    datasetId: 'ds_coorte_sp_anon_v1',
    royaltyBps: 1_500,
  });
  const proposal = hub.createProposal({
    proposerId: DEMO_MERCHANT_ID,
    kind: 'ADMIT_BIO_SOURCE',
    subject: bio.bioAsset.id,
    title: 'Admitir bioativo da coorte SP',
    description: 'Consentimento verificável, dataset anonimizado e royalty de 15% ao titular.',
    quorumUnits: 500,
    durationHours: 1,
    now: now - 2 * 3_600_000,
  });
  hub.vote({ proposalId: proposal.proposal.id, voterId: DEMO_MERCHANT_ID, choice: 'FOR', now: now - 90 * 60_000 });
  hub.vote({ proposalId: proposal.proposal.id, voterId: RISK_COMMITTEE, choice: 'FOR', now: now - 80 * 60_000 });
  hub.closeProposal(proposal.proposal.id, now);
  hub.payRoyalty({ bioAssetId: bio.bioAsset.id, payerId: DATA_LAB, grossCents: 25_000 });

  const device = hub.registerDevice({
    merchantId: DEMO_MERCHANT_ID,
    model: 'XPartner Edge Box (TEE)',
    capacityUnits: 500,
    proof: 'attestation:XPEDGE-0001:tee-quote',
  });
  hub.rewardDevice({ deviceId: device.device.id, units: 300, proof: 'powp:XPEDGE-0001:batch-001' });
  hub.rewardDevice({ deviceId: device.device.id, units: 120, proof: 'powp:XPEDGE-0001:batch-002' });

  const policy = hub.createAgentPolicy({
    merchantId: DEMO_MERCHANT_ID,
    name: 'Tesouraria autônoma com guardrails',
    allowedSymbols: ['ADLA', 'NFCR', 'TCA26'],
    maxNotionalCents: 50_000,
    dailyLimitCents: 200_000,
    humanApprovalAboveCents: 20_000,
  });
  hub.evaluateAgentAction({
    policyId: policy.policy.id,
    agent: 'agent.tesouraria',
    action: 'BUY',
    symbol: 'NFCR',
    notionalCents: 5_000,
  });
  hub.evaluateAgentAction({
    policyId: policy.policy.id,
    agent: 'agent.tesouraria',
    action: 'BUY',
    symbol: 'NFCR',
    notionalCents: 30_000,
  });
  hub.evaluateAgentAction({
    policyId: policy.policy.id,
    agent: 'agent.tesouraria',
    action: 'SWAP',
    symbol: 'ETHX',
    notionalCents: 8_000,
  });

  for (const [rail, amount, direction] of [
    ['PIX', 100_000, 'OUT'],
    ['LIGHTNING', 50_000, 'OUT'],
    ['DREX', 75_000, 'IN'],
  ] as const) {
    const quote = hub.quoteBridge({ merchantId: DEMO_MERCHANT_ID, rail, direction, amountCents: amount });
    hub.settleBridge(quote.intent.id);
  }

  hub.issueCredential({ subjectId: DEMO_MERCHANT_ID, claimType: 'KYC_STATUS', value: 'nivel:2:aprovado' });
  hub.issueCredential({ subjectId: RISK_COMMITTEE, claimType: 'KYC_STATUS', value: 'nivel:3:aprovado' });
  hub.issueCredential({ subjectId: AUDIT, claimType: 'KYC_STATUS', value: 'nivel:3:aprovado' });
  hub.issueCredential({ subjectId: DEMO_MERCHANT_ID, claimType: 'LIMITE_PIX', value: 'limite:50000' });
}
