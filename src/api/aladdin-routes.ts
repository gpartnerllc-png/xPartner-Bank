import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TokenPayload } from '../kernel/crypto.ts';
import type { AladdinEngine } from '../modules/aladdin.ts';
import type { CrossChainHub } from '../modules/crosschain.ts';

export interface AladdinGuards {
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

function optBool(value: unknown): boolean | undefined {
  return value === undefined ? undefined : value === true;
}

function limitOf(request: FastifyRequest, fallback = 50): number {
  const { limit } = request.query as { limit?: string };
  const parsed = Number.parseInt(limit ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
}

/**
 * Motor Aladdin e tokenização cross-chain por intents.
 * Toda operação é escopada ao titular do Bearer: risco, provas, empréstimos, intents,
 * liquidez e cotações nunca cruzam carteiras sem checagem de propriedade no serviço.
 */
export function registerAladdinRoutes(
  app: FastifyInstance,
  aladdin: AladdinEngine,
  crosschain: CrossChainHub,
  guards: AladdinGuards,
): void {
  const { requireRead, requireWrite } = guards;

  // ── Visão geral ──────────────────────────────────────────────────────────
  app.get('/v1/web3/aladdin/overview', async (request) => {
    const claims = requireRead(request);
    return aladdin.overview(claims.merchantId);
  });

  // ── Risco quantitativo ───────────────────────────────────────────────────
  app.get('/v1/web3/aladdin/risk/metrics', async (request) => {
    const claims = requireRead(request);
    return { data: aladdin.listRisk(claims.merchantId, limitOf(request, 20)) };
  });

  app.post('/v1/web3/aladdin/risk/simulate', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = aladdin.simulateRisk({
      merchantId: claims.merchantId,
      volatilityBps: optNum(input.volatilityBps),
      driftBps: optNum(input.driftBps),
      samples: optNum(input.samples),
      confidenceBps: optNum(input.confidenceBps),
      ttlSeconds: optNum(input.ttlSeconds),
      hasCollateral: optBool(input.hasCollateral),
      onTimeRatioBps: optNum(input.onTimeRatioBps),
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/web3/aladdin/risk/metrics', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = aladdin.recordRisk({
      merchantId: claims.merchantId,
      varBps: num(input.varBps),
      volatilityBps: num(input.volatilityBps),
      creditScore: num(input.creditScore),
      model: text(input.model),
      source: text(input.source),
      sampleSize: optNum(input.sampleSize),
      ttlSeconds: optNum(input.ttlSeconds),
    });
    return reply.status(201).send(result);
  });

  // ── Prova Groth16 de patrimônio ──────────────────────────────────────────
  app.post('/v1/web3/aladdin/zk/prove', async (request, reply) => {
    requireWrite(request);
    const input = body(request);
    const result = await aladdin.prove({
      netWorthCents: num(input.netWorthCents),
      salt: String(input.salt ?? ''),
      thresholdCents: num(input.thresholdCents),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/aladdin/zk/proofs', async (request) => {
    const claims = requireRead(request);
    return { data: aladdin.listProofs(claims.merchantId, limitOf(request, 20)) };
  });

  app.post('/v1/web3/aladdin/zk/proofs', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = await aladdin.submitProof({
      merchantId: claims.merchantId,
      circuit: text(input.circuit),
      thresholdCents: num(input.thresholdCents),
      proof: input.proof,
      publicSignals: input.publicSignals,
      expectedCommitment: text(input.commitment),
    });
    return reply.status(201).send(result);
  });

  // ── Crédito algorítmico ──────────────────────────────────────────────────
  app.get('/v1/web3/aladdin/loans', async (request) => {
    const claims = requireRead(request);
    return { data: aladdin.listLoans(claims.merchantId, limitOf(request, 20)) };
  });

  app.post('/v1/web3/aladdin/loans', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = aladdin.openLoan({
      borrowerId: claims.merchantId,
      principalCents: num(input.principalCents),
      zkProofId: String(input.zkProofId ?? ''),
      interestBps: optNum(input.interestBps),
      durationDays: optNum(input.durationDays),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/aladdin/loans/:id', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    return { loan: aladdin.getLoan(id, claims.merchantId) };
  });

  app.post('/v1/web3/aladdin/loans/:id/repay', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const input = body(request);
    return aladdin.repayLoan({
      loanId: id,
      borrowerId: claims.merchantId,
      amountCents: optNum(input.amountCents),
    });
  });

  // ── CCIP: lanes e liquidez P2P ───────────────────────────────────────────
  app.get('/v1/web3/ccip/lanes', async (request) => {
    requireRead(request);
    const { status } = request.query as { status?: string };
    return { data: crosschain.listLanes(status) };
  });

  app.post('/v1/web3/ccip/lanes', async (request, reply) => {
    requireWrite(request);
    const input = body(request);
    const result = crosschain.registerLane({
      name: String(input.name ?? ''),
      sourceChainId: num(input.sourceChainId),
      destChainId: num(input.destChainId),
      sourceSelector: String(input.sourceSelector ?? ''),
      destSelector: String(input.destSelector ?? ''),
      router: String(input.router ?? ''),
      receiver: String(input.receiver ?? ''),
      feeBps: optNum(input.feeBps),
      maxUnits: optNum(input.maxUnits),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/ccip/liquidity', async (request) => {
    requireRead(request);
    const { laneId, status } = request.query as { laneId?: string; status?: string };
    return { data: crosschain.listLiquidity({ laneId, status }) };
  });

  app.post('/v1/web3/ccip/liquidity', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = crosschain.registerLiquidity({
      merchantId: claims.merchantId,
      laneId: String(input.laneId ?? ''),
      symbol: String(input.symbol ?? ''),
      availableUnits: num(input.availableUnits),
      rateBps: optNum(input.rateBps),
      riskTier: text(input.riskTier),
    });
    return reply.status(201).send(result);
  });

  // ── Intents cross-chain ──────────────────────────────────────────────────
  app.get('/v1/web3/intents/overview', async (request) => {
    const claims = requireRead(request);
    return crosschain.overview(claims.merchantId);
  });

  app.get('/v1/web3/intents', async (request) => {
    const claims = requireRead(request);
    const { status } = request.query as { status?: string };
    return { data: crosschain.listIntents({ merchantId: claims.merchantId, status, limit: limitOf(request, 50) }) };
  });

  app.post('/v1/web3/intents', async (request, reply) => {
    const claims = requireWrite(request);
    const input = body(request);
    const result = crosschain.createIntent({
      merchantId: claims.merchantId,
      laneId: String(input.laneId ?? ''),
      symbol: String(input.symbol ?? ''),
      amountUnits: num(input.amountUnits),
      minDestUnits: num(input.minDestUnits),
      feeBudgetCents: optNum(input.feeBudgetCents),
      deadlineSeconds: optNum(input.deadlineSeconds),
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/web3/intents/:id', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    return crosschain.getIntent(id, claims.merchantId);
  });

  app.post('/v1/web3/intents/:id/quotes', async (request, reply) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const input = body(request);
    const result = crosschain.quoteIntent({
      intentId: id,
      solverId: claims.merchantId,
      providerMerchantId: claims.merchantId,
      destUnits: num(input.destUnits),
      feeCents: num(input.feeCents),
      etaSeconds: num(input.etaSeconds),
      riskBps: num(input.riskBps),
    });
    return reply.status(201).send(result);
  });

  app.post('/v1/web3/intents/:id/select', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const input = body(request);
    return crosschain.selectQuote(id, claims.merchantId, text(input.quoteId));
  });

  app.post('/v1/web3/intents/:id/execute', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return crosschain.executeIntent({ intentId: id, merchantId: claims.merchantId });
  });

  app.post('/v1/web3/intents/:id/cancel', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return crosschain.cancelIntent({ intentId: id, merchantId: claims.merchantId });
  });

  app.get('/v1/web3/ccip/messages', async (request) => {
    requireRead(request);
    const { laneId } = request.query as { laneId?: string };
    return { data: crosschain.listMessages({ laneId, limit: limitOf(request, 50) }) };
  });
}
