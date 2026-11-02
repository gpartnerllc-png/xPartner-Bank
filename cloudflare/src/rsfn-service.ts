import type { AccountRow, AuthContext, Env, TransferRow } from './types.ts';
import { HttpError, boolEnv } from './http.ts';
import { accountById, accountView, audit, queueEvent } from './repo.ts';
import { newId, nowIso, sha256Hex } from './security.ts';
import { formatBRL, maskDocument, onlyDigits, sanitizeIdempotencyKey } from './validation.ts';
import {
  buildNumCtrlIf,
  buildPag0004Xml,
  parsePag0004Xml,
  type Pag0004Message,
} from './rsfn-domain.ts';

const RSFN_TRANSIT_ACCOUNT_ID = 'bank_acc_rsfn';
const RSFN_MAX_CENTS = 100_000_000;

interface RsfnMessageRow {
  id: string;
  num_ctrl_if: string;
  cod_msg: string;
  ispb_emissor: string;
  ispb_destinatario: string;
  dt_movto: string;
  cod_cli_emissor: string;
  documento_emissor: string;
  nome_emissor: string;
  agencia_destinatario: string;
  conta_destinatario: string;
  documento_destinatario: string;
  nome_destinatario: string;
  vlr_cents: number;
  finalidade: string;
  status: 'SENT' | 'ACCEPTED' | 'REJECTED' | 'SETTLED';
  transport: 'SIMULATED' | 'LIVE';
  transfer_id: string;
  xml: string;
  xml_sha256: string;
  idempotency_key: string | null;
  request_hash: string | null;
  rejection_code: string | null;
  rejection_reason: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface RsfnDestination {
  ispb: string;
  branch: string;
  account: string;
  document: string;
  name: string;
}

interface SenderRow extends AccountRow {
  holder_name: string;
  holder_document: string;
  user_status: string;
}

function rsfnIspb(env: Env): string | null {
  const value = String(env.RSFN_ISPB ?? '').trim();
  return /^\d{8}$/.test(value) ? value : null;
}

function demoMode(env: Env): boolean {
  return boolEnv(env.DEMO_MODE);
}

function normalizeDescription(input: string | undefined): string {
  const value = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!value) return 'Transferência interbancária RSFN';
  if (value.length > 120) throw new HttpError(422, 'INVALID_DESCRIPTION', 'Descrição excede 120 caracteres.');
  return value;
}

function normalizeName(input: unknown): string {
  const value = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length < 1 || value.length > 80) {
    throw new HttpError(422, 'INVALID_NAME', 'Nome do destinatário deve ter de 1 a 80 caracteres.');
  }
  return value;
}

function amountOf(value: unknown): number {
  const cents = typeof value === 'string' ? Number.parseInt(value.replace(/\D/g, ''), 10) : Number(value);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new HttpError(422, 'INVALID_AMOUNT', 'Informe um valor positivo em centavos.');
  }
  if (cents > RSFN_MAX_CENTS) {
    throw new HttpError(422, 'RSFN_VALUE_LIMIT', 'Valor máximo por mensagem PAG0004 é R$ 1.000.000,00.');
  }
  return cents;
}

