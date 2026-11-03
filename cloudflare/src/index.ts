import type { AuthContext, BankEvent, Env } from './types.ts';
import { HttpError, boolEnv, corsHeaders, errorResponse, json, readJson, requireAdmin, requireAuth } from './http.ts';
import {
  adminOverview,
  adminUserDetail,
  approveUser,
  auditLog,
  authenticate,
  changePassword,
  createSession,
  deleteUser,
  demoMode,
  listUsers,
  login,
  logout,
  register,
  rejectUser,
  resetUserPassword,
  sessionTtl,
  setBlocked,
} from './auth.ts';
import {
  aiInsights,
  creditScore,
  demoCapital,
  demoFx,
  funding,
  fxWallets,
  lookupRecipient,
  receipt,
  receiptFromR2,
  statement,
  statementCsv,
  transfer,
} from './bank.ts';
import { accountView, customerCount, userView } from './repo.ts';
import {
  creditCreate,
  creditExportCsv,
  creditGet,
  creditList,
  creditPayInstallment,
  creditQuote,
  creditSettleEarly,
} from './credit-service.ts';
import {
  adminListPixKeys,
  createPixEvp,
  createPixKey,
  listPixKeys,
  pixBrCode,
  removePixKey,
} from './pix-service.ts';
import {
  rsfnAck,
  rsfnAdminList,
  rsfnConfigView,
  rsfnCreate,
  rsfnGet,
  rsfnList,
  rsfnValidate,
} from './rsfn-service.ts';
import { RSFN_PAG0004_XSD } from './rsfn-xsd.ts';
import { openapi } from './openapi.ts';
import { clearSessionCookie, nowIso, rateLimit, sessionCookie } from './security.ts';
import type { RegisterInput } from './auth.ts';
import * as web3 from './web3-service.ts';
import {
  PURGE_CONFIRM_PHRASE,
  previewEdgePurge,
  previewMerchantDemoData,
  purgeEdgeDemoData,
  purgeMerchantDemoData,
} from './demo-purge.ts';
import { MerchantCore } from './merchant/core.ts';
import { issueMerchantSimulatorToken } from './merchant-session.ts';

const VERSION = '1.2.0-edge';

let web3Seed: Promise<void> | undefined;
async function web3Ready(env: Env): Promise<void> {
  // A rede mostra apenas fatos reais: as trilhas, preços e ofertas de
  // demonstração só voltam a existir se SEED_DEMO=true for explicitamente definido.
  if (!boolEnv(env.SEED_DEMO)) return;
  web3Seed ??= web3.ensureWeb3Seed(env).catch((error) => {
    web3Seed = undefined;
    throw error;
  });
  await web3Seed;
}

async function web3Context(env: Env, request: Request, write = false): Promise<AuthContext> {
  const context = requireReady(requireAuth(await authenticate(env, request)));
  await web3Ready(env);
  if (write) await rateLimit(env, `web3:write:${context.user.id}`, 120, 60);
  await web3.ensureHolder(env, context.user.id);
  return context;
}

function secureCookie(env: Env, request: Request): boolean {
  return new URL(request.url).protocol === 'https:' || env.ENVIRONMENT === 'production';
}

function cookieHeader(env: Env, request: Request, token: string): Record<string, string> {
  return { 'set-cookie': sessionCookie(token, sessionTtl(env), secureCookie(env, request)) };
}

function requireReady(context: AuthContext): AuthContext {
  if (context.user.must_change_password) {
    throw new HttpError(428, 'PASSWORD_CHANGE_REQUIRED', 'Troque a senha temporária antes de continuar.');
  }
  return context;
}

function withQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null || value === '' ? undefined : value;
}

