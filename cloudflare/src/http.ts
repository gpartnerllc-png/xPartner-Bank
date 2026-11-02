import type { AuthContext, Env } from './types.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = env.APP_ORIGIN;
  if (!origin || !allowed || origin !== allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, x-bank-csrf, idempotency-key, x-bootstrap-token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(
  env: Env,
  request: Request,
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(env, request),
      ...extraHeaders,
    },
  });
}

export function errorResponse(env: Env, request: Request, error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      env,
      request,
      { error: { code: error.code, message: error.message, details: error.details } },
      error.status,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('unhandled', message);
  return json(env, request, { error: { code: 'INTERNAL', message: 'Falha interna no edge bancário.' } }, 500);
}

export async function readJson<T>(request: Request): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Corpo JSON inválido.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'Envie um objeto JSON.');
  }
  return body as T;
}

export function clientContext(request: Request): { ip: string; userAgent: string } {
  return {
    ip: request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'unknown',
    userAgent: (request.headers.get('User-Agent') ?? '').slice(0, 300),
  };
}

export function requireAuth(context: AuthContext | null): AuthContext {
  if (!context) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessão bancária ausente ou expirada.');
  return context;
}

export function requireAdmin(context: AuthContext | null): AuthContext {
  const auth = requireAuth(context);
  if (auth.user.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Ação restrita ao administrador.');
  return auth;
}

export function boolEnv(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