function endToEnd(timestamp: string, ispb: string): string {
  return `E${ispb}${timestamp.replace(/\D/g, '').slice(0, 12)}${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
}

function rsfnView(env: Env, row: RsfnMessageRow): Record<string, unknown> {
  return {
    id: row.id,
    numCtrlIf: row.num_ctrl_if,
    codMsg: row.cod_msg,
    status: row.status,
    transport: row.transport,
    direction: 'OUT',
    ispbEmissor: row.ispb_emissor,
    ispbDestinatario: row.ispb_destinatario,
    dtMovto: row.dt_movto,
    amountCents: row.vlr_cents,
    amountFormatted: formatBRL(row.vlr_cents),
    emitter: {
      name: row.nome_emissor,
      documentMasked: maskDocument(row.documento_emissor),
      clientCode: row.cod_cli_emissor,
    },
    destination: {
      name: row.nome_destinatario,
      documentMasked: maskDocument(row.documento_destinatario),
      branch: row.agencia_destinatario,
      account: row.conta_destinatario,
      ispb: row.ispb_destinatario,
    },
    transferId: row.transfer_id,
    endToEndId: row.num_ctrl_if,
    xmlSha256: row.xml_sha256,
    rejection: row.rejection_code ? { code: row.rejection_code, reason: row.rejection_reason ?? '' } : null,
    acknowledgement: {
      status: row.status,
      at: row.acknowledged_at,
      canAcknowledge: row.status === 'SENT' && demoMode(env),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function nextNumCtrlIf(env: Env, ispb: string, now: number): Promise<string> {
  for (let sequence = 1; sequence <= 999; sequence += 1) {
    const candidate = buildNumCtrlIf(ispb, now, sequence);
    const found = await env.DB.prepare('SELECT 1 AS found FROM bank_rsfn_messages WHERE num_ctrl_if = ?')
      .bind(candidate)
      .first<{ found: number }>();
    if (!found) return candidate;
  }
  throw new HttpError(409, 'RSFN_SEQUENCE', 'Sequência de NumCtrlIF esgotada neste segundo.');
}

function mapTransferError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('INSUFFICIENT_FUNDS')) {
    throw new HttpError(422, 'INSUFFICIENT_FUNDS', 'Saldo insuficiente para esta transferência.');
  }
  if (message.includes('INACTIVE')) {
    throw new HttpError(409, 'ACCOUNT_INACTIVE', 'Conta de origem ou destino não está ativa.');
  }
  if (message.includes('RSFN_CLEARING_EMPTY')) {
    throw new HttpError(409, 'RSFN_CLEARING_EMPTY', 'Conta de compensação sem saldo para estornar.');
  }
  throw error instanceof Error ? error : new Error(message);
}

async function transferSummary(
  env: Env,
  transfer: TransferRow,
): Promise<Record<string, unknown>> {
  const ledger = await env.DB.prepare(
    "SELECT balance_after_cents FROM bank_ledger WHERE transfer_id = ? AND direction = 'DEBIT'",
  )
    .bind(transfer.id)
    .first<{ balance_after_cents: number }>();
  return {
    id: transfer.id,
    endToEndId: transfer.end_to_end_id,
    status: transfer.status,
    amountCents: transfer.amount_cents,
    amountFormatted: formatBRL(transfer.amount_cents),
    balanceAfterCents: ledger?.balance_after_cents ?? null,
    createdAt: transfer.created_at,
  };
}

export function rsfnConfigView(env: Env): Record<string, unknown> {
  const ispb = rsfnIspb(env);
  const demo = demoMode(env);
  return {
    ispb,
    enabled: Boolean(ispb),
    demoMode: demo,
    transport: 'SIMULATED',
    endpointConfigured: false,
    certificatesConfigured: false,
    liveConnectorReady: false,
    xsdUrl: '/v1/bank/rsfn/pag0004.xsd',
    notes: [
      'Mensagens PAG0004 são geradas, validadas e contabilizadas neste Worker (D1).',
      'A transmissão real exige participação na RSFN, certificado ICP-Brasil e conector mTLS homologado.',
      demo
        ? 'Neste ambiente o retorno da RSFN é simulado pelo administrador (aceite/recusa).'
        : 'Sem conector homologado, nenhum XML sai deste Worker.',
    ],
  };
}

export async function rsfnValidate(xml: string): Promise<Record<string, unknown>> {
  const result = await parsePag0004Xml(xml);
  const parsed = result.message;
  return {
    valid: result.valid,
    issues: result.issues,
    sha256: result.sha256,
    message: parsed
      ? {
          numCtrlIf: parsed.numCtrlIf,
          codMsg: parsed.codMsg,
          ispbEmissor: parsed.ispbEmissor,
          ispbDestinatario: parsed.ispbDestinatario,
          dtMovto: parsed.dtMovto,
          amountCents: parsed.valorCents,
          amountFormatted: formatBRL(parsed.valorCents),
          emitter: { name: parsed.nomeEmissor, documentMasked: maskDocument(parsed.documentoEmissor) },
          destination: {
            name: parsed.nomeDestinatario,
            documentMasked: maskDocument(parsed.documentoDestinatario),
            branch: parsed.agenciaDestinatario,
            account: parsed.contaDestinatario,
          },
        }
      : null,
  };
}

export async function rsfnCreate(
  env: Env,
  context: AuthContext,
  input: {
    amountCents?: unknown;
    description?: string;
    destination?: Partial<RsfnDestination>;
    clientCode?: string;
    idempotencyKey?: string;
  },
): Promise<Record<string, unknown>> {
  const ispbEmissor = rsfnIspb(env);
  if (!ispbEmissor) {
    throw new HttpError(
      403,
      'RSFN_NOT_CONFIGURED',
      'Canal RSFN sem ISPB configurado. Defina RSFN_ISPB para emitir PAG0004.',
    );
  }
  if (!context.account) throw new HttpError(403, 'ACCOUNT_MISSING', 'Conta corrente não encontrada.');

  const now = Date.now();
  const timestamp = nowIso();
  const amount = amountOf(input.amountCents);
  const description = normalizeDescription(input.description);
  const destination: RsfnDestination = {
    ispb: onlyDigits(input.destination?.ispb),
    branch: onlyDigits(input.destination?.branch),
    account: onlyDigits(input.destination?.account),
    document: onlyDigits(input.destination?.document),
    name: normalizeName(input.destination?.name),
  };
  const idempotencyKey = sanitizeIdempotencyKey(input.idempotencyKey);
  const requestHash = await sha256Hex(
    [
      destination.ispb,
      destination.branch,
      destination.account,
      destination.document,
      destination.name,
      amount,
      description,
    ].join('|'),
  );

  if (idempotencyKey) {
    const existing = await env.DB.prepare(
      'SELECT * FROM bank_rsfn_messages WHERE created_by = ? AND idempotency_key = ?',
    )
      .bind(context.user.id, idempotencyKey)
      .first<RsfnMessageRow>();
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key reutilizada com payload diferente.');
      }
      const account = await accountById(env, context.account.id);
      const transfer = await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
        .bind(existing.transfer_id)
        .first<TransferRow>();
      return {
        message: rsfnView(env, existing),
        xml: existing.xml,
        transfer: transfer ? await transferSummary(env, transfer) : null,
        account: account ? accountView(account) : null,
        replayed: true,
      };
    }
  }

  const sender = await env.DB.prepare(
    `SELECT a.*, u.name AS holder_name, u.document AS holder_document, u.status AS user_status
       FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id
      WHERE a.id = ? AND a.user_id = ?`,
  )
    .bind(context.account.id, context.user.id)
    .first<SenderRow>();
  if (!sender) throw new HttpError(404, 'ACCOUNT_MISSING', 'Conta de origem não encontrada.');
  if (sender.status !== 'ACTIVE' || sender.user_status !== 'ACTIVE') {
    throw new HttpError(403, 'ACCOUNT_BLOCKED', 'Conta de origem bloqueada ou encerrada.');
  }
  if (amount > sender.per_transfer_limit_cents) {
    throw new HttpError(
      422,
      'TRANSFER_LIMIT',
      `Valor acima do limite por transferência de ${formatBRL(sender.per_transfer_limit_cents)}.`,
    );
  }
  const moved = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM bank_transfers
      WHERE debit_account_id = ? AND status = 'POSTED' AND created_at >= ?`,
  )
    .bind(sender.id, nowIso(-24 * 60 * 60 * 1000))
    .first<{ total: number }>();
  if ((moved?.total ?? 0) + amount > sender.daily_limit_cents) {
    throw new HttpError(
      422,
      'DAILY_LIMIT',
      `Limite diário de ${formatBRL(sender.daily_limit_cents)} excedido. Já movimentado nas últimas 24h: ${formatBRL(moved?.total ?? 0)}.`,
    );
  }

  const dtMovto = new Date(now).toISOString().slice(0, 10);
  const clientCode = onlyDigits(input.clientCode ?? '0001') || '0001';
  const transferId = newId('trf');
  const messageId = newId('rsfn');
  const e2e = endToEnd(timestamp, ispbEmissor);

  let candidate = await nextNumCtrlIf(env, ispbEmissor, now);
  let xml = '';
  let xmlSha256 = '';
  let message: Pag0004Message | null = null;
  let inserted = false;

  for (let attempt = 0; attempt < 4 && !inserted; attempt += 1) {
    message = {
      numCtrlIf: candidate,
      codMsg: 'PAG0004',
      ispbEmissor,
      ispbDestinatario: destination.ispb,
      dtMovto,
      codCliEmissor: clientCode,
      documentoEmissor: sender.holder_document,
      nomeEmissor: sender.holder_name,
      agenciaDestinatario: destination.branch,
      contaDestinatario: destination.account,
      documentoDestinatario: destination.document,
      nomeDestinatario: destination.name,
      valorCents: amount,
      finalidadeTransacao: '0001',
    };
    xml = buildPag0004Xml(message);
    xmlSha256 = await sha256Hex(xml);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO bank_transfers
             (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
              end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at, channel)
           VALUES (?, 'INTERNAL', ?, ?, ?, ?, 'POSTED', ?, NULL, NULL, ?, ?, ?, 'RSFN')`,
        ).bind(
          transferId,
          sender.id,
          RSFN_TRANSIT_ACCOUNT_ID,
          amount,
          description,
          e2e,
          context.user.id,
          destination.name,
          timestamp,
        ),
        env.DB.prepare(
          `INSERT INTO bank_rsfn_messages
             (id, num_ctrl_if, cod_msg, ispb_emissor, ispb_destinatario, dt_movto, cod_cli_emissor,
              documento_emissor, nome_emissor, agencia_destinatario, conta_destinatario,
              documento_destinatario, nome_destinatario, vlr_cents, finalidade, status, transport,
              transfer_id, xml, xml_sha256, idempotency_key, request_hash, created_by, created_at, updated_at)
           VALUES (?, ?, 'PAG0004', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0001', 'SENT', 'SIMULATED',
                   ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          messageId,
          candidate,
          ispbEmissor,
          destination.ispb,
          dtMovto,
          clientCode,
          sender.holder_document,
          sender.holder_name,
          destination.branch,
          destination.account,
          destination.document,
          destination.name,
          amount,
          transferId,
          xml,
          xmlSha256,
          idempotencyKey,
          idempotencyKey ? requestHash : null,
          context.user.id,
          timestamp,
          timestamp,
        ),
      ]);
      inserted = true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text.includes('UNIQUE') && text.includes('num_ctrl_if') && attempt < 3) {
        candidate = await nextNumCtrlIf(env, ispbEmissor, Date.now());
        continue;
      }
      mapTransferError(error);
    }
  }
  if (!inserted || !message) throw new HttpError(409, 'RSFN_SEQUENCE', 'Não foi possível reservar um NumCtrlIF livre.');

  const row = await env.DB.prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
    .bind(messageId)
    .first<RsfnMessageRow>();
  const transfer = await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
    .bind(transferId)
    .first<TransferRow>();
  const account = await accountById(env, sender.id);

  await audit(env, {
    actorId: context.user.id,
    action: 'bank.rsfn.sent',
    resource: 'bank_rsfn_message',
    resourceId: messageId,
    details: { numCtrlIf: candidate, amountCents: amount, ispbDestinatario: destination.ispb, transferId },
  });
  await queueEvent(env, {
    topic: 'bank.rsfn',
    type: 'bank.rsfn.sent',
    payload: {
      messageId,
      numCtrlIf: candidate,
      transferId,
      amountCents: amount,
      ispbEmissor,
      ispbDestinatario: destination.ispb,
      xmlSha256,
      createdAt: timestamp,
    },
  });

  return {
    message: row ? rsfnView(env, row) : null,
    xml,
    transfer: transfer ? await transferSummary(env, transfer) : null,
    account: account ? accountView(account) : null,
    replayed: false,
  };
}

