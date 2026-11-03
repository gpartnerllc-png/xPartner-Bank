import path from 'node:path';

export interface FiscalConfig {
  uf: string;
  cUF: string;
  cMun: string;
  ambiente: 'homologacao' | 'producao';
  serie: number;
  rejectionPct: number;
  latencyMs: number;
  companyName: string;
}

export interface MtlsConfig {
  port: number;
  host: string;
  keyPath: string;
  certPath: string;
  caPath: string;
  requestCert: boolean;
  rejectUnauthorized: boolean;
}

export interface RsfnConfig {
  /** ISPB de 8 dígitos da instituição emissora. Vazio = canal não habilitado. */
  ispb: string;
  endpoint?: string;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
}

export interface AppConfig {
  env: string;
  isProduction: boolean;
  port: number;
  host: string;
  dbPath: string;
  demoMode: boolean;
  seedDemo: boolean;
  masterKey: string;
  tokenTtlSeconds: number;
  hmacWindowSeconds: number;
  rateLimitPerMinute: number;
  settlementIntervalMs: number;
  subscriptionIntervalMs: number;
  /** Sessão do aplicativo bancário (cookie HttpOnly + Bearer). */
  bankSessionTtlSeconds: number;
  /** Token exigido para criar o primeiro ADMIN fora do modo demo. */
  bankBootstrapToken?: string;
  /** Listener HTTPS mutual-TLS para maquininhas. Ausente = HTTP simples. */
  mtls?: MtlsConfig;
  /** Canal RSFN/PAG0004 (BCB). Sem ISPB informado, o envio fica desabilitado. */
  rsfn: RsfnConfig;
  fiscal: FiscalConfig;
  /** Chave privada RSA (PEM) para assinatura XML. Em dev, gerada em memória. */
  fiscalPrivateKeyPem?: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'sim'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Só habilita mTLS quando os três caminhos são informados. Caminhos parciais
 * falham cedo para não subir um listener que finge ser mutual-TLS.
 */
function loadMtls(env: NodeJS.ProcessEnv, host: string): MtlsConfig | undefined {
  const keyPath = env.MTLS_KEY_PATH?.trim();
  const certPath = env.MTLS_CERT_PATH?.trim();
  const caPath = env.MTLS_CA_PATH?.trim();
  if (!keyPath && !certPath && !caPath) return undefined;
  if (!keyPath || !certPath || !caPath) {
    throw new Error('MTLS_KEY_PATH, MTLS_CERT_PATH e MTLS_CA_PATH precisam ser informados juntos.');
  }
  return {
    port: int(env.MTLS_PORT, 8443, 1, 65535),
    host: env.MTLS_HOST?.trim() || host,
    keyPath,
    certPath,
    caPath,
    requestCert: bool(env.MTLS_REQUEST_CERT, true),
    rejectUnauthorized: bool(env.MTLS_REJECT_UNAUTHORIZED, true),
  };
}

function loadRsfn(env: NodeJS.ProcessEnv, isProduction: boolean): RsfnConfig {
  const raw = env.RSFN_ISPB?.trim();
  const ispb = raw || (isProduction ? '' : '99999999');
  if (ispb && !/^\d{8}$/.test(ispb)) {
    throw new Error('RSFN_ISPB deve ter exatamente 8 dígitos numéricos.');
  }
  const optional = (name: string): string | undefined => env[name]?.trim() || undefined;
  return {
    ispb,
    endpoint: optional('RSFN_ENDPOINT'),
    certPath: optional('RSFN_CERT_PATH'),
    keyPath: optional('RSFN_KEY_PATH'),
    caPath: optional('RSFN_CA_PATH'),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const masterKey = env.XPARTNER_MASTER_KEY ?? '';

  if (isProduction && (masterKey.length < 32 || masterKey.includes('change-me'))) {
    throw new Error('XPARTNER_MASTER_KEY ausente ou fraca. Produção exige segredo de 32+ caracteres vindo do KMS.');
  }
  if (isProduction && bool(env.DEMO_MODE, false)) {
    throw new Error('DEMO_MODE não pode ser habilitado em produção.');
  }

  const fiscalAmbiente = env.FISCAL_AMBIENTE === 'producao' ? 'producao' : 'homologacao';
  const host = env.HOST ?? '0.0.0.0';

  return {
    env: nodeEnv,
    isProduction,
    port: int(env.PORT, 8080, 1, 65535),
    host,
    dbPath: env.DB_PATH ?? path.join('.data', 'xpartner.db'),
    demoMode: bool(env.DEMO_MODE, !isProduction),
    seedDemo: bool(env.SEED_DEMO, false),
    masterKey: masterKey || 'dev-master-key-change-me-please-32-chars',
    tokenTtlSeconds: int(env.TOKEN_TTL_SECONDS, 7200, 60, 86400),
    hmacWindowSeconds: int(env.HMAC_WINDOW_SECONDS, 300, 30, 900),
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 240, 10, 100_000),
    settlementIntervalMs: int(env.SETTLEMENT_INTERVAL_MS, 5000, 500, 300_000),
    subscriptionIntervalMs: int(env.SUBSCRIPTION_INTERVAL_MS, 30_000, 1000, 3_600_000),
    bankSessionTtlSeconds: int(env.BANK_SESSION_TTL_SECONDS, 28_800, 900, 604_800),
    bankBootstrapToken: env.BANK_BOOTSTRAP_TOKEN || undefined,
    mtls: loadMtls(env, host),
    rsfn: loadRsfn(env, isProduction),
    fiscal: {
      uf: (env.FISCAL_UF ?? 'SP').slice(0, 2).toUpperCase(),
      cUF: (env.FISCAL_CUF ?? '35').padStart(2, '0'),
      cMun: (env.FISCAL_CMUN ?? '3550308').padStart(7, '0'),
      ambiente: fiscalAmbiente,
      serie: int(env.FISCAL_SERIES, 1, 1, 999),
      rejectionPct: int(env.FISCAL_REJECTION_PCT, 6, 0, 100),
      latencyMs: int(env.FISCAL_LATENCY_MS, 450, 0, 10_000),
      companyName: env.FISCAL_COMPANY_NAME ?? 'XPARTNER TECNOLOGIA LTDA',
    },
    fiscalPrivateKeyPem: env.FISCAL_PRIVATE_KEY_PEM || undefined,
  };
}
