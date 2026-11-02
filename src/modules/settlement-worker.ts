import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { log } from '../kernel/logger.ts';
import { metrics } from '../kernel/metrics.ts';
import { formatBRL } from '../kernel/money.ts';
import { postGroup } from '../domain/ledger.ts';
import { advanceOffer } from '../domain/settlement.ts';
import type { AdvanceOffer } from '../domain/settlement.ts';

interface DueSettlement {
  id: string;
  transaction_id: string;
  merchant_id: string;
  net_cents: number;
  scheduled_at: string;
}

interface SettlementRow {
  id: string;
  transaction_id: string;
  merchant_id: string;
  gross_cents: number;
  acquirer_fee_cents: number;
  advance_fee_cents: number;
  net_cents: number;
  scheduled_at: string;
  status: string;
  mode: string;
  paid_at: string | null;
  created_at: string;
}

function publicSettlement(row: SettlementRow) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    merchantId: row.merchant_id,
    grossCents: row.gross_cents,
    acquirerFeeCents: row.acquirer_fee_cents,
    advanceFeeCents: row.advance_fee_cents,
    netCents: row.net_cents,
    netFormatted: formatBRL(row.net_cents),
    scheduledAt: row.scheduled_at,
    status: row.status,
    mode: row.mode,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

export class SettlementWorker {
  private timer: NodeJS.Timeout | undefined;
  private readonly db: Db;
  private readonly config: AppConfig;

