import { MemoryEventBus, OutboxRelay } from '../src/kernel/bus.ts';
import { TransactionService } from '../src/modules/transactions.ts';
import { PixService } from '../src/modules/pix.ts';
import { FiscalWorker } from '../src/modules/fiscal-worker.ts';
import { SettlementWorker } from '../src/modules/settlement-worker.ts';
import { NotificationHub } from '../src/modules/notifications.ts';
import { TokenizationHub } from '../src/modules/tokenization.ts';
import { Web3Hub } from '../src/modules/web3.ts';
import { CustomerService } from '../src/modules/customers.ts';
import { BillingService } from '../src/modules/billing.ts';
import { SubscriptionService } from '../src/modules/subscriptions.ts';
import { OpenFinanceService } from '../src/modules/openfinance.ts';
import { InvestmentService } from '../src/modules/investments.ts';
import { BankService, ensureCapital, ensureTreasury } from '../src/modules/bank.ts';
import { BankFxService, ensureFxTreasury } from '../src/modules/bank-fx.ts';
import { BankAuthService } from '../src/modules/bank-auth.ts';
import { BankPixService } from '../src/modules/bank-pix.ts';
import { BankCreditService } from '../src/modules/bank-credit.ts';
import { BankPdvService } from '../src/modules/bank-pdv.ts';
import { RsfnService, ensureRsfnTransit } from '../src/modules/rsfn.ts';
import { DEMO_MERCHANT_ID } from '../src/modules/seed.ts';
import { buildApp } from '../src/api/server.ts';
import { DeviceAuthenticator, SlidingWindowLimiter, issueMerchantToken } from '../src/api/security.ts';
import { testConfig, testDb } from './helpers.ts';

export async function buildTestServer() {
  const config = testConfig();
  const db = testDb();
  ensureTreasury(db);
  ensureCapital(db);
  ensureFxTreasury(db);
  ensureRsfnTransit(db);
  const bus = new MemoryEventBus();
  const relay = new OutboxRelay(db, bus, 20);
  const transactions = new TransactionService(db, config);
  const pix = new PixService(db, config, transactions);
  const fiscal = new FiscalWorker(db, config);
  const settlements = new SettlementWorker(db, config);
  const hub = new NotificationHub(config);
  const tokenization = new TokenizationHub(db);
  const web3 = new Web3Hub(db);
  const customers = new CustomerService(db);
  const billing = new BillingService(db, transactions, pix, customers);
  const subscriptions = new SubscriptionService(db, billing, pix, customers);
  const openfinance = new OpenFinanceService(db, billing, customers);
  const investments = new InvestmentService(db);
  const bank = new BankService(db, config);
  const bankAuth = new BankAuthService(db, config, bank);
  const bankPix = new BankPixService(db);
  const bankCredit = new BankCreditService(db, bank);
  const bankPdv = new BankPdvService(db, config, bank, transactions, fiscal);
  const bankFx = new BankFxService(db, config);
  const rsfn = new RsfnService(db, config);
  const app = await buildApp({
    config,
    db,
    bus,
    relay,
    transactions,
    pix,
    fiscal,
    settlements,
    hub,
    tokenization,
    web3,
    customers,
    billing,
    subscriptions,
    openfinance,
    investments,
    bank,
    bankAuth,
    bankPix,
    bankCredit,
    bankPdv,
    bankFx,
    rsfn,
    authenticator: new DeviceAuthenticator(config),
    limiter: new SlidingWindowLimiter(1000),
  });
  fiscal.start(bus);
  const token = issueMerchantToken(config, DEMO_MERCHANT_ID);
  return {
    config,
    db,
    bus,
    relay,
    transactions,
    pix,
    fiscal,
    settlements,
    hub,
    tokenization,
    web3,
    customers,
    billing,
    subscriptions,
    openfinance,
    investments,
    bank,
    bankAuth,
    bankPix,
    bankCredit,
    bankPdv,
    bankFx,
    rsfn,
    app,
    token,
  };
}
