import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { nowIso } from '../kernel/db.ts';
import { log } from '../kernel/logger.ts';
import { devTokenFor } from '../domain/vault.ts';
import type { PixService } from './pix.ts';
import type { TransactionService } from './transactions.ts';

export const DEMO_MERCHANT_ID = 'mch_xpartner_demo';
export const DEMO_TERMINAL_ID = 'trm_tap_demo';

export function seedCore(db: Db): void {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM merchants').get() as { count: number };
  if (existing.count > 0) return;
  const createdAt = nowIso();

  db.prepare(
    `INSERT INTO merchants (id, name, trade_name, document, mcc, ie, crt, city, uf, pix_key, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
  ).run(
    DEMO_MERCHANT_ID,
    'PAO DE OURO COMERCIO DE ALIMENTOS LTDA',
    'Padaria Pao de Ouro',
    '12345678000195',
    '5812',
    '110042490114',
    '1',
    'SAO PAULO',
    'SP',
    'pagamentos@xpartner.com.br',
    createdAt,
  );

  const terminals = db.prepare(
    `INSERT INTO terminals (id, merchant_id, serial, model, cert_fingerprint, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
  );
  terminals.run(DEMO_TERMINAL_ID, DEMO_MERCHANT_ID, 'XP-TAP-0001', 'XPartner Tap (iPhone/Android)', 'a1b2c3d4e5f60718', createdAt);
  terminals.run('trm_smartpos_demo', DEMO_MERCHANT_ID, 'XP-POS-0002', 'XPartner SmartPOS AOSP', '90ab12cd34ef5678', createdAt);

  const acquirers = db.prepare(
    `INSERT INTO acquirers
       (id, name, debit_bps, credit_bps, pix_bps, installments_bps, fixed_fee_cents, brands, success_rate, priority, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  acquirers.run('acq_getnet', 'Getnet', 119, 215, 0, 65, 0, '["*"]', 0.958, 30, createdAt);
  acquirers.run('acq_stone', 'Stone', 155, 189, 0, 79, 10, '["*"]', 0.981, 40, createdAt);
  acquirers.run('acq_rede', 'Rede', 129, 199, 0, 95, 0, '["visa","master","elo"]', 0.972, 10, createdAt);
  acquirers.run('acq_cielo', 'Cielo', 135, 195, 0, 85, 15, '["*"]', 0.965, 20, createdAt);
  acquirers.run('acq_spi', 'SPI / Pix', 0, 0, 30, 0, 0, '["*"]', 0.999, 1, createdAt);

  log.info('seed.core', { merchantId: DEMO_MERCHANT_ID });
}

interface DemoSeed {
  daysAgo: number;
  hour: number;
  amountCents: number;
  method: 'CREDIT' | 'DEBIT' | 'PIX';
  installments: number;
  brand?: string;
  last4?: string;
  description: string;
}

const DEMO_SALES: DemoSeed[] = [
  { daysAgo: 6, hour: 9, amountCents: 1890, method: 'DEBIT', installments: 1, brand: 'visa', last4: '4242', description: 'Café da manhã completo' },
  { daysAgo: 6, hour: 12, amountCents: 4590, method: 'CREDIT', installments: 1, brand: 'master', last4: '5123', description: 'Combo almoço executivo' },
  { daysAgo: 5, hour: 15, amountCents: 12900, method: 'PIX', installments: 1, description: 'Cesta de café da manhã' },
  { daysAgo: 4, hour: 10, amountCents: 7800, method: 'CREDIT', installments: 3, brand: 'elo', last4: '6363', description: 'Kit presente corporativo' },
  { daysAgo: 3, hour: 16, amountCents: 25000, method: 'CREDIT', installments: 6, brand: 'visa', last4: '4111', description: 'Encomenda de festa' },
  { daysAgo: 2, hour: 11, amountCents: 5600, method: 'DEBIT', installments: 1, brand: 'master', last4: '0000', description: 'Cartão de teste bloqueado' },
  { daysAgo: 1, hour: 14, amountCents: 12300, method: 'CREDIT', installments: 2, brand: 'visa', last4: '4242', description: 'Doces artesanais para evento' },
  { daysAgo: 0, hour: 8, amountCents: 8900, method: 'PIX', installments: 1, description: 'Fardo de bebidas' },
];

export function seedDemoData(db: Db, config: AppConfig, transactions: TransactionService, pix: PixService): void {
  if (!config.demoMode || !config.seedDemo) return;
  const existing = db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number };
  if (existing.count > 0) return;

  for (const sale of DEMO_SALES) {
    const now = Date.now() - sale.daysAgo * 86_400_000;
    const date = new Date(now);
    date.setHours(sale.hour, 0, 0, 0);
    const token = sale.method === 'PIX' ? undefined : devTokenFor(sale.brand ?? 'visa', sale.last4 ?? '4242', `${sale.description}:${sale.daysAgo}`);
    try {
      transactions.createSale({
        merchantId: DEMO_MERCHANT_ID,
        terminalId: DEMO_TERMINAL_ID,
        amountCents: sale.amountCents,
        method: sale.method,
        installments: sale.installments,
        paymentToken: token,
        description: sale.description,
        source: 'DEMO',
        now: date.getTime(),
      });
    } catch (error) {
      log.warn('seed.sale_failed', { description: sale.description, error: error instanceof Error ? error.message : String(error) });
    }
  }

  try {
    const { charge } = pix.createCharge({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      amountCents: 3490,
      description: 'Cobrança Pix de demonstração',
    });
    pix.payCharge(charge.txid);
  } catch (error) {
    log.warn('seed.pix_failed', { error: error instanceof Error ? error.message : String(error) });
  }

  log.info('seed.demo_data', { sales: DEMO_SALES.length });
}
