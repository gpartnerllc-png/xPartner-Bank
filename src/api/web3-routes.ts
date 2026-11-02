import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TokenPayload } from '../kernel/crypto.ts';
import { Errors } from '../kernel/errors.ts';
import type { Web3Hub } from '../modules/web3.ts';

export interface Web3Guards {
  requireRead: (request: FastifyRequest) => TokenPayload;
  requireWrite: (request: FastifyRequest) => TokenPayload;
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

function optNum(value: unknown): number | undefined {
  return value === undefined ? undefined : num(value);
}

function optText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function limitOf(request: FastifyRequest, fallback = 50): number {
  const { limit } = request.query as { limit?: string };
  const parsed = Number.parseInt(limit ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
}

/**
 * Rotas do stack Web3 institucional. Toda escrita é escopada ao titular do token Bearer para
 * maker/merchant/liquidator; o taker de uma oferta é sempre o próprio titular.
 */
export function registerWeb3Routes(app: FastifyInstance, hub: Web3Hub, guards: Web3Guards): void {
  const { requireRead, requireWrite } = guards;

  // ── Visão geral ──────────────────────────────────────────────────────────
  app.get('/v1/web3/overview', async (request) => {
    const claims = requireRead(request);
    return hub.overview(claims.merchantId);
  });

  // ── Redes / AppChains / Subnets ──────────────────────────────────────────
  app.get('/v1/web3/networks', async (request) => {
    requireRead(request);
    const { status } = request.query as { status?: string };
    return { data: hub.listNetworks(status) };
  });

  app.post('/v1/web3/networks', async (request, reply) => {
    requireWrite(request);
    const input = body(request);
    const result = hub.registerNetwork({
      name: String(input.name ?? ''),
      chainId: num(input.chainId),
      kind: String(input.kind ?? ''),
      rpcUrl: String(input.rpcUrl ?? ''),
      explorerUrl: optText(input.explorerUrl),
      nativeSymbol: optText(input.nativeSymbol),
      bridgeContract: optText(input.bridgeContract),
      tokenContract: optText(input.tokenContract),
      dvpContract: optText(input.dvpContract),
      paymasterContract: optText(input.paymasterContract),
      finalitySeconds: optNum(input.finalitySeconds),
      governance: optText(input.governance),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/networks/:id', async (request) => {
    requireRead(request);
    const { id } = request.params as { id: string };
    return { network: hub.getNetwork(id) };
  });

  // ── Oráculo com staleness ────────────────────────────────────────────────
  app.get('/v1/web3/oracle/feeds', async (request) => {
    requireRead(request);
    return { data: hub.listFeeds() };
  });

  app.post('/v1/web3/oracle/feeds', async (request, reply) => {
    requireWrite(request);
    const input = body(request);
    const result = hub.registerFeed({
      symbol: String(input.symbol ?? ''),
      source: String(input.source ?? 'XPARTNER'),
      decimals: optNum(input.decimals),
      maxAgeSeconds: optNum(input.maxAgeSeconds),
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/web3/oracle/prices', async (request, reply) => {
    requireWrite(request);
    const input = body(request);
    const result = hub.publishPrice({
      symbol: String(input.symbol ?? ''),
      priceUnits: num(input.priceUnits),
      source: optText(input.source),
      publishedAt: optText(input.publishedAt),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/oracle/prices/:symbol', async (request) => {
    requireRead(request);
    const { symbol } = request.params as { symbol: string };
    return { price: hub.readPrice(symbol) };
  });

  // ── DVP atômico ──────────────────────────────────────────────────────────
  app.get('/v1/web3/dvp/offers', async (request) => {
    const claims = requireRead(request);
    const { status, mine } = request.query as { status?: string; mine?: string };
    return {
      data: hub.listOffers({
        status,
        makerId: mine === 'true' ? claims.merchantId : undefined,
        limit: limitOf(request),
      }),
    };
  });

  app.post('/v1/web3/dvp/offers', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.createOffer({
      networkId: String(input.networkId ?? ''),
      makerId: claims.merchantId,
      takerId: optText(input.takerId),
      kind: String(input.kind ?? ''),
      sellSymbol: String(input.sellSymbol ?? ''),
      sellUnits: num(input.sellUnits),
      buySymbol: optText(input.buySymbol),
      buyUnits: optNum(input.buyUnits),
      cashCents: optNum(input.cashCents),
      feeBps: optNum(input.feeBps),
      nonce: optText(input.nonce),
      expiresInSeconds: optNum(input.expiresInSeconds),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/dvp/offers/:id', async (request) => {
    requireRead(request);
    const { id } = request.params as { id: string };
    return { offer: hub.getOffer(id) };
  });

  app.post('/v1/web3/dvp/offers/:id/accept', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const result = hub.acceptOffer({ offerId: id, takerId: claims.merchantId });
    return reply.status(201).send(result);
  });

  app.post('/v1/web3/dvp/offers/:id/cancel', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const result = hub.cancelOffer(id, claims.merchantId);
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/dvp/trades', async (request) => {
    const claims = requireRead(request);
    const { mine } = request.query as { mine?: string };
    return {
      data: hub.listTrades({
        merchantId: mine === 'true' ? claims.merchantId : undefined,
        limit: limitOf(request),
      }),
    };
  });

  // ── Crédito agro com colateral tokenizado ────────────────────────────────
  app.get('/v1/web3/agro/contracts', async (request) => {
    const claims = requireRead(request);
    const { status, mine } = request.query as { status?: string; mine?: string };
    return {
      data: hub.listAgroContracts({
        merchantId: mine === 'true' ? claims.merchantId : undefined,
        status,
        limit: limitOf(request),
      }),
    };
  });

  app.post('/v1/web3/agro/contracts', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.openAgroContract({
      networkId: String(input.networkId ?? ''),
      merchantId: claims.merchantId,
      collateralSymbol: String(input.collateralSymbol ?? ''),
      collateralUnits: num(input.collateralUnits),
      principalCents: num(input.principalCents),
      interestBps: optNum(input.interestBps),
      ltvBps: optNum(input.ltvBps),
      liquidationLtvBps: optNum(input.liquidationLtvBps),
      liquidationBonusBps: optNum(input.liquidationBonusBps),
      oracleSymbol: optText(input.oracleSymbol),
      durationDays: optNum(input.durationDays),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/agro/contracts/:id', async (request) => {
    requireRead(request);
    const { id } = request.params as { id: string };
    return { contract: hub.getAgroContract(id) };
  });

  app.post('/v1/web3/agro/contracts/:id/repay', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const input = body(request);
    const result = hub.repayAgro({
      contractId: id,
      merchantId: claims.merchantId,
      amountCents: optNum(input.amountCents),
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/web3/agro/contracts/:id/liquidate', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const result = hub.liquidateAgro({ contractId: id, liquidatorId: claims.merchantId });
    return reply.status(201).send(result);
  });

  // ── Atestação de predicado e nullifiers ──────────────────────────────────
  app.get('/v1/web3/zk/attestations', async (request) => {
    requireRead(request);
    const { commitment } = request.query as { commitment?: string };
    return { data: hub.listAttestations(commitment) };
  });

  app.post('/v1/web3/zk/attestations', async (request, reply) => {
    requireWrite(request);
    const input = body(request);
    const result = hub.attestClaim({
      commitment: String(input.commitment ?? ''),
      claimType: String(input.claimType ?? ''),
      predicate: String(input.predicate ?? ''),
      threshold: num(input.threshold),
      issuer: String(input.issuer ?? ''),
      expiresInSeconds: optNum(input.expiresInSeconds),
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/web3/zk/attestations/:id/revoke', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return reply.status(201).send({ ...hub.revokeAttestation(id, claims.merchantId) });
  });

  app.post('/v1/web3/zk/verify', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.verifyClaim({
      attestationId: String(input.attestationId ?? ''),
      purpose: String(input.purpose ?? ''),
      relyingParty: optText(input.relyingParty) ?? claims.merchantId,
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/zk/verifications', async (request) => {
    requireRead(request);
    return { data: hub.listVerifications(limitOf(request)) };
  });

  // ── Sessões de agente (ERC-4337) ─────────────────────────────────────────
  app.get('/v1/web3/agents/sessions', async (request) => {
    const claims = requireRead(request);
    return { data: hub.listAgentSessions({ merchantId: claims.merchantId, limit: limitOf(request) }) };
  });

  app.post('/v1/web3/agents/sessions', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const selectors = Array.isArray(input.allowedSelectors) ? (input.allowedSelectors as unknown[]) : [];
    const result = hub.grantAgentSession({
      policyId: String(input.policyId ?? ''),
      merchantId: claims.merchantId,
      networkId: String(input.networkId ?? ''),
      agent: String(input.agent ?? ''),
      allowedSelectors: selectors,
      spendCapCents: num(input.spendCapCents),
      ttlSeconds: optNum(input.ttlSeconds),
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/web3/agents/sessions/:id/authorize', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const input = body(request);
    const session = hub.listAgentSessions({ merchantId: claims.merchantId, limit: 200 }).find((row) => row.id === id);
    if (!session) throw Errors.notFound('Sessão de agente não encontrada.');
    const result = hub.authorizeAgentAction({
      sessionId: id,
      sessionKey: String(input.sessionKey ?? ''),
      action: String(input.action ?? ''),
      selector: String(input.selector ?? ''),
      symbol: String(input.symbol ?? ''),
      notionalCents: num(input.notionalCents),
      humanApproved: input.humanApproved === true,
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/web3/agents/sessions/:id/revoke', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return reply.status(201).send(hub.revokeAgentSession(id, claims.merchantId));
  });

  // ── Paymaster (patrocínio de UserOps) ────────────────────────────────────
  app.get('/v1/web3/paymaster/budgets', async (request) => {
    const claims = requireRead(request);
    return { data: hub.listPaymasterBudgets({ merchantId: claims.merchantId, limit: limitOf(request) }) };
  });

  app.post('/v1/web3/paymaster/budgets', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.createPaymasterBudget({
      merchantId: claims.merchantId,
      networkId: String(input.networkId ?? ''),
      label: String(input.label ?? ''),
      capCents: num(input.capCents),
      perOpMaxCents: num(input.perOpMaxCents),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/paymaster/ops', async (request) => {
    const claims = requireRead(request);
    return { data: hub.listPaymasterOps({ merchantId: claims.merchantId, limit: limitOf(request) }) };
  });

  app.post('/v1/web3/paymaster/sponsor', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = hub.sponsorUserOp({
      budgetId: String(input.budgetId ?? ''),
      merchantId: claims.merchantId,
      userOpHash: String(input.userOpHash ?? ''),
      gasCents: num(input.gasCents),
    });
    return reply.status(201).send(result);
  });
}
