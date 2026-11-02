import { randomInt } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { sha256Hex } from '../kernel/crypto.ts';
import { assertPositiveCents, formatBRL, type Cents } from '../kernel/money.ts';
import { maskDocument, onlyDigits } from '../domain/documents.ts';
import {
  buildNumCtrlIf,
  buildPag0004Xml,
  parsePag0004Xml,
  type Pag0004Message,
  type RsfnIssue,
} from '../domain/rsfn.ts';
import { accountView, type BankAccountRow, type BankAccountView } from './bank.ts';

export const RSFN_TRANSIT_USER_ID = 'bank_user_rsfn';
export const RSFN_TRANSIT_ACCOUNT_ID = 'bank_acc_rsfn';

export interface RsfnMessageRow {
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

export interface RsfnMessageView {
  id: string;
  numCtrlIf: string;
  codMsg: string;
  status: string;
  transport: string;
  direction: 'OUT';
  ispbEmissor: string;
  ispbDestinatario: string;
  dtMovto: string;
  amountCents: Cents;
  amountFormatted: string;
  emitter: { name: string; documentMasked: string; clientCode: string };
  destination: { name: string; documentMasked: string; branch: string; account: string; ispb: string };
  transferId: string;
  endToEndId: string;
  xmlSha256: string;
  rejection: { code: string; reason: string } | null;
  acknowledgement: { status: string; at: string | null; canAcknowledge: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface RsfnDestination {
  ispb: string;
  branch: string;
  account: string;
  document: string;
  name: string;
}

export interface RsfnExternalInput {
  userId: string;
  accountId: string;
  amountCents: number;
  description?: string;
  destination: RsfnDestination;
  clientCode?: string;
  idempotencyKey?: string;
  now?: number;
}

export interface RsfnAcknowledgement {
  decision: 'ACCEPT' | 'REJECT';
  rejectionCode?: string;
  rejectionReason?: string;
  actorUserId: string;
  now?: number;
}

export interface RsfnConfigView {
  ispb: string | null;
  enabled: boolean;
  demoMode: boolean;
  transport: 'SIMULATED';
  endpointConfigured: boolean;
  certificatesConfigured: boolean;
  liveConnectorReady: boolean;
  xsdUrl: string;
  notes: string[];
}

type SenderRow = BankAccountRow & {
  holder_name: string;
  holder_document: string;
  user_status: string;
};

function normalizeDescription(input: string | undefined): string {
  const value = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!value) return 'Transferência interbancária RSFN';
  if (value.length > 120) throw Errors.validation('Descrição excede 120 caracteres.');
  return value;
}

function normalizeName(input: string): string {
  const value = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (value.length < 1 || value.length > 80) {
    throw Errors.validation('Nome do destinatário deve ter de 1 a 80 caracteres.');
  }
  return value;
}

function timestamp(now: number): string {
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function dateOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function refundEndToEnd(ispb: string, now: number): string {
  let suffix = '';
  for (let index = 0; index < 11; index += 1) suffix += String(randomInt(0, 10));
  return `E${ispb}${timestamp(now)}${suffix}`;
}

function fingerprint(input: RsfnExternalInput): string {
  const destination = input.destination;
  return sha256Hex(
    [
      destination.ispb,
      destination.branch,
      destination.account,
      destination.document,
      destination.name.trim(),
      input.amountCents,
      normalizeDescription(input.description),
    ].join('|'),
  );
}

export function ensureRsfnTransit(db: Db, now = Date.now()): void {
  const stamp = nowIso(now);
  db.prepare(
    `INSERT OR IGNORE INTO bank_users
       (id, name, document, email, phone, password_hash, role, status, created_at, updated_at)
     VALUES (?, 'Câmara RSFN (compensação)', '00000000000001', 'rsfn@xpartner.internal', NULL,
             '!system-account-no-login!', 'SYSTEM', 'ACTIVE', ?, ?)`,
  ).run(RSFN_TRANSIT_USER_ID, stamp, stamp);
  db.prepare(
    `INSERT OR IGNORE INTO bank_accounts
       (id, user_id, branch, number, kind, status, balance_cents, opening_balance_cents,
        per_transfer_limit_cents, daily_limit_cents, created_at, updated_at)
     VALUES (?, ?, '0000', '00000001', 'CHECKING', 'ACTIVE', 0, 0, ?, ?, ?, ?)`,
  ).run(
    RSFN_TRANSIT_ACCOUNT_ID,
    RSFN_TRANSIT_USER_ID,
    100_000_000,
    100_000_000,
    stamp,
    stamp,
  );
}

export class RsfnService {
  private readonly db: Db;
  private readonly config: AppConfig;

  constructor(db: Db, config: AppConfig) {
    this.db = db;
    this.config = config;
  }

  get enabled(): boolean {
    return Boolean(this.config.rsfn.ispb);
  }

  configView(): RsfnConfigView {
    const certificatesConfigured = Boolean(
      this.config.rsfn.certPath && this.config.rsfn.keyPath && this.config.rsfn.caPath,
    );
    const endpointConfigured = Boolean(this.config.rsfn.endpoint);
    return {
      ispb: this.config.rsfn.ispb || null,
      enabled: this.enabled,
      demoMode: this.config.demoMode,
      transport: 'SIMULATED',
      endpointConfigured,
      certificatesConfigured,
      liveConnectorReady: Boolean(this.enabled && endpointConfigured && certificatesConfigured),
      xsdUrl: '/v1/bank/rsfn/pag0004.xsd',
      notes: [
        'Mensagens PAG0004 são geradas, validadas e contabilizadas neste processo.',
        'A transmissão real exige participação na RSFN, certificado ICP-Brasil e conector mTLS homologado.',
        this.config.demoMode
          ? 'Neste ambiente o retorno da RSFN é simulado pelo administrador (aceite/recusa).'
          : 'Sem conector homologado, nenhum XML sai deste processo.',
      ],
    };
  }

  validateXml(xml: string): {
    valid: boolean;
    issues: RsfnIssue[];
    sha256: string;
    message: {
      numCtrlIf: string;
      codMsg: string;
      ispbEmissor: string;
      ispbDestinatario: string;
      dtMovto: string;
      amountCents: Cents;
      amountFormatted: string;
      emitter: { name: string; documentMasked: string };
      destination: { name: string; documentMasked: string; branch: string; account: string };
    } | null;
  } {
    const result = parsePag0004Xml(xml);
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

  create(input: RsfnExternalInput): {
    message: RsfnMessageView;
    xml: string;
    transfer: { id: string; endToEndId: string; status: string; balanceAfterCents: Cents };
    account: BankAccountView;
    replayed: boolean;
  } {
    const ispbEmissor = this.config.rsfn.ispb;
    if (!ispbEmissor) {
      throw new AppError(
        'RSFN_NOT_CONFIGURED',
        'Canal RSFN sem ISPB configurado. Defina RSFN_ISPB para emitir PAG0004.',
        403,
      );
    }
    const now = input.now ?? Date.now();
    const stamp = nowIso(now);
    const amount = assertPositiveCents(input.amountCents, 'amountCents');
    const description = normalizeDescription(input.description);
    const destination: RsfnDestination = {
      ispb: onlyDigits(input.destination.ispb),
      branch: onlyDigits(input.destination.branch),
      account: onlyDigits(input.destination.account),
      document: onlyDigits(input.destination.document),
      name: normalizeName(input.destination.name),
    };
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 120)) {
      throw Errors.validation('Idempotency-Key deve ter de 8 a 120 caracteres.');
    }
    const requestHash = fingerprint({ ...input, destination, amountCents: amount, description });

    return tx(this.db, () => {
      if (idempotencyKey) {
        const existing = this.db
          .prepare('SELECT * FROM bank_rsfn_messages WHERE created_by = ? AND idempotency_key = ?')
          .get(input.userId, idempotencyKey) as RsfnMessageRow | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw Errors.conflict('Idempotency-Key reutilizada com payload diferente.');
          }
          const account = this.db
            .prepare('SELECT * FROM bank_accounts WHERE id = ?')
            .get(input.accountId) as unknown as BankAccountRow;
          return {
            message: this.view(existing),
            xml: existing.xml,
            transfer: {
              id: existing.transfer_id,
              endToEndId: existing.num_ctrl_if,
              status: 'POSTED',
              balanceAfterCents: account?.balance_cents ?? 0,
            },
            account: accountView(account),
            replayed: true,
          };
        }
      }

      const sender = this.db
        .prepare(
          `SELECT a.*, u.name AS holder_name, u.document AS holder_document, u.status AS user_status
             FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id
            WHERE a.id = ? AND a.user_id = ?`,
        )
        .get(input.accountId, input.userId) as unknown as SenderRow | undefined;
      if (!sender) throw Errors.notFound('Conta de origem não encontrada.');
      if (sender.status !== 'ACTIVE' || sender.user_status !== 'ACTIVE') {
        throw new AppError('ACCOUNT_BLOCKED', 'Conta de origem bloqueada ou encerrada.', 403);
      }
      if (amount > sender.per_transfer_limit_cents) {
        throw new AppError(
          'TRANSFER_LIMIT',
          `Valor acima do limite por transferência de ${formatBRL(sender.per_transfer_limit_cents)}.`,
          422,
        );
      }
      const moved = this.db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total
             FROM bank_transfers
            WHERE debit_account_id = ? AND status = 'POSTED' AND created_at >= ?`,
        )
        .get(sender.id, nowIso(now - 86_400_000)) as { total: number };
      if (moved.total + amount > sender.daily_limit_cents) {
        throw new AppError(
          'DAILY_LIMIT',
          `Limite diário de ${formatBRL(sender.daily_limit_cents)} excedido. Já movimentado nas últimas 24h: ${formatBRL(moved.total)}.`,
          422,
        );
      }

      ensureRsfnTransit(this.db, now);
      const dtMovto = dateOf(now);
      const numCtrlIf = this.nextNumCtrlIf(ispbEmissor, now);
      const message: Pag0004Message = {
        numCtrlIf,
        codMsg: 'PAG0004',
        ispbEmissor,
        ispbDestinatario: destination.ispb,
        dtMovto,
        codCliEmissor: onlyDigits(input.clientCode ?? '0001') || '0001',
        documentoEmissor: sender.holder_document,
        nomeEmissor: sender.holder_name,
        agenciaDestinatario: destination.branch,
        contaDestinatario: destination.account,
        documentoDestinatario: destination.document,
        nomeDestinatario: destination.name,
        valorCents: amount,
        finalidadeTransacao: '0001',
      };
      const xml = buildPag0004Xml(message);
      const xmlSha256 = sha256Hex(xml);

      const debit = this.db
        .prepare(
          `UPDATE bank_accounts SET balance_cents = balance_cents - ?, updated_at = ?
            WHERE id = ? AND balance_cents >= ?`,
        )
        .run(amount, stamp, sender.id, amount);
      if (debit.changes !== 1) {
        throw new AppError('INSUFFICIENT_FUNDS', 'Saldo insuficiente para esta transferência.', 422);
      }
      this.db
        .prepare('UPDATE bank_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?')
        .run(amount, stamp, RSFN_TRANSIT_ACCOUNT_ID);
      const transit = this.db
        .prepare('SELECT * FROM bank_accounts WHERE id = ?')
        .get(RSFN_TRANSIT_ACCOUNT_ID) as unknown as BankAccountRow;
      const debitAfter = sender.balance_cents - amount;

      const transferId = newId('btr', now);
      this.db
        .prepare(
          `INSERT INTO bank_transfers
             (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
              end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at)
           VALUES (?, 'INTERNAL', ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          transferId,
          sender.id,
          RSFN_TRANSIT_ACCOUNT_ID,
          amount,
          description,
          numCtrlIf,
          idempotencyKey ? `rsfn:${idempotencyKey}` : null,
          idempotencyKey ? requestHash : null,
          input.userId,
          destination.name,
          stamp,
        );
      const insertEntry = this.db.prepare(
        `INSERT INTO bank_ledger
           (id, transfer_id, account_id, direction, amount_cents, balance_after_cents, memo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertEntry.run(newId('ble', now), transferId, sender.id, 'DEBIT', amount, debitAfter, description, stamp);
      insertEntry.run(
        newId('ble', now),
        transferId,
        RSFN_TRANSIT_ACCOUNT_ID,
        'CREDIT',
        amount,
        transit.balance_cents,
        description,
        stamp,
      );

      const messageId = newId('rsfn', now);
      this.db
        .prepare(
          `INSERT INTO bank_rsfn_messages
             (id, num_ctrl_if, cod_msg, ispb_emissor, ispb_destinatario, dt_movto, cod_cli_emissor,
              documento_emissor, nome_emissor, agencia_destinatario, conta_destinatario,
              documento_destinatario, nome_destinatario, vlr_cents, finalidade, status, transport,
              transfer_id, xml, xml_sha256, idempotency_key, request_hash, created_by, created_at, updated_at)
           VALUES (?, ?, 'PAG0004', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0001', 'SENT', 'SIMULATED',
                   ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          numCtrlIf,
          ispbEmissor,
          destination.ispb,
          dtMovto,
          message.codCliEmissor,
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
          idempotencyKey ?? null,
          idempotencyKey ? requestHash : null,
          input.userId,
          stamp,
          stamp,
        );

      enqueueEvent(this.db, {
        topic: 'bank.rsfn',
        type: 'bank.rsfn.sent',
        key: input.userId,
        payload: {
          messageId,
          numCtrlIf,
          transferId,
          amountCents: amount,
          ispbEmissor,
          ispbDestinatario: destination.ispb,
          xmlSha256,
          createdAt: stamp,
        },
      });
      audit(this.db, input.userId, 'bank.rsfn.sent', `bank_rsfn_message:${messageId}`, {
        numCtrlIf,
        amountCents: amount,
        ispbDestinatario: destination.ispb,
        transferId,
      });

      const created = this.db
        .prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
        .get(messageId) as unknown as RsfnMessageRow;
      return {
        message: this.view(created),
        xml,
        transfer: { id: transferId, endToEndId: numCtrlIf, status: 'POSTED', balanceAfterCents: debitAfter },
        account: accountView({ ...sender, balance_cents: debitAfter }),
        replayed: false,
      };
    });
  }