export async function rsfnAck(
  env: Env,
  context: AuthContext,
  messageId: string,
  input: { decision?: string; rejectionCode?: string; rejectionReason?: string },
): Promise<Record<string, unknown>> {
  if (!demoMode(env)) {
    throw new HttpError(
      403,
      'RSFN_CONNECTOR_REQUIRED',
      'Acknowledgment manual é exclusivo do modo demo. Em produção, o retorno vem do conector RSFN.',
    );
  }
  const row = await env.DB.prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
    .bind(messageId)
    .first<RsfnMessageRow>();
  if (!row) throw new HttpError(404, 'RSFN_NOT_FOUND', 'Mensagem RSFN não encontrada.');
  if (row.status !== 'SENT') {
    throw new HttpError(409, 'RSFN_FINALIZED', `Mensagem RSFN já finalizada com status ${row.status}.`);
  }
  const transfer = await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
    .bind(row.transfer_id)
    .first<TransferRow>();
  if (!transfer) throw new HttpError(409, 'TRANSFER_MISSING', 'Transferência vinculada à mensagem não encontrada.');

  const timestamp = nowIso();

  if (String(input.decision).toUpperCase() === 'ACCEPT') {
    await env.DB.prepare(
      "UPDATE bank_rsfn_messages SET status = 'SETTLED', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?",
    )
      .bind(timestamp, context.user.id, timestamp, messageId)
      .run();
    await audit(env, {
      actorId: context.user.id,
      action: 'bank.rsfn.settled',
      resource: 'bank_rsfn_message',
      resourceId: messageId,
      details: { numCtrlIf: row.num_ctrl_if },
    });
    await queueEvent(env, {
      topic: 'bank.rsfn',
      type: 'bank.rsfn.settled',
      payload: { messageId, numCtrlIf: row.num_ctrl_if, amountCents: row.vlr_cents, settledAt: timestamp },
    });
    const updated = await env.DB.prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
      .bind(messageId)
      .first<RsfnMessageRow>();
    return { message: updated ? rsfnView(env, updated) : null, refunded: false };
  }

  const rejectionCode =
    String(input.rejectionCode ?? 'RSFN_REJECTED')
      .replace(/[^A-Za-z0-9_.-]/g, '')
      .slice(0, 20) || 'RSFN_REJECTED';
  const rejectionReason = String(input.rejectionReason ?? 'Mensagem recusada pela RSFN.')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 200);

  const customer = await env.DB.prepare(
    `SELECT u.name FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id WHERE a.id = ?`,
  )
    .bind(transfer.debit_account_id)
    .first<{ name: string }>();

  const refundId = newId('trf');
  const refundE2e = endToEnd(timestamp, row.ispb_emissor);
  const refundDescription = `Estorno RSFN ${row.num_ctrl_if} · ${rejectionCode}`;

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bank_transfers
           (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
            end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at, channel)
         VALUES (?, 'INTERNAL', ?, ?, ?, ?, 'POSTED', ?, NULL, NULL, ?, ?, ?, 'RSFN_REFUND')`,
      ).bind(
        refundId,
        RSFN_TRANSIT_ACCOUNT_ID,
        transfer.debit_account_id,
        row.vlr_cents,
        refundDescription,
        refundE2e,
        context.user.id,
        customer?.name ?? 'Câmara RSFN',
        timestamp,
      ),
      env.DB.prepare(
        `UPDATE bank_rsfn_messages
            SET status = 'REJECTED', rejection_code = ?, rejection_reason = ?,
                acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(rejectionCode, rejectionReason, timestamp, context.user.id, timestamp, messageId),
    ]);
  } catch (error) {
    mapTransferError(error);
  }

  await audit(env, {
    actorId: context.user.id,
    action: 'bank.rsfn.rejected',
    resource: 'bank_rsfn_message',
    resourceId: messageId,
    details: { numCtrlIf: row.num_ctrl_if, rejectionCode, refundTransferId: refundId },
  });
  await queueEvent(env, {
    topic: 'bank.rsfn',
    type: 'bank.rsfn.rejected',
    payload: {
      messageId,
      numCtrlIf: row.num_ctrl_if,
      amountCents: row.vlr_cents,
      rejectionCode,
      rejectionReason,
      refundTransferId: refundId,
      createdAt: timestamp,
    },
  });

  const updated = await env.DB.prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
    .bind(messageId)
    .first<RsfnMessageRow>();
  return { message: updated ? rsfnView(env, updated) : null, refunded: true, refundTransferId: refundId };
}