  constructor(db: Db, config: AppConfig) {
    this.db = db;
    this.config = config;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.settleDue();
      } catch (error) {
        log.error('settlement.tick_failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }, this.config.settlementIntervalMs);
    this.timer.unref();
    this.settleDue();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Liquida recebíveis vencidos, sempre com lançamento de dupla entrada. */
  settleDue(now: number = Date.now()): number {
    const due = this.db
      .prepare(
        `SELECT s.id, s.transaction_id, s.merchant_id, s.net_cents, s.scheduled_at
           FROM settlements s JOIN transactions t ON t.id = s.transaction_id
          WHERE s.status = 'PENDING' AND s.scheduled_at <= ? AND t.status = 'APPROVED'
          ORDER BY s.scheduled_at ASC LIMIT 100`,
      )
      .all(nowIso(now)) as unknown as DueSettlement[];

    let settled = 0;
    for (const settlement of due) {
      try {
        tx(this.db, () => {
          const current = this.db
            .prepare("SELECT status FROM settlements WHERE id = ?")
            .get(settlement.id) as { status: string } | undefined;
          if (!current || current.status !== 'PENDING') return;
          postGroup(this.db, {
            groupId: settlement.id,
            groupKind: 'SETTLEMENT',
            transactionId: settlement.transaction_id,
            entries: [
              {
                kind: 'MERCHANT_PAYABLE',
                ownerType: 'MERCHANT',
                ownerId: settlement.merchant_id,
                direction: 'DEBIT',
                amountCents: settlement.net_cents,
                memo: `Liquidação ${settlement.transaction_id}`,
              },
              {
                kind: 'MERCHANT_AVAILABLE',
                ownerType: 'MERCHANT',
                ownerId: settlement.merchant_id,
                direction: 'CREDIT',
                amountCents: settlement.net_cents,
                memo: `Crédito liberado ${settlement.transaction_id}`,
              },
            ],
          });
          const paidAt = nowIso(now);
          this.db.prepare("UPDATE settlements SET status = 'PAID', paid_at = ? WHERE id = ?").run(paidAt, settlement.id);
          this.db.prepare('UPDATE transactions SET paid_at = ?, updated_at = ? WHERE id = ?').run(
            paidAt,
            paidAt,
            settlement.transaction_id,
          );
          enqueueEvent(this.db, {
            topic: 'settlement.paid',
            type: 'LiquidacaoPaga',
            key: settlement.merchant_id,
            payload: {
              settlementId: settlement.id,
              transactionId: settlement.transaction_id,
              merchantId: settlement.merchant_id,
              netCents: settlement.net_cents,
              mode: 'STANDARD',
              paidAt,
            },
          });
          audit(this.db, 'settlement-worker', 'SETTLEMENT_PAID', settlement.transaction_id, {
            netCents: settlement.net_cents,
          });
        });
        settled += 1;
      } catch (error) {
        log.error('settlement.failed', {
          settlementId: settlement.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (settled > 0) metrics.inc('settlements_paid_total', {}, settled);
    return settled;
  }

  getByTransaction(transactionId: string) {
    const row = this.db.prepare('SELECT * FROM settlements WHERE transaction_id = ?').get(transactionId) as
      | SettlementRow
      | undefined;
    if (!row) throw Errors.notFound('Liquidação não encontrada.');
    return publicSettlement(row);
  }

  offer(transactionId: string, now: number = Date.now()): AdvanceOffer {
    return advanceOffer(this.db, transactionId, now);
  }

  /** Antecipação: troca o recebível por saldo disponível, cobrando taxa dinâmica. */
  anticipate(transactionId: string, now: number = Date.now()): { offer: AdvanceOffer; settlement: ReturnType<typeof publicSettlement> } {
    const offer = advanceOffer(this.db, transactionId, now);
    if (!offer.eligible || !offer.settlementId) {
      throw new AppError('ADVANCE_NOT_ELIGIBLE', 'Recebível não elegível para antecipação.', 422, {
        reasons: offer.reasons,
      });
    }
    const settlement = this.db
      .prepare('SELECT * FROM settlements WHERE id = ?')
      .get(offer.settlementId) as SettlementRow | undefined;
    if (!settlement) throw Errors.notFound('Liquidação não encontrada.');

    tx(this.db, () => {
      const current = this.db
        .prepare("SELECT status FROM settlements WHERE id = ?")
        .get(settlement.id) as { status: string } | undefined;
      if (!current || current.status !== 'PENDING') {
        throw new AppError('ADVANCE_ALREADY_DONE', 'Recebível já liquidado.', 409);
      }
      postGroup(this.db, {
        groupId: `adv_${settlement.id}`,
        groupKind: 'ANTICIPATION',
        transactionId: settlement.transaction_id,
        entries: [
          {
            kind: 'MERCHANT_PAYABLE',
            ownerType: 'MERCHANT',
            ownerId: settlement.merchant_id,
            direction: 'DEBIT',
            amountCents: settlement.net_cents,
            memo: `Antecipação ${settlement.transaction_id}`,
          },
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: settlement.merchant_id,
            direction: 'CREDIT',
            amountCents: offer.netCents,
            memo: `Antecipação liberada ${settlement.transaction_id}`,
          },
          {
            kind: 'ANTICIPATION_REVENUE',
            direction: 'CREDIT',
            amountCents: offer.feeCents,
            memo: `Taxa de antecipação ${offer.rateBps} bps`,
          },
        ],
      });
      const paidAt = nowIso(now);
      this.db
        .prepare(
          `UPDATE settlements
              SET status = 'PAID', mode = 'ANTICIPATION', advance_fee_cents = ?, net_cents = ?, paid_at = ?
            WHERE id = ?`,
        )
        .run(offer.feeCents, offer.netCents, paidAt, settlement.id);
      this.db.prepare('UPDATE transactions SET paid_at = ?, updated_at = ? WHERE id = ?').run(
        paidAt,
        paidAt,
        settlement.transaction_id,
      );
      enqueueEvent(this.db, {
        topic: 'settlement.paid',
        type: 'LiquidacaoPaga',
        key: settlement.merchant_id,
        payload: {
          settlementId: settlement.id,
          transactionId: settlement.transaction_id,
          merchantId: settlement.merchant_id,
          netCents: offer.netCents,
          feeCents: offer.feeCents,
          mode: 'ANTICIPATION',
          paidAt,
        },
      });
      audit(this.db, 'settlement-worker', 'ADVANCE_PAID', settlement.transaction_id, {
        rateBps: offer.rateBps,
        feeCents: offer.feeCents,
        netCents: offer.netCents,
      });
    });

    return { offer, settlement: this.getByTransaction(transactionId) };
  }
}
