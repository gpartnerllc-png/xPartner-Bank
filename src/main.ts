import { loadConfig } from './config.ts';
import { closeDb, migrate, openDb } from './kernel/db.ts';
import { MemoryEventBus, OutboxRelay } from './kernel/bus.ts';
import { log } from './kernel/logger.ts';
import { metrics } from './kernel/metrics.ts';
import { TransactionService } from './modules/transactions.ts';
import { PixService } from './modules/pix.ts';
import { FiscalWorker } from './modules/fiscal-worker.ts';
import { SettlementWorker } from './modules/settlement-worker.ts';
import { NotificationHub } from './modules/notifications.ts';
import { TokenizationHub } from './modules/tokenization.ts';
import { Web3Hub } from './modules/web3.ts';
import { seedWeb3 } from './modules/web3-seed.ts';
import { AladdinEngine } from './modules/aladdin.ts';
import { CrossChainHub } from './modules/crosschain.ts';
import { seedAladdin } from './modules/aladdin-seed.ts';
import { CustomerService } from './modules/customers.ts';
import { BillingService } from './modules/billing.ts';
import { SubscriptionService, SubscriptionWorker } from './modules/subscriptions.ts';
import { OpenFinanceService } from './modules/openfinance.ts';
import { InvestmentService } from './modules/investments.ts';
import { BankService, ensureCapital, ensureTreasury } from './modules/bank.ts';
import { BankAuthService } from './modules/bank-auth.ts';
import { BankPixService } from './modules/bank-pix.ts';
import { BankCreditService } from './modules/bank-credit.ts';
import { BankPdvService } from './modules/bank-pdv.ts';
import { BankFxService, ensureFxTreasury } from './modules/bank-fx.ts';
import { RsfnService, ensureRsfnTransit } from './modules/rsfn.ts';
import { DEMO_MERCHANT_ID, DEMO_TERMINAL_ID, seedCore, seedDemoData } from './modules/seed.ts';
import { seedTokenization } from './modules/tokenization-seed.ts';
import { seedBilling } from './modules/billing-seed.ts';
import { seedOpenFinance } from './modules/openfinance-seed.ts';
import { seedInvestments } from './modules/investments-seed.ts';
import { buildApp } from './api/server.ts';
import { buildMtlsApp } from './api/mtls.ts';
import { DeviceAuthenticator, SlidingWindowLimiter, issueMerchantToken } from './api/security.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
migrate(db);
seedCore(db);
ensureTreasury(db);
ensureCapital(db);
ensureFxTreasury(db);
ensureRsfnTransit(db);

const bus = new MemoryEventBus();
const relay = new OutboxRelay(db, bus, 50);
const transactions = new TransactionService(db, config);
const pix = new PixService(db, config, transactions);
const fiscal = new FiscalWorker(db, config);
const settlements = new SettlementWorker(db, config);
const hub = new NotificationHub(config);
const tokenization = new TokenizationHub(db);
const web3 = new Web3Hub(db);
const aladdin = new AladdinEngine(db);
const crosschain = new CrossChainHub(db);
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
const subscriptionWorker = new SubscriptionWorker(subscriptions, config.subscriptionIntervalMs);

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
  aladdin,
  crosschain,
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
  limiter: new SlidingWindowLimiter(config.rateLimitPerMinute),
});

const mtlsApp = config.mtls
  ? buildMtlsApp({ config, db, transactions, limiter: new SlidingWindowLimiter(config.rateLimitPerMinute) })
  : null;

hub.attach(app.server);
hub.start(bus);
fiscal.start(bus);
relay.start();
settlements.start();

seedDemoData(db, config, transactions, pix);
seedTokenization(db, tokenization, config);
seedWeb3(db, web3, config);
seedAladdin(aladdin, crosschain, config);
seedBilling(db, config, customers, billing, subscriptions);
seedOpenFinance(db, config, openfinance);
seedInvestments(db, config, investments);
settlements.settleDue();
investments.settleDue();
subscriptionWorker.start();

metrics.gauge('transactions_total', (db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server.shutdown', { signal });
  relay.stop();
  settlements.stop();
  subscriptionWorker.stop();
  hub.close();
  await app.close();
  if (mtlsApp) await mtlsApp.close();
  closeDb(db);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
if (mtlsApp && config.mtls) {
  await mtlsApp.listen({ port: config.mtls.port, host: config.mtls.host });
}

const url = `http://localhost:${config.port}`;
const mtlsUrl = config.mtls ? `https://localhost:${config.mtls.port}/v1/secure-checkout` : null;
const banner = [
  '',
  '  ╔══════════════════════════════════════════════════════════════╗',
  '  ║   X P A R T N E R   B A N K                                  ║',
  '  ║   core bancário · adquirência · Pix · fiscal em tempo real   ║',
  '  ╚══════════════════════════════════════════════════════════════╝',
  `  Dashboard ........ ${url}`,
  `  Aplicativo ....... ${url}/app`,
  `  Banco ............ ${url}/bank`,
  `  Core Bank OS ..... ${url}/core`,
  `  RSFN / PAG0004 ... ${config.rsfn.ispb ? `ISPB ${config.rsfn.ispb} (${config.demoMode ? 'retorno simulado' : 'conector pendente'})` : 'desativado (RSFN_ISPB ausente)'}`,
  `  Checkout ......... ${url}/pay/{código}`,
  `  Checkout mTLS .... ${mtlsUrl ?? 'desativado (MTLS_* não configurado)'}`,
  `  API .............. ${url}/v1`,
  `  Métricas ......... ${url}/metrics`,
  `  OpenAPI .......... ${url}/openapi.json`,
  `  Ambiente ......... ${config.env}${config.demoMode ? ' (demo)' : ''}`,
  `  Estabelecimento .. ${DEMO_MERCHANT_ID}`,
  `  Terminal ......... ${DEMO_TERMINAL_ID}`,
  '',
].join('\n');
console.log(banner);

if (config.demoMode) {
  const token = issueMerchantToken(config, DEMO_MERCHANT_ID);
  console.log(`  Token de demonstração (expira em ${config.tokenTtlSeconds}s):`);
  console.log(`  ${token.slice(0, 24)}…`);
  console.log('');
}

log.info('server.started', {
  port: config.port,
  env: config.env,
  demoMode: config.demoMode,
  dbPath: config.dbPath,
});
