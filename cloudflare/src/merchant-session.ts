import type { Env } from './types.ts';
import { HttpError } from './http.ts';

/**
 * A página pública recebe um token de leitura: ela mostra o estabelecimento,
 * os terminais e grava cadastros do próprio lojista, mas não inventa
 * lançamento. Quem opera a maquininha precisa da sessão de administrador do
 * banco, e é o Worker — nunca o navegador — que busca o token dentro do
 * Durable Object.
 */
export async function issueMerchantSimulatorToken(
  env: Env,
  actorId: string,
): Promise<Record<string, unknown>> {
  const stub = env.MERCHANT.get(env.MERCHANT.idFromName('demo'));
  const response = await stub.fetch(
    new Request('https://merchant.internal/internal/admin/simulator-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: actorId }),
    }),
  );
  const payload = (await response.json()) as { error?: { message?: string } } & Record<string, unknown>;
  if (!response.ok) {
    throw new HttpError(
      502,
      'SIMULATOR_TOKEN_UNAVAILABLE',
      payload.error?.message ?? 'O núcleo do lojista não liberou o token de operador.',
    );
  }
  return payload;
}
