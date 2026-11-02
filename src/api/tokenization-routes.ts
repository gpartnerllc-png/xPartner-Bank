import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TokenPayload } from '../kernel/crypto.ts';
import { Errors } from '../kernel/errors.ts';
import type { TokenizationHub } from '../modules/tokenization.ts';
import { assertMerchantScope } from './security.ts';

export interface TokenizationGuards {
  requireRead: (request: FastifyRequest) => TokenPayload;
  requireWrite: (request: FastifyRequest) => TokenPayload;
  assertDemo: () => void;
}

interface Body {
  [key: string]: unknown;
}

function body(request: FastifyRequest): Body {
  return (request.body ?? {}) as Body;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

export function registerTokenizationRoutes(
  app: FastifyInstance,
  hub: TokenizationHub,
  guards: TokenizationGuards,
): void {
  const { requireRead, requireWrite } = guards;

  // ── Visão geral e âncoras ────────────────────────────────────────────────
  app.get('/v1/tokenization/overview', async (request) => {
    const claims = requireRead(request);
    return hub.overview(claims.merchantId);
  });

  app.get('/v1/tokenization/anchors', async (request) => {
    requireRead(request);
    const { limit } = request.query as { limit?: string };
    return { status: hub.anchorStatus(), data: hub.listAnchors(Number.parseInt(limit ?? '30', 10) || 30) };
  });

  // ── Ativos ───────────────────────────────────────────────────────────────
  app.get('/v1/tokenization/assets', async (request) => {
    const claims = requireRead(request);
    return { data: hub.listAssets(claims.merchantId) };
  });

  app.post('/v1/tokenization/assets', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.createAsset({
      merchantId: claims.merchantId,
      kind: String(input.kind ?? ''),
      name: String(input.name ?? ''),
      symbol: String(input.symbol ?? ''),
      description: text(input.description),
      backingPerUnitCents: num(input.backingPerUnitCents),
      maxUnits: num(input.maxUnits),
      maturityAt: text(input.maturityAt),
      couponBps: input.couponBps === undefined ? undefined : num(input.couponBps),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/tokenization/assets/:id', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    const asset = hub.getAsset(id);
    assertMerchantScope(claims, asset.merchantId);
    return { asset, holdings: hub.getAssetHoldings(id), events: hub.listEvents(id, 30) };
  });

  app.get('/v1/tokenization/assets/:id/events', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    const asset = hub.getAsset(id);
    assertMerchantScope(claims, asset.merchantId);
    return { data: hub.listEvents(id, 50) };
  });

  app.post('/v1/tokenization/assets/:id/mint', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    assertMerchantScope(claims, hub.getAsset(id).merchantId);
    const input = body(request);
    const result = hub.mint({
      assetId: id,
      holderId: text(input.holderId) ?? claims.merchantId,
      units: num(input.units),
      actor: claims.merchantId,
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/tokenization/assets/:id/transfer', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    assertMerchantScope(claims, hub.getAsset(id).merchantId);
    const input = body(request);
    const result = hub.transfer({
      assetId: id,
      fromHolder: text(input.fromHolder) ?? claims.merchantId,
      toHolder: String(input.toHolder ?? ''),
      units: num(input.units),
      actor: claims.merchantId,
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/tokenization/assets/:id/redeem', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    assertMerchantScope(claims, hub.getAsset(id).merchantId);
    const input = body(request);
    const result = hub.redeem({
      assetId: id,
      holderId: text(input.holderId) ?? claims.merchantId,
      units: num(input.units),
      actor: claims.merchantId,
    });
    return reply.status(201).send(result);
  });

  // ── Bioativos ────────────────────────────────────────────────────────────
  app.get('/v1/tokenization/bio', async (request) => {
    const claims = requireRead(request);
    return { data: hub.listBioAssets(claims.merchantId) };
  });

  app.post('/v1/tokenization/bio', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.createBioAsset({
      merchantId: claims.merchantId,
      name: String(input.name ?? ''),
      subjectPseudonym: String(input.subjectPseudonym ?? ''),
      consent: String(input.consent ?? ''),
      consentScope: String(input.consentScope ?? ''),
      datasetId: String(input.datasetId ?? ''),
      royaltyBps: num(input.royaltyBps),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/tokenization/bio/:id', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    const bioAsset = hub.getBioAsset(id);
    assertMerchantScope(claims, bioAsset.merchantId);
    return { bioAsset, royalties: hub.listRoyalties(id) };
  });

  app.post('/v1/tokenization/bio/:id/revoke', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    assertMerchantScope(claims, hub.getBioAsset(id).merchantId);
    const input = body(request);
    return hub.revokeBioAsset(id, String(input.reason ?? ''), claims.merchantId);
  });

  app.post('/v1/tokenization/bio/:id/royalties', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const input = body(request);
    const result = hub.payRoyalty({
      bioAssetId: id,
      payerId: text(input.payerId) ?? claims.merchantId,
      grossCents: num(input.grossCents),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/tokenization/bio/:id/royalties', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    assertMerchantScope(claims, hub.getBioAsset(id).merchantId);
    return { data: hub.listRoyalties(id) };
  });

  // ── DePIN / PoPW ─────────────────────────────────────────────────────────
  app.get('/v1/tokenization/depin/devices', async (request) => {
    const claims = requireRead(request);
    return { data: hub.listDevices(claims.merchantId) };
  });

  app.post('/v1/tokenization/depin/devices', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.registerDevice({
      merchantId: claims.merchantId,
      model: String(input.model ?? ''),
      capacityUnits: num(input.capacityUnits),
      proof: String(input.proof ?? ''),
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/tokenization/depin/devices/:id/rewards', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const device = hub.listDevices().find((item) => item.id === id);
    if (!device) throw Errors.notFound('Dispositivo DePIN não encontrado.');
    assertMerchantScope(claims, device.merchantId);
    const input = body(request);
    const result = hub.rewardDevice({
      deviceId: id,
      units: num(input.units),
      proof: String(input.proof ?? ''),
    });
    return reply.status(201).send(result);
  });

  // ── DAO ──────────────────────────────────────────────────────────────────
  app.get('/v1/tokenization/dao/proposals', async (request) => {
    requireRead(request);
    const { status } = request.query as { status?: string };
    return { data: hub.listProposals(status) };
  });

  app.post('/v1/tokenization/dao/proposals', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.createProposal({
      proposerId: text(input.proposerId) ?? claims.merchantId,
      kind: String(input.kind ?? ''),
      subject: String(input.subject ?? ''),
      title: String(input.title ?? ''),
      description: String(input.description ?? ''),
      quorumUnits: input.quorumUnits === undefined ? undefined : num(input.quorumUnits),
      durationHours: input.durationHours === undefined ? undefined : num(input.durationHours),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/tokenization/dao/proposals/:id', async (request) => {
    requireRead(request);
    const { id } = request.params as { id: string };
    return hub.getProposal(id);
  });

  app.post('/v1/tokenization/dao/proposals/:id/vote', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const input = body(request);
    const result = hub.vote({
      proposalId: id,
      voterId: text(input.voterId) ?? claims.merchantId,
      choice: String(input.choice ?? ''),
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/tokenization/dao/proposals/:id/close', async (request) => {
    requireWrite(request);
    const { id } = request.params as { id: string };
    return hub.closeProposal(id);
  });

  // ── Agentes com guardrails ───────────────────────────────────────────────
  app.get('/v1/tokenization/agents/policies', async (request) => {
    const claims = requireRead(request);
    return { data: hub.listPolicies(claims.merchantId) };
  });

  app.post('/v1/tokenization/agents/policies', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const symbols = Array.isArray(input.allowedSymbols)
      ? (input.allowedSymbols as unknown[]).map((symbol) => String(symbol))
      : [];
    const result = hub.createAgentPolicy({
      merchantId: claims.merchantId,
      name: String(input.name ?? ''),
      allowedSymbols: symbols,
      maxNotionalCents: num(input.maxNotionalCents),
      dailyLimitCents: num(input.dailyLimitCents),
      humanApprovalAboveCents: num(input.humanApprovalAboveCents),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/tokenization/agents/decisions', async (request) => {
    const claims = requireRead(request);
    const { limit } = request.query as { limit?: string };
    return { data: hub.listDecisions(claims.merchantId, Number.parseInt(limit ?? '30', 10) || 30) };
  });

  app.post('/v1/tokenization/agents/evaluate', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const policyId = String(input.policyId ?? '');
    const policy = hub.listPolicies(claims.merchantId).find((item) => item.id === policyId);
    if (!policy) throw Errors.notFound('Política de agente não encontrada.');
    const result = hub.evaluateAgentAction({
      policyId,
      agent: String(input.agent ?? ''),
      action: String(input.action ?? ''),
      symbol: String(input.symbol ?? ''),
      notionalCents: num(input.notionalCents),
    });
    return reply.status(201).send(result);
  });

  // ── Pontes multi-trilho ──────────────────────────────────────────────────
  app.get('/v1/tokenization/bridges/rails', async (request) => {
    requireRead(request);
    return { data: hub.bridgeRails() };
  });

  app.get('/v1/tokenization/bridges', async (request) => {
    const claims = requireRead(request);
    return { data: hub.listBridges(claims.merchantId) };
  });

  app.post('/v1/tokenization/bridges/quote', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.quoteBridge({
      merchantId: claims.merchantId,
      rail: String(input.rail ?? ''),
      direction: String(input.direction ?? ''),
      amountCents: num(input.amountCents),
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/tokenization/bridges/:id/settle', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const intent = hub.listBridges(claims.merchantId).find((item) => item.id === id);
    if (!intent) throw Errors.notFound('Intenção de ponte não encontrada.');
    return reply.status(201).send(hub.settleBridge(id));
  });

  // ── Credenciais e provas Merkle ──────────────────────────────────────────
  app.post('/v1/tokenization/zk/credentials', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.issueCredential({
      subjectId: text(input.subjectId) ?? claims.merchantId,
      claimType: String(input.claimType ?? ''),
      salt: text(input.salt),
      value: String(input.value ?? ''),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/tokenization/zk/credentials', async (request) => {
    const claims = requireRead(request);
    const { subjectId } = request.query as { subjectId?: string };
    return { data: hub.listCredentials(subjectId ?? claims.merchantId) };
  });

  app.post('/v1/tokenization/zk/prove', async (request) => {
    requireRead(request);
    const input = body(request);
    return hub.proveCredential({
      subjectId: String(input.subjectId ?? ''),
      claimType: String(input.claimType ?? ''),
      salt: String(input.salt ?? ''),
      value: String(input.value ?? ''),
    });
  });

  app.post('/v1/tokenization/zk/verify', async (request) => {
    requireRead(request);
    const input = body(request);
    return hub.verifyProof(input.proof as Parameters<TokenizationHub['verifyProof']>[0]);
  });
}
