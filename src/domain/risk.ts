import type { Db } from '../kernel/db.ts';
import { nowIso } from '../kernel/db.ts';
import { newId } from '../kernel/ids.ts';
import { formatBRL } from '../kernel/money.ts';

export type RiskDecision = 'APPROVE' | 'REVIEW' | 'DECLINE';
export type PaymentMethod = 'CREDIT' | 'DEBIT' | 'PIX' | 'VOUCHER';

export interface RiskInput {
  merchantId: string;
  terminalId: string;
  cardFingerprint?: string;
  amountCents: number;
  method: PaymentMethod;
  brand?: string;
  installments: number;
  hour?: number;
  now?: number;
}

export interface RiskReason {
  code: string;
  weight: number;
  detail: string;
}

export interface RiskResult {
  score: number;
  decision: RiskDecision;
  reasons: RiskReason[];
}

export interface RiskThresholds {
  review: number;
  decline: number;
}

const DEFAULT_THRESHOLDS: RiskThresholds = { review: 45, decline: 75 };

/**
 * Motor de risco em tempo real com features de velocidade e proximidade de grafo.
 * Explicável por design: cada ponto do score vem de um motivo auditável.
 */
export function assessRisk(db: Db, input: RiskInput, thresholds: RiskThresholds = DEFAULT_THRESHOLDS): RiskResult {
  const now = input.now ?? Date.now();
  const hour = input.hour ?? new Date(now).getHours();
  const reasons: RiskReason[] = [];
  let score = 0;

  const add = (code: string, weight: number, detail: string) => {
    score += weight;
    reasons.push({ code, weight, detail });
  };

  if (input.cardFingerprint) {
    const velocity = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total
           FROM transactions
          WHERE card_fingerprint = ? AND created_at >= ? AND status IN ('APPROVED','PENDING')`,
      )
      .get(input.cardFingerprint, new Date(now - 3_600_000).toISOString()) as { count: number; total: number };

    if (velocity.count >= 5) {
      add('VELOCITY_1H', 30, `${velocity.count} usos do cartão na última hora (${formatBRL(velocity.total)}).`);
    } else if (velocity.count >= 3) {
      add('VELOCITY_1H', 16, `${velocity.count} usos do cartão na última hora.`);
    }

    const exposure = db
      .prepare(
        `SELECT COUNT(DISTINCT terminal_id) AS terminals
           FROM transactions
          WHERE card_fingerprint = ? AND created_at >= ?`,
      )
      .get(input.cardFingerprint, new Date(now - 86_400_000).toISOString()) as { terminals: number };

    if (exposure.terminals >= 4) {
      add('GRAPH_CARD_FANOUT', 28, `Cartão visto em ${exposure.terminals} terminais distintos em 24h.`);
    } else if (exposure.terminals >= 2) {
      add('GRAPH_CARD_FANOUT', 10, `Cartão visto em ${exposure.terminals} terminais em 24h.`);
    }

    const flagged = db
      .prepare("SELECT COUNT(*) AS count FROM risk_links WHERE entity_a = ? AND relation = 'FLAGGED'")
      .get(input.cardFingerprint) as { count: number };
    if (flagged.count > 0) {
      add('GRAPH_FLAGGED_LINK', 45, 'Cartão conectado a entidade sinalizada no grafo de risco.');
    }
  }

  const merchantVolume = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(AVG(amount_cents), 0) AS avg
         FROM transactions
        WHERE merchant_id = ? AND created_at >= ? AND status = 'APPROVED'`,
    )
    .get(input.merchantId, new Date(now - 30 * 86_400_000).toISOString()) as { count: number; avg: number };

  if (merchantVolume.count >= 3 && merchantVolume.avg > 0) {
    const ratio = input.amountCents / merchantVolume.avg;
    if (ratio >= 6) add('AMOUNT_ANOMALY', 26, `Ticket ${ratio.toFixed(1)}x acima da média do estabelecimento.`);
    else if (ratio >= 3.5) add('AMOUNT_ANOMALY', 14, `Ticket ${ratio.toFixed(1)}x acima da média do estabelecimento.`);
  }

  if (hour >= 1 && hour <= 5) add('ODD_HOUR', 6, `Transação às ${String(hour).padStart(2, '0')}h.`);
  if (input.installments >= 12) add('HIGH_INSTALLMENTS', 8, `${input.installments} parcelas solicitadas.`);
  if (input.method === 'CREDIT' && input.amountCents >= 500_000) {
    add('HIGH_TICKET', 8, `Ticket elevado: ${formatBRL(input.amountCents)}.`);
  }

  // Grafos permitem detectar "mesmo dispositivo, múltiplos cartões": consulta de fan-in.
  const terminalCards = db
    .prepare(
      `SELECT COUNT(DISTINCT card_fingerprint) AS cards
         FROM transactions
        WHERE terminal_id = ? AND card_fingerprint IS NOT NULL AND created_at >= ?`,
    )
    .get(input.terminalId, new Date(now - 86_400_000).toISOString()) as { cards: number };
  if (terminalCards.cards >= 8) {
    add('GRAPH_TERMINAL_FANIN', 18, `${terminalCards.cards} cartões diferentes no mesmo terminal em 24h.`);
  }

  const finalScore = Math.min(100, score);
  const decision: RiskDecision =
    finalScore >= thresholds.decline ? 'DECLINE' : finalScore >= thresholds.review ? 'REVIEW' : 'APPROVE';

  if (finalScore > 0 && reasons.length === 0) {
    reasons.push({ code: 'BASELINE', weight: 0, detail: 'Sem sinais relevantes.' });
  }

  return { score: finalScore, decision, reasons };
}

export function recordRiskLinks(
  db: Db,
  input: { cardFingerprint?: string; terminalId: string; merchantId: string; flagged?: boolean },
): void {
  const createdAt = nowIso();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO risk_links
       (id, entity_a, entity_a_type, entity_b, entity_b_type, relation, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(newId('rl'), input.terminalId, 'TERMINAL', input.merchantId, 'MERCHANT', 'TERMINAL_OF', 1, createdAt);
  if (input.flagged) {
    insert.run(newId('rl'), input.cardFingerprint ?? input.terminalId, 'CARD', input.terminalId, 'TERMINAL', 'FLAGGED', 1, createdAt);
  }
  if (!input.cardFingerprint) return;
  insert.run(newId('rl'), input.cardFingerprint, 'CARD', input.terminalId, 'TERMINAL', 'CARD_AT_TERMINAL', 1, createdAt);
  insert.run(newId('rl'), input.cardFingerprint, 'CARD', input.merchantId, 'MERCHANT', 'CARD_AT_MERCHANT', 1, createdAt);
}

export function riskGraphStats(db: Db): {
  nodes: number;
  edges: number;
  flagged: number;
  highFanoutCards: number;
} {
  const edges = db.prepare('SELECT COUNT(*) AS count FROM risk_links').get() as { count: number };
  const flagged = db.prepare("SELECT COUNT(*) AS count FROM risk_links WHERE relation = 'FLAGGED'").get() as {
    count: number;
  };
  const nodes = db
    .prepare('SELECT COUNT(*) AS count FROM (SELECT entity_a AS e FROM risk_links UNION SELECT entity_b FROM risk_links)')
    .get() as { count: number };
  const fanout = db
    .prepare("SELECT COUNT(*) AS count FROM risk_links WHERE relation = 'CARD_AT_TERMINAL' AND weight >= 1")
    .get() as { count: number };
  return { nodes: nodes.count, edges: edges.count, flagged: flagged.count, highFanoutCards: fanout.count };
}