export async function rsfnList(env: Env, userId: string, limit = 50): Promise<Record<string, unknown>> {
  const size = Math.min(200, Math.max(1, limit));
  const rows = await env.DB.prepare(
    'SELECT * FROM bank_rsfn_messages WHERE created_by = ? ORDER BY created_at DESC LIMIT ?',
  )
    .bind(userId, size)
    .all<RsfnMessageRow>();
  return { data: (rows.results ?? []).map((row) => rsfnView(env, row)) };
}

export async function rsfnAdminList(env: Env, limit = 100): Promise<Record<string, unknown>> {
  const size = Math.min(500, Math.max(1, limit));
  const rows = await env.DB.prepare(
    'SELECT * FROM bank_rsfn_messages ORDER BY created_at DESC LIMIT ?',
  )
    .bind(size)
    .all<RsfnMessageRow>();
  return { data: (rows.results ?? []).map((row) => rsfnView(env, row)) };
}

export async function rsfnGet(
  env: Env,
  context: AuthContext,
  messageId: string,
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
    .bind(messageId)
    .first<RsfnMessageRow>();
  if (!row) throw new HttpError(404, 'RSFN_NOT_FOUND', 'Mensagem RSFN não encontrada.');
  if (row.created_by !== context.user.id && context.user.role !== 'ADMIN') {
    throw new HttpError(403, 'FORBIDDEN', 'Mensagem RSFN disponível apenas para o titular ou administrador.');
  }
  return { ...rsfnView(env, row), xml: row.xml, message: rsfnView(env, row) };
}