function matchId(path: string, pattern: RegExp): string | null {
  const result = pattern.exec(path);
  return result?.[1] ?? null;
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  }

  if (path === '/health' && method === 'GET') {
    return json(env, request, { status: 'ok', service: 'xpartner-bank-edge', version: VERSION, at: nowIso() });
  }

  if (path === '/openapi.json' && method === 'GET') {
    return json(env, request, openapi);
  }

  if (path === '/v1/bank/status' && method === 'GET') {
    return json(env, request, {
      demoMode: demoMode(env),
      firstUserBecomesAdmin: demoMode(env),
      bootstrapTokenRequired: !demoMode(env) && !env.BOOTSTRAP_TOKEN,
      users: await customerCount(env),
      treasuryUserId: 'bank_user_system',
      ledger: 'D1 + trigger atômico (dupla entrada)',
      edge: {
        worker: 'cloudflare-workers',
        d1: true,
        kv: true,
        r2: true,
        queues: true,
        workersAi: true,
      },
    });
  }

  // ── Autenticação ─────────────────────────────────────────────────
  if (path === '/v1/bank/auth/register' && method === 'POST') {
    const body = await readJson<RegisterInput>(request);
    const result = await register(env, body, request);
    return json(
      env,
      request,
      {
        user: result.user,
        account: result.account,
        requiresApproval: result.requiresApproval,
        bootstrapAdmin: result.bootstrapAdmin,
        token: result.session?.token,
        csrfToken: result.session?.csrfToken,
        expiresAt: result.session?.expiresAt,
        message: result.requiresApproval
          ? 'Cadastro recebido. Aguarde a aprovação do administrador.'
          : 'Conta criada e sessão iniciada.',
      },
      201,
      result.session ? cookieHeader(env, request, result.session.token) : {},
    );
  }

  if (path === '/v1/bank/auth/login' && method === 'POST') {
    const body = await readJson<{ identifier?: string; password?: string; email?: string }>(request);
    const identifier = body.identifier ?? body.email ?? '';
    const result = await login(env, { identifier, password: String(body.password ?? '') }, request);
    return json(
      env,
      request,
      {
        user: result.user,
        account: result.account,
        token: result.session.token,
        csrfToken: result.session.csrfToken,
        expiresAt: result.session.expiresAt,
      },
      200,
      cookieHeader(env, request, result.session.token),
    );
  }

  if (path === '/v1/bank/auth/logout' && method === 'POST') {
    const context = requireAuth(await authenticate(env, request));
    await logout(env, context);
    return json(
      env,
      request,
      { ok: true },
      200,
      { 'set-cookie': clearSessionCookie(secureCookie(env, request)) },
    );
  }

  if (path === '/v1/bank/auth/change-password' && method === 'POST') {
    const context = requireAuth(await authenticate(env, request));
    const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request);
    const result = await changePassword(env, context, {
      currentPassword: String(body.currentPassword ?? ''),
      newPassword: String(body.newPassword ?? ''),
    });
    return json(env, request, { ok: true, ...result });
  }

  if (path === '/v1/bank/me' && method === 'GET') {
    const context = requireAuth(await authenticate(env, request));
    const account = context.account ? accountView(context.account) : null;
    return json(env, request, {
      user: userView(context.user, context.account, true),
      account,
      csrfToken: context.session.csrf_token,
      session: {
        csrfToken: context.session.csrf_token,
        expiresAt: context.session.expires_at,
        createdAt: context.session.created_at,
      },
      requiresPasswordChange: Boolean(context.user.must_change_password),
    });
  }

  // ── Conta, extrato e score ───────────────────────────────────────
  if (path === '/v1/bank/account' && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    if (!context.account) throw new HttpError(404, 'ACCOUNT_MISSING', 'Conta corrente não encontrada.');
    return json(env, request, { account: accountView(context.account) });
  }

  if (path === '/v1/bank/statement' && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(
      env,
      request,
      await statement(env, context, {
        from: withQuery(url, 'from'),
        to: withQuery(url, 'to'),
        limit: withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      }),
    );
  }

  if (path === '/v1/bank/statement.csv' && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    const csv = await statementCsv(env, context, { from: withQuery(url, 'from'), to: withQuery(url, 'to') });
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="extrato-xpartner.csv"',
        'cache-control': 'no-store',
        ...corsHeaders(env, request),
      },
    });
  }

  if (path === '/v1/bank/recipients/lookup' && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(
      env,
      request,
      await lookupRecipient(env, context, withQuery(url, 'type') ?? 'accountNumber', withQuery(url, 'q') ?? ''),
    );
  }

  if (path === '/v1/bank/credit/score' && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(env, request, await creditScore(env, context));
  }

  // ── Pix: chaves, BR Code e consulta por chave ────────────────────
  if (path === '/v1/bank/pix/keys' && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(env, request, await listPixKeys(env, context.user.id));
  }

  if (path === '/v1/bank/pix/keys' && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    await rateLimit(env, `pix:key:${context.user.id}`, 10, 60);
    const body = await readJson<{ type?: string; value?: string; label?: string }>(request);
    const result = await createPixKey(env, context.user.id, {
      type: body.type,
      value: String(body.value ?? ''),
      label: body.label,
    });
    return json(env, request, result, 201);
  }

  if (path === '/v1/bank/pix/keys/evp' && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    await rateLimit(env, `pix:key:${context.user.id}`, 10, 60);
    const body = await readJson<{ label?: string }>(request);
    return json(env, request, await createPixEvp(env, context.user.id, body.label), 201);
  }

  const pixKeyId = matchId(path, /^\/v1\/bank\/pix\/keys\/([A-Za-z0-9_-]+)$/);
  if (pixKeyId && method === 'DELETE') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    const result = await removePixKey(env, context.user.id, pixKeyId);
    return json(env, request, { ok: true, ...result });
  }

  const pixBrCodeId = matchId(path, /^\/v1\/bank\/pix\/keys\/([A-Za-z0-9_-]+)\/brcode$/);
  if (pixBrCodeId && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    const rawAmount = withQuery(url, 'amountCents');
    const amountCents = rawAmount === undefined ? undefined : Number.parseInt(rawAmount, 10);
    return json(env, request, await pixBrCode(env, context.user.id, pixBrCodeId, amountCents));
  }

  // ── Crédito: limite, simulação, contratos e parcelas ─────────────
  if (path === '/v1/bank/credit/quote' && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    const body = await readJson<Record<string, unknown>>(request);
    const quote = await creditQuote(env, context, {
      product: body.product as string | undefined,
      amountCents: body.amountCents,
      installments: body.installments,
    });
    return json(env, request, { quote });
  }

  if (path === '/v1/bank/credit/contracts' && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(env, request, await creditList(env, context));
  }

  if (path === '/v1/bank/credit/contracts' && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    await rateLimit(env, `credit:create:${context.user.id}`, 10, 60);
    const body = await readJson<Record<string, unknown>>(request);
    const idempotencyKey =
      (body.idempotencyKey as string | undefined) ?? (request.headers.get('idempotency-key') ?? undefined);
    const result = await creditCreate(env, context, {
      product: body.product as string | undefined,
      amountCents: body.amountCents,
      installments: body.installments,
      idempotencyKey,
    });
    return json(env, request, result, result.replayed ? 200 : 201);
  }

  if (path === '/v1/bank/credit/contracts.csv' && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    const csv = await creditExportCsv(env, context);
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="contratos-credito-xpartner.csv"',
        'cache-control': 'no-store',
        ...corsHeaders(env, request),
      },
    });
  }

  const creditContractId = matchId(path, /^\/v1\/bank\/credit\/contracts\/([A-Za-z0-9_-]+)$/);
  if (creditContractId && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(env, request, await creditGet(env, context, creditContractId));
  }

  const creditPay = /^\/v1\/bank\/credit\/contracts\/([A-Za-z0-9_-]+)\/installments\/(\d+)\/pay$/.exec(path);
  if (creditPay && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    const result = await creditPayInstallment(env, context, creditPay[1], Number.parseInt(creditPay[2], 10));
    return json(env, request, result, 201);
  }

  const creditSettle = matchId(path, /^\/v1\/bank\/credit\/contracts\/([A-Za-z0-9_-]+)\/settle$/);
  if (creditSettle && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(env, request, await creditSettleEarly(env, context, creditSettle), 201);
  }

  if (path === '/v1/bank/fx/wallets' && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(env, request, await fxWallets(env, context.user.id));
  }

  if (path === '/v1/bank/ai/insights' && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(env, request, await aiInsights(env, context));
  }

  // ── Transferências ───────────────────────────────────────────────
  if (path === '/v1/bank/transfers' && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    await rateLimit(env, `transfer:${context.user.id}`, 30, 60);
    const body = await readJson<Record<string, unknown>>(request);
    const idempotencyKey =
      (body.idempotencyKey as string | undefined) ??
      (request.headers.get('idempotency-key') ?? undefined);
    const result = await transfer(env, context, {
      amountCents: body.amountCents as number | string | undefined,
      amount: body.amount as number | string | undefined,
      description: body.description as string | undefined,
      recipient: (body.recipient ?? {}) as { accountNumber?: string; document?: string; email?: string },
      idempotencyKey,
    });
    return json(env, request, result, result.replayed ? 200 : 201);
  }

  const receiptId = matchId(path, /^\/v1\/bank\/transfers\/([A-Za-z0-9_-]+)$/);
  if (receiptId && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return json(env, request, await receipt(env, context, receiptId));
  }

  const r2ReceiptId = matchId(path, /^\/v1\/bank\/receipts\/([A-Za-z0-9_-]+)$/);
  if (r2ReceiptId && method === 'GET') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    return receiptFromR2(env, context, r2ReceiptId);
  }

  if (path === '/v1/bank/demo/credit' && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    const body = await readJson<Record<string, unknown>>(request);
    const targetUserId = (body.targetUserId as string | undefined) || context.user.id;
    if (targetUserId !== context.user.id) requireAdmin(context);
    return json(
      env,
      request,
      await funding(env, context, {
        amountCents: body.amountCents as number | string | undefined,
        amount: body.amount as number | string | undefined,
        targetUserId,
      }),
      201,
    );
  }

  if (path === '/v1/bank/demo/capital' && method === 'POST') {
    const admin = requireAdmin(await authenticate(env, request));
    const context = requireReady(admin);
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      env,
      request,
      await demoCapital(env, context, {
        targetUserId: String(body.targetUserId ?? ''),
        amountCents: body.amountCents as number | string | undefined,
        description: body.description as string | undefined,
      }),
      201,
    );
  }

  if (path === '/v1/bank/demo/fx' && method === 'POST') {
    const admin = requireAdmin(await authenticate(env, request));
    const context = requireReady(admin);
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      env,
      request,
      await demoFx(env, context, {
        targetUserId: String(body.targetUserId ?? ''),
        currency: body.currency as string | undefined,
        amountCents: body.amountCents as number | string | undefined,
        memo: body.memo as string | undefined,
      }),
      201,
    );
  }

  // ── RSFN PAG0004 ─────────────────────────────────────────────────
  if (path === '/v1/bank/rsfn/config' && method === 'GET') {
    requireAuth(await authenticate(env, request));
    return json(env, request, { config: rsfnConfigView(env) });
  }

  if (path === '/v1/bank/rsfn/pag0004.xsd' && method === 'GET') {
    return new Response(RSFN_PAG0004_XSD, {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': 'inline; filename="rsfn-pag0004.xsd"',
        'cache-control': 'public, max-age=3600',
      },
    });
  }

  if (path === '/v1/bank/rsfn/validate' && method === 'POST') {
    requireAuth(await authenticate(env, request));
    const body = await readJson<{ xml?: string }>(request);
    return json(env, request, await rsfnValidate(String(body.xml ?? '')));
  }

  if (path === '/v1/bank/rsfn/transfers' && method === 'POST') {
    const context = requireReady(requireAuth(await authenticate(env, request)));
    await rateLimit(env, `rsfn:send:${context.user.id}`, 30, 60);
    const body = await readJson<Record<string, unknown>>(request);
    const idempotencyKey =
      (body.idempotencyKey as string | undefined) ?? (request.headers.get('idempotency-key') ?? undefined);
    const result = await rsfnCreate(env, context, {
      amountCents: body.amountCents,
      description: body.description as string | undefined,
      destination: (body.destination ?? {}) as Record<string, string>,
      clientCode: body.clientCode as string | undefined,
      idempotencyKey,
    });
    return json(env, request, result, result.replayed ? 200 : 201);
  }

  if (path === '/v1/bank/rsfn/messages' && method === 'GET') {
    const context = requireAuth(await authenticate(env, request));
    const limit = withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : 50;
    return json(env, request, await rsfnList(env, context.user.id, limit));
  }

  const rsfnXmlId = matchId(path, /^\/v1\/bank\/rsfn\/messages\/([A-Za-z0-9_-]+)\/xml$/);
  if (rsfnXmlId && method === 'GET') {
    const context = requireAuth(await authenticate(env, request));
    const message = (await rsfnGet(env, context, rsfnXmlId)) as { numCtrlIf?: string; xml?: string };
    return new Response(String(message.xml ?? ''), {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="${message.numCtrlIf ?? 'pag0004'}.xml"`,
        'cache-control': 'no-store',
      },
    });
  }

  const rsfnAckId = matchId(path, /^\/v1\/bank\/rsfn\/messages\/([A-Za-z0-9_-]+)\/ack$/);
  if (rsfnAckId && method === 'POST') {
    const admin = requireReady(requireAdmin(await authenticate(env, request)));
    await rateLimit(env, `rsfn:ack:${admin.user.id}`, 30, 60);
    const body = await readJson<Record<string, unknown>>(request);
    const result = await rsfnAck(env, admin, rsfnAckId, {
      decision: body.decision as string | undefined,
      rejectionCode: body.rejectionCode as string | undefined,
      rejectionReason: body.rejectionReason as string | undefined,
    });
    return json(env, request, result);
  }

  const rsfnMessageId = matchId(path, /^\/v1\/bank\/rsfn\/messages\/([A-Za-z0-9_-]+)$/);
  if (rsfnMessageId && method === 'GET') {
    const context = requireAuth(await authenticate(env, request));
    return json(env, request, await rsfnGet(env, context, rsfnMessageId));
  }

  // ── Administração ────────────────────────────────────────────────
  if (path === '/v1/bank/admin/overview' && method === 'GET') {
    requireAdmin(await authenticate(env, request));
    return json(env, request, await adminOverview(env));
  }

  if (path === '/v1/bank/admin/users' && method === 'GET') {
    requireAdmin(await authenticate(env, request));
    const users = await listUsers(env, {
      status: withQuery(url, 'status'),
      search: withQuery(url, 'search') ?? withQuery(url, 'q'),
      limit: withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
    });
    return json(env, request, { data: users });
  }

  if (path === '/v1/bank/admin/audit' && method === 'GET') {
    requireAdmin(await authenticate(env, request));
    return json(env, request, {
      data: await auditLog(
        env,
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : 100,
      ),
    });
  }

  if (path === '/v1/bank/admin/demo-data' && method === 'GET') {
    requireAdmin(await authenticate(env, request));
    const [bank, merchant] = await Promise.all([previewEdgePurge(env), previewMerchantDemoData(env)]);
    return json(env, request, { bank, merchant });
  }

  if (path === '/v1/bank/admin/demo-data/purge' && method === 'POST') {
    const admin = requireAdmin(await authenticate(env, request));
    const body = await readJson<Record<string, unknown>>(request);
    const confirm = body.confirm as string | undefined;
    if (confirm !== PURGE_CONFIRM_PHRASE) {
      throw new HttpError(
        422,
        'CONFIRMATION_REQUIRED',
        `Digite exatamente "${PURGE_CONFIRM_PHRASE}" para apagar os lançamentos de demonstração.`,
      );
    }
    const merchant = await purgeMerchantDemoData(env, admin.user.id, confirm);
    const bank = await purgeEdgeDemoData(env, admin.user.id, confirm);
    return json(env, request, { bank, merchant });
  }

  // Token curto para operar a maquininha. Só um administrador autenticado pede,
  // e o Durable Object recusa o token público de bootstrap nesse caminho.
  if (path === '/v1/bank/admin/merchant/simulator-token' && method === 'POST') {
    const admin = requireAdmin(await authenticate(env, request));
    return json(env, request, await issueMerchantSimulatorToken(env, admin.user.id));
  }

  if (path === '/v1/bank/admin/rsfn/messages' && method === 'GET') {
    requireAdmin(await authenticate(env, request));
    const limit = withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : 100;
    return json(env, request, await rsfnAdminList(env, limit));
  }

  if (path === '/v1/bank/admin/pix/keys' && method === 'GET') {
    requireAdmin(await authenticate(env, request));
    return json(
      env,
      request,
      await adminListPixKeys(env, {
        type: withQuery(url, 'type'),
        status: withQuery(url, 'status'),
        limit: withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      }),
    );
  }

  const adminUserId = matchId(path, /^\/v1\/bank\/admin\/users\/([A-Za-z0-9_-]+)$/);
  if (adminUserId) {
    const admin = requireAdmin(await authenticate(env, request));
    if (method === 'GET') return json(env, request, await adminUserDetail(env, adminUserId));
    if (method === 'DELETE') {
      await deleteUser(env, admin, adminUserId);
      return json(env, request, { ok: true });
    }
  }

  const adminAction = /^\/v1\/bank\/admin\/users\/([A-Za-z0-9_-]+)\/(approve|reject|block|unblock|reset-password)$/.exec(
    path,
  );
  if (adminAction && method === 'POST') {
    const admin = requireAdmin(await authenticate(env, request));
    const [, userId, action] = adminAction;
    if (action === 'approve') return json(env, request, await approveUser(env, admin, userId));
    if (action === 'reject') {
      await rejectUser(env, admin, userId);
      return json(env, request, { ok: true });
    }
    if (action === 'block') {
      await setBlocked(env, admin, userId, true);
      return json(env, request, { ok: true });
    }
    if (action === 'unblock') {
      await setBlocked(env, admin, userId, false);
      return json(env, request, { ok: true });
    }
    return json(env, request, await resetUserPassword(env, admin, userId));
  }

  // ── Web3 institucional · DVP, oráculo, agro, ZK, agentes, paymaster ──
  if (path === '/v1/web3/capabilities' && method === 'GET') {
    await web3Ready(env);
    return json(env, request, await web3.capabilities(env));
  }

  if (path === '/v1/web3/overview' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(env, request, await web3.web3Overview(env, context.user.id));
  }

  if (path === '/v1/web3/networks' && method === 'GET') {
    await web3Context(env, request);
    return json(env, request, await web3.listNetworks(env, withQuery(url, 'status')));
  }

  if (path === '/v1/web3/networks' && method === 'POST') {
    const context = requireReady(requireAdmin(await authenticate(env, request)));
    await web3Ready(env);
    return json(env, request, await web3.createNetwork(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  const web3NetworkId = matchId(path, /^\/v1\/web3\/networks\/([A-Za-z0-9_-]+)$/);
  if (web3NetworkId && method === 'GET') {
    await web3Context(env, request);
    return json(env, request, await web3.getNetwork(env, web3NetworkId));
  }

  if (path === '/v1/web3/oracle/feeds' && method === 'GET') {
    await web3Context(env, request);
    return json(env, request, await web3.listFeeds(env));
  }

  if (path === '/v1/web3/oracle/feeds' && method === 'POST') {
    requireReady(requireAdmin(await authenticate(env, request)));
    await web3Ready(env);
    return json(env, request, await web3.registerFeed(env, await readJson<Record<string, unknown>>(request)), 201);
  }

  if (path === '/v1/web3/oracle/prices' && method === 'POST') {
    const context = requireReady(requireAdmin(await authenticate(env, request)));
    await web3Ready(env);
    return json(env, request, await web3.publishPrice(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  const web3PriceSymbol = matchId(path, /^\/v1\/web3\/oracle\/prices\/([A-Za-z0-9]+)$/);
  if (web3PriceSymbol && method === 'GET') {
    await web3Context(env, request);
    return json(env, request, { price: await web3.readPrice(env, web3PriceSymbol) });
  }

  if (path === '/v1/web3/dvp/offers' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listOffers(env, context.user.id, {
        status: withQuery(url, 'status'),
        mine: withQuery(url, 'mine') === 'true',
        limit: withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      }),
    );
  }

  if (path === '/v1/web3/dvp/offers' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.createOffer(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  const web3OfferAccept = matchId(path, /^\/v1\/web3\/dvp\/offers\/([A-Za-z0-9_-]+)\/accept$/);
  if (web3OfferAccept && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.acceptOffer(env, web3OfferAccept, context.user.id), 201);
  }

  const web3OfferCancel = matchId(path, /^\/v1\/web3\/dvp\/offers\/([A-Za-z0-9_-]+)\/cancel$/);
  if (web3OfferCancel && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.cancelOffer(env, web3OfferCancel, context.user.id));
  }

  const web3OfferId = matchId(path, /^\/v1\/web3\/dvp\/offers\/([A-Za-z0-9_-]+)$/);
  if (web3OfferId && method === 'GET') {
    await web3Context(env, request);
    return json(env, request, await web3.getOffer(env, web3OfferId));
  }

  if (path === '/v1/web3/dvp/trades' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listTrades(
        env,
        context.user.id,
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      ),
    );
  }

  if (path === '/v1/web3/agro/contracts' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listAgro(
        env,
        context.user.id,
        withQuery(url, 'status'),
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      ),
    );
  }

  if (path === '/v1/web3/agro/contracts' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.openAgro(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  const agroRepayId = matchId(path, /^\/v1\/web3\/agro\/contracts\/([A-Za-z0-9_-]+)\/repay$/);
  if (agroRepayId && method === 'POST') {
    const context = await web3Context(env, request, true);
    const body = await readJson<Record<string, unknown>>(request);
    return json(env, request, await web3.repayAgro(env, agroRepayId, context.user.id, body.amountCents as number | undefined));
  }

  const agroLiquidateId = matchId(path, /^\/v1\/web3\/agro\/contracts\/([A-Za-z0-9_-]+)\/liquidate$/);
  if (agroLiquidateId && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.liquidateAgro(env, agroLiquidateId, context.user.id));
  }

  const agroId = matchId(path, /^\/v1\/web3\/agro\/contracts\/([A-Za-z0-9_-]+)$/);
  if (agroId && method === 'GET') {
    const context = await web3Context(env, request);
    return json(env, request, await web3.getAgro(env, agroId, context.user.id));
  }

  if (path === '/v1/web3/zk/attestations' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(env, request, await web3.listAttestations(env, context.user.id, withQuery(url, 'commitment')));
  }

  if (path === '/v1/web3/zk/attestations' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.issueAttestation(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  const zkRevokeId = matchId(path, /^\/v1\/web3\/zk\/attestations\/([A-Za-z0-9_-]+)\/revoke$/);
  if (zkRevokeId && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.revokeAttestation(env, zkRevokeId, context.user.id));
  }

  if (path === '/v1/web3/zk/verify' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.verifyAttestation(env, context.user.id, await readJson<Record<string, unknown>>(request)));
  }

  if (path === '/v1/web3/zk/verifications' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listVerifications(
        env,
        context.user.id,
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      ),
    );
  }

  if (path === '/v1/web3/zk/proofs' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.registerProof(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  if (path === '/v1/web3/agents/sessions' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listSessions(
        env,
        context.user.id,
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      ),
    );
  }

  if (path === '/v1/web3/agents/sessions' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.grantSession(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  const agentAuthorizeId = matchId(path, /^\/v1\/web3\/agents\/sessions\/([A-Za-z0-9_-]+)\/authorize$/);
  if (agentAuthorizeId && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(
      env,
      request,
      await web3.authorizeSession(env, agentAuthorizeId, context.user.id, await readJson<Record<string, unknown>>(request)),
    );
  }

  const agentRevokeId = matchId(path, /^\/v1\/web3\/agents\/sessions\/([A-Za-z0-9_-]+)\/revoke$/);
  if (agentRevokeId && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.revokeSession(env, agentRevokeId, context.user.id));
  }

  if (path === '/v1/web3/paymaster/budgets' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(env, request, await web3.listBudgets(env, context.user.id));
  }

  if (path === '/v1/web3/paymaster/budgets' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.createBudget(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  if (path === '/v1/web3/paymaster/ops' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listOps(
        env,
        context.user.id,
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      ),
    );
  }

  if (path === '/v1/web3/paymaster/sponsor' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.sponsorOp(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  // ── Aladdin: risco quantitativo, ZK e crédito algorítmico ────────
  if (path === '/v1/web3/aladdin/overview' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(env, request, await web3.aladdinOverview(env, context.user.id));
  }

  if (path === '/v1/web3/aladdin/risk/metrics' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listRisk(
        env,
        context.user.id,
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      ),
    );
  }

  if (path === '/v1/web3/aladdin/risk/simulate' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.simulateRisk(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  if (path === '/v1/web3/aladdin/risk/metrics' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.recordRisk(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  if (path === '/v1/web3/aladdin/loans' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listLoans(
        env,
        context.user.id,
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      ),
    );
  }

  if (path === '/v1/web3/aladdin/loans' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.openLoan(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  const aladdinRepayId = matchId(path, /^\/v1\/web3\/aladdin\/loans\/([A-Za-z0-9_-]+)\/repay$/);
  if (aladdinRepayId && method === 'POST') {
    const context = await web3Context(env, request, true);
    const body = await readJson<Record<string, unknown>>(request);
    return json(env, request, await web3.repayLoan(env, aladdinRepayId, context.user.id, body.amountCents as number | undefined));
  }

  const aladdinLoanId = matchId(path, /^\/v1\/web3\/aladdin\/loans\/([A-Za-z0-9_-]+)$/);
  if (aladdinLoanId && method === 'GET') {
    const context = await web3Context(env, request);
    return json(env, request, await web3.getLoan(env, aladdinLoanId, context.user.id));
  }

  // ── CCIP, liquidez P2P e intents cross-chain ─────────────────────
  if (path === '/v1/web3/ccip/lanes' && method === 'GET') {
    await web3Context(env, request);
    return json(env, request, await web3.listLanes(env, withQuery(url, 'status')));
  }

  if (path === '/v1/web3/ccip/lanes' && method === 'POST') {
    const context = requireReady(requireAdmin(await authenticate(env, request)));
    await web3Ready(env);
    return json(env, request, await web3.registerLane(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  if (path === '/v1/web3/ccip/liquidity' && method === 'GET') {
    await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listLiquidity(env, { laneId: withQuery(url, 'laneId'), status: withQuery(url, 'status') }),
    );
  }

  if (path === '/v1/web3/ccip/liquidity' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.registerLiquidity(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  if (path === '/v1/web3/intents/overview' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(env, request, await web3.crosschainOverview(env, context.user.id));
  }

  if (path === '/v1/web3/intents' && method === 'GET') {
    const context = await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listIntents(
        env,
        context.user.id,
        withQuery(url, 'status'),
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      ),
    );
  }

  if (path === '/v1/web3/intents' && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.createIntent(env, context.user.id, await readJson<Record<string, unknown>>(request)), 201);
  }

  const intentQuotesId = matchId(path, /^\/v1\/web3\/intents\/([A-Za-z0-9_-]+)\/quotes$/);
  if (intentQuotesId && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(
      env,
      request,
      await web3.quoteIntent(env, intentQuotesId, context.user.id, await readJson<Record<string, unknown>>(request)),
      201,
    );
  }

  const intentSelectId = matchId(path, /^\/v1\/web3\/intents\/([A-Za-z0-9_-]+)\/select$/);
  if (intentSelectId && method === 'POST') {
    const context = await web3Context(env, request, true);
    const body = await readJson<Record<string, unknown>>(request);
    return json(env, request, await web3.selectQuote(env, intentSelectId, context.user.id, body.quoteId ? String(body.quoteId) : undefined));
  }

  const intentExecuteId = matchId(path, /^\/v1\/web3\/intents\/([A-Za-z0-9_-]+)\/execute$/);
  if (intentExecuteId && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.executeIntent(env, intentExecuteId, context.user.id), 201);
  }

  const intentCancelId = matchId(path, /^\/v1\/web3\/intents\/([A-Za-z0-9_-]+)\/cancel$/);
  if (intentCancelId && method === 'POST') {
    const context = await web3Context(env, request, true);
    return json(env, request, await web3.cancelIntent(env, intentCancelId, context.user.id));
  }

  const intentId = matchId(path, /^\/v1\/web3\/intents\/([A-Za-z0-9_-]+)$/);
  if (intentId && method === 'GET') {
    const context = await web3Context(env, request);
    return json(env, request, await web3.getIntent(env, intentId, context.user.id));
  }

  if (path === '/v1/web3/ccip/messages' && method === 'GET') {
    await web3Context(env, request);
    return json(
      env,
      request,
      await web3.listMessages(
        env,
        withQuery(url, 'laneId'),
        withQuery(url, 'limit') ? Number.parseInt(withQuery(url, 'limit') as string, 10) : undefined,
      ),
    );
  }

  // Canal de tempo real do painel: valida a sessão do lojista no Durable Object
  // antes de aceitar o upgrade. Os eventos de venda entram por aqui quando o
  // runtime entrega o WebSocket.
  if (path === '/ws' && (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
    const token = withQuery(url, 'token');
    if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'Token ausente para o canal de tempo real.');
    const merchant = env.MERCHANT.get(env.MERCHANT.idFromName('demo'));
    const check = await merchant.fetch(
      new Request('https://merchant.internal/v1/app/overview', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    if (check.status !== 200) throw new HttpError(401, 'UNAUTHORIZED', 'Sessão inválida para o canal de tempo real.');
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    server.send(JSON.stringify({ type: 'hello', data: { at: nowIso() } }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Núcleo do lojista: o app demo e as visões de Operação, Relacionamento,
  // Financeiro e Banco aberto rodam num Durable Object com SQLite próprio.
  if (path.startsWith('/v1/') && !path.startsWith('/v1/bank/') && !path.startsWith('/v1/web3/')) {
    const merchant = env.MERCHANT.get(env.MERCHANT.idFromName('demo'));
    try {
      return await merchant.fetch(request);
    } catch (error) {
      console.error('merchant.unavailable', error instanceof Error ? error.message : String(error));
      throw new HttpError(503, 'MERCHANT_UNAVAILABLE', 'Núcleo do lojista indisponível. Tente novamente.');
    }
  }

  // Páginas estáticas do app (public/ servido via Assets). Rotas /v1/* e
  // /health continuam caindo no 404 JSON abaixo.
  if ((method === 'GET' || method === 'HEAD') && env.ASSETS && !path.startsWith('/v1/') && path !== '/health') {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
  }

  throw new HttpError(404, 'NOT_FOUND', `Rota ${method} ${path} não encontrada no edge bancário.`);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, new URL(request.url));
    } catch (error) {
      return errorResponse(env, request, error);
    }
  },

  async queue(batch: MessageBatch<BankEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = message.body;
        if (!event?.id || !event?.topic) throw new Error('evento sem id/topic');
        await env.DB.prepare(
          'INSERT OR IGNORE INTO edge_events (id, topic, payload, received_at) VALUES (?, ?, ?, ?)',
        )
          .bind(event.id, event.topic, JSON.stringify(event.payload ?? {}), nowIso())
          .run();
        console.log('edge.event', { topic: event.topic, type: event.type, id: event.id });
        message.ack();
      } catch (error) {
        console.error('edge.event_failed', error instanceof Error ? error.message : String(error));
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const sessionCutoff = nowIso(-7 * 24 * 60 * 60 * 1000);
    await env.DB.prepare('DELETE FROM bank_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
      .bind(nowIso(), sessionCutoff)
      .run();
    await env.DB.prepare('DELETE FROM edge_events WHERE received_at < ?')
      .bind(nowIso(-30 * 24 * 60 * 60 * 1000))
      .run();
    console.log('edge.cleanup', { at: nowIso() });
  },
};

// Reexports de leitura para testes/consumidores externos.
export { createSession, boolEnv, MerchantCore };