  ack(messageId: string, input: RsfnAcknowledgement): { message: RsfnMessageView; refunded: boolean } {
    if (!this.config.demoMode) {
      throw new AppError(
        'RSFN_CONNECTOR_REQUIRED',
        'Acknowledgment manual é exclusivo do modo demo. Em produção, o retorno vem do conector RSFN.',
        403,
      );
    }
    const now = input.now ?? Date.now();
    const stamp = nowIso(now);
    return tx(this.db, () => {
      const row = this.db
        .prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
        .get(messageId) as RsfnMessageRow | undefined;
      if (!row) throw Errors.notFound('Mensagem RSFN não encontrada.');
      if (row.status !== 'SENT') {
        throw Errors.conflict(`Mensagem RSFN já finalizada com status ${row.status}.`);
      }
      const transfer = this.db
        .prepare('SELECT * FROM bank_transfers WHERE id = ?')
        .get(row.transfer_id) as
        | { id: string; debit_account_id: string; credit_account_id: string; amount_cents: number }
        | undefined;
      if (!transfer) throw Errors.conflict('Transferência vinculada à mensagem não encontrada.');

      if (input.decision === 'ACCEPT') {
        this.db
          .prepare(
            `UPDATE bank_rsfn_messages
                SET status = 'SETTLED', acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(stamp, input.actorUserId, stamp, messageId);
        enqueueEvent(this.db, {
          topic: 'bank.rsfn',
          type: 'bank.rsfn.settled',
          key: row.created_by,
          payload: { messageId, numCtrlIf: row.num_ctrl_if, amountCents: row.vlr_cents, settledAt: stamp },
        });
        audit(this.db, input.actorUserId, 'bank.rsfn.settled', `bank_rsfn_message:${messageId}`, {
          numCtrlIf: row.num_ctrl_if,
        });
        const updated = this.db
          .prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
          .get(messageId) as unknown as RsfnMessageRow;
        return { message: this.view(updated), refunded: false };
      }

      const rejectionCode = String(input.rejectionCode ?? 'RSFN_REJECTED')
        .replace(/[^A-Za-z0-9_.-]/g, '')
        .slice(0, 20) || 'RSFN_REJECTED';
      const rejectionReason = String(input.rejectionReason ?? 'Mensagem recusada pela RSFN.')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 200);
      const refund = this.db
        .prepare(
          `UPDATE bank_accounts SET balance_cents = balance_cents - ?, updated_at = ?
            WHERE id = ? AND balance_cents >= ?`,
        )
        .run(row.vlr_cents, stamp, RSFN_TRANSIT_ACCOUNT_ID, row.vlr_cents);
      if (refund.changes !== 1) {
        throw new AppError('RSFN_CLEARING_EMPTY', 'Conta de compensação sem saldo para estornar.', 409);
      }
      this.db
        .prepare('UPDATE bank_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?')
        .run(row.vlr_cents, stamp, transfer.debit_account_id);
      const customer = this.db
        .prepare('SELECT * FROM bank_accounts WHERE id = ?')
        .get(transfer.debit_account_id) as unknown as BankAccountRow;
      const transit = this.db
        .prepare('SELECT * FROM bank_accounts WHERE id = ?')
        .get(RSFN_TRANSIT_ACCOUNT_ID) as unknown as BankAccountRow;
      const creditAfter = customer.balance_cents;

      const refundId = newId('btr', now);
      const endToEnd = refundEndToEnd(row.ispb_emissor, now);
      const description = `Estorno RSFN ${row.num_ctrl_if} · ${rejectionCode}`;
      this.db
        .prepare(
          `INSERT INTO bank_transfers
             (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
              end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at)
           VALUES (?, 'INTERNAL', ?, ?, ?, ?, 'POSTED', ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          refundId,
          RSFN_TRANSIT_ACCOUNT_ID,
          customer.id,
          row.vlr_cents,
          description,
          endToEnd,
          input.actorUserId,
          'Câmara RSFN',
          stamp,
        );
      const insertEntry = this.db.prepare(
        `INSERT INTO bank_ledger
           (id, transfer_id, account_id, direction, amount_cents, balance_after_cents, memo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertEntry.run(
        newId('ble', now),
        refundId,
        RSFN_TRANSIT_ACCOUNT_ID,
        'DEBIT',
        row.vlr_cents,
        transit.balance_cents,
        description,
        stamp,
      );
      insertEntry.run(
        newId('ble', now),
        refundId,
        customer.id,
        'CREDIT',
        row.vlr_cents,
        creditAfter,
        description,
        stamp,
      );

      this.db
        .prepare(
          `UPDATE bank_rsfn_messages
              SET status = 'REJECTED', rejection_code = ?, rejection_reason = ?,
                  acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(rejectionCode, rejectionReason, stamp, input.actorUserId, stamp, messageId);

      enqueueEvent(this.db, {
        topic: 'bank.rsfn',
        type: 'bank.rsfn.rejected',
        key: row.created_by,
        payload: {
          messageId,
          numCtrlIf: row.num_ctrl_if,
          amountCents: row.vlr_cents,
          rejectionCode,
          rejectionReason,
          refundTransferId: refundId,
          createdAt: stamp,
        },
      });
      audit(this.db, input.actorUserId, 'bank.rsfn.rejected', `bank_rsfn_message:${messageId}`, {
        numCtrlIf: row.num_ctrl_if,
        rejectionCode,
        refundTransferId: refundId,
      });

      const updated = this.db
        .prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
        .get(messageId) as unknown as RsfnMessageRow;
      return { message: this.view(updated), refunded: true };
    });
  }

  list(userId: string, limit = 50): RsfnMessageView[] {
    const size = Math.min(200, Math.max(1, limit));
    const rows = this.db
      .prepare('SELECT * FROM bank_rsfn_messages WHERE created_by = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, size) as unknown as RsfnMessageRow[];
    return rows.map((row) => this.view(row));
  }

  adminList(limit = 100): RsfnMessageView[] {
    const size = Math.min(500, Math.max(1, limit));
    const rows = this.db
      .prepare('SELECT * FROM bank_rsfn_messages ORDER BY created_at DESC LIMIT ?')
      .all(size) as unknown as RsfnMessageRow[];
    return rows.map((row) => this.view(row));
  }

  get(messageId: string, requester: { userId: string; role: string }): RsfnMessageView & { xml: string } {
    const row = this.db
      .prepare('SELECT * FROM bank_rsfn_messages WHERE id = ?')
      .get(messageId) as RsfnMessageRow | undefined;
    if (!row) throw Errors.notFound('Mensagem RSFN não encontrada.');
    if (row.created_by !== requester.userId && requester.role !== 'ADMIN') {
      throw Errors.forbidden('Mensagem RSFN disponível apenas para o titular ou administrador.');
    }
    return { ...this.view(row), xml: row.xml };
  }

  private nextNumCtrlIf(ispb: string, now: number): string {
    const statement = this.db.prepare('SELECT 1 AS found FROM bank_rsfn_messages WHERE num_ctrl_if = ?');
    for (let sequence = 1; sequence <= 999; sequence += 1) {
      const candidate = buildNumCtrlIf(ispb, now, sequence);
      if (!statement.get(candidate)) return candidate;
    }
    throw new AppError('RSFN_SEQUENCE', 'Sequência de NumCtrlIF esgotada neste segundo.', 409);
  }

  private view(row: RsfnMessageRow): RsfnMessageView {
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
      rejection: row.rejection_code
        ? { code: row.rejection_code, reason: row.rejection_reason ?? '' }
        : null,
      acknowledgement: {
        status: row.status,
        at: row.acknowledged_at,
        canAcknowledge: row.status === 'SENT' && this.config.demoMode,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
