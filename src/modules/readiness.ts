import { existsSync } from 'node:fs';
import type { AppConfig } from '../config.ts';

export type ReadinessStatus = 'READY' | 'PARTIAL' | 'MISSING' | 'MANUAL';

export interface ReadinessItem {
  id: string;
  area: 'core' | 'seguranca' | 'pagamentos' | 'fiscal' | 'open-finance' | 'edge' | 'conformidade';
  label: string;
  status: ReadinessStatus;
  detail: string;
  needs: string[];
}

export interface ReadinessReport {
  generatedAt: string;
  environment: string;
  demoMode: boolean;
  readyForProduction: boolean;
  progressPct: number;
  summary: Record<ReadinessStatus, number>;
  items: ReadinessItem[];
  blockers: string[];
}

const present = (env: NodeJS.ProcessEnv, names: string[]): boolean => names.every((name) => Boolean(env[name]?.trim()));

export function buildReadiness(config: AppConfig, env: NodeJS.ProcessEnv = process.env): ReadinessReport {
  const items: ReadinessItem[] = [];

  const runtimeReady =
    config.isProduction &&
    !config.demoMode &&
    !config.seedDemo &&
    config.masterKey.length >= 32 &&
    !config.masterKey.includes('change-me');
  items.push({
    id: 'core.runtime',
    area: 'core',
    label: 'Configuração de execução',
    status: runtimeReady ? 'READY' : 'PARTIAL',
    detail: `ambiente=${config.env}, demo=${config.demoMode}, seed=${config.seedDemo}`,
    needs: runtimeReady
      ? []
      : ['NODE_ENV=production', 'DEMO_MODE=false', 'SEED_DEMO=false', 'XPARTNER_MASTER_KEY com 32+ caracteres vindo de KMS'],
  });

  items.push({
    id: 'core.ledger',
    area: 'core',
    label: 'Ledger de dupla entrada e transferências internas',
    status: 'READY',
    detail: 'Partidas dobradas em centavos, idempotência, comprovante com hash e extrato contábil.',
    needs: [],
  });

  items.push({
    id: 'core.data',
    area: 'core',
    label: 'Persistência e mensageria de produção',
    status: 'PARTIAL',
    detail: 'SQLite WAL em processo com outbox transacional; schema PostgreSQL de referência disponível.',
    needs: [
      'Migrar o ledger para PostgreSQL/Aurora com réplica',
      'Kafka ou Redpanda para eventos com partição por estabelecimento',
      'Backup PITR e restore testado',
    ],
  });

  items.push({
    id: 'seguranca.sessoes',
    area: 'seguranca',
    label: 'Sessões, senhas e antifraude de conta',
    status: 'READY',
    detail: 'scrypt, cookie HttpOnly SameSite=Strict, CSRF exato, bloqueio por tentativas, auditoria e aprovação de cadastro.',
    needs: [],
  });

  const mtlsConfigured = Boolean(config.mtls);
  const mtlsFiles = config.mtls
    ? [config.mtls.keyPath, config.mtls.certPath, config.mtls.caPath].every((file) => existsSync(file))
    : false;
  items.push({
    id: 'seguranca.mtls',
    area: 'seguranca',
    label: 'Checkout mTLS por certificado de terminal',
    status: mtlsConfigured && mtlsFiles ? (config.isProduction ? 'PARTIAL' : 'READY') : 'PARTIAL',
    detail: mtlsConfigured
      ? mtlsFiles
        ? 'Listener HTTPS ativo, CN = serial do terminal e fingerprint fixado.'
        : 'Configurado, mas algum arquivo PEM não foi encontrado.'
      : 'Listener mTLS não configurado neste processo.',
    needs:
      mtlsConfigured && mtlsFiles
        ? ['Emissão e guarda das chaves em HSM/KMS', 'CRL/OCSP e rotação de certificados']
        : ['MTLS_KEY_PATH, MTLS_CERT_PATH e MTLS_CA_PATH', 'CA corporativa para terminais', 'CRL/OCSP'],
  });

  const acquirerReady = present(env, ['ACQUIRER_PROVIDER', 'ACQUIRER_BASE_URL', 'ACQUIRER_CLIENT_ID', 'ACQUIRER_CLIENT_SECRET']);
  items.push({
    id: 'pagamentos.adquirencia',
    area: 'pagamentos',
    label: 'Autorização de cartões em adquirente real',
    status: acquirerReady ? 'PARTIAL' : 'MISSING',
    detail: 'Hoje roda o simulador ISO 8583 determinístico; o seam de autorização/roteamento já existe.',
    needs: [
      'Contrato de adquirência (Cielo, Rede, Stone, Getnet ou Sub)',
      'Credenciais, certificado e endpoint do adquirente',
      'Homologação ISO 8583 ou API e testes de chargeback',
      'Certificação PCI DSS para captura e tokenização',
    ],
  });

  const pixReady = present(env, ['PIX_PSP_PROVIDER', 'PIX_PSP_CLIENT_ID', 'PIX_PSP_CLIENT_SECRET', 'PIX_WEBHOOK_SECRET']);
  items.push({
    id: 'pagamentos.pix',
    area: 'pagamentos',
    label: 'Pix real (PSP/SPI)',
    status: pixReady ? 'PARTIAL' : 'MISSING',
    detail: 'BR Code EMV, cobrança e liquidação D+0 funcionam no ciclo interno; sem conexão ao SPI.',
    needs: [
      'Conta em PSP participante ou participação direta no SPI',
      'Credenciais mTLS/RSFN e certificado ICP-Brasil',
      'DICT para chaves e webhook assinado do PSP',
      'Conciliação e tratamento de devoluções (MED)',
    ],
  });

  const rsfnCredentials = present(env, ['RSFN_CERT_PATH', 'RSFN_KEY_PATH', 'RSFN_CA_PATH', 'RSFN_ENDPOINT']);
  const rsfnIspb = Boolean(config.rsfn.ispb);
  items.push({
    id: 'pagamentos.rsfn',
    area: 'pagamentos',
    label: 'Canal RSFN / PAG0004',
    status: rsfnIspb ? 'PARTIAL' : 'MISSING',
    detail: rsfnIspb
      ? `ISPB ${config.rsfn.ispb} configurado; XML PAG0004, validação, contabilização e ciclo de aceite/estorno ativos.`
      : 'Sem RSFN_ISPB: o envio interbancário fica desabilitado e o XML não é emitido.',
    needs: [
      'ISPB de participante direto ou indireto da RSFN',
      'Certificado ICP-Brasil com chaves em HSM/KMS',
      'Conector mTLS homologado pelo BCB (o ciclo interno já existe)',
      rsfnCredentials ? 'Homologação e conciliação do PAG0004 com a RSFN' : 'RSFN_ENDPOINT, RSFN_CERT_PATH, RSFN_KEY_PATH e RSFN_CA_PATH',
    ],
  });

  const sefazReady = present(env, ['FISCAL_CERT_PATH', 'FISCAL_CERT_PASSWORD', 'FISCAL_CSC', 'FISCAL_CSC_ID']);  items.push({
    id: 'fiscal.sefaz',
    area: 'fiscal',
    label: 'NFC-e autorizada pela SEFAZ',
    status: sefazReady ? 'PARTIAL' : 'MISSING',
    detail: `Mock determinístico com contingência (${config.fiscal.ambiente}); XML, assinatura e QR já implementados.`,
    needs: [
      'Certificado A1/A3 da empresa',
      'CSC e ID do token SEFAZ',
      'Habilitação do contribuinte e homologação estadual',
      'Rotina de contingência, inutilização e conciliação',
    ],
  });

  const openFinanceReady = present(env, ['OPEN_FINANCE_CLIENT_ID', 'OPEN_FINANCE_CERT_PATH', 'OPEN_FINANCE_DIRECTORY_URL']);
  items.push({
    id: 'open-finance',
    area: 'open-finance',
    label: 'Open Finance regulado',
    status: openFinanceReady ? 'PARTIAL' : 'MISSING',
    detail: 'Consentimentos, contas mascaradas, débito externo e ITP existem no ciclo interno.',
    needs: [
      'Adesão ao Open Finance Brasil e certificação FAPI',
      'Participação no diretório de instituições',
      'Contrato com detentora/receptora e DICT/SPI',
      'Homologação de consentimento, revogação e conciliação',
    ],
  });

  const edgeReady = present(env, ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
  items.push({
    id: 'edge.cloudflare',
    area: 'edge',
    label: 'Edge Cloudflare publicado',
    status: edgeReady ? 'PARTIAL' : 'MANUAL',
    detail: 'Worker, D1, KV, R2, Queues e IA estão prontos no repositório, mas não publicados.',
    needs: [
      'IDs reais de D1, KV e R2 no wrangler.jsonc',
      'wrangler secret put para JWT e segredos',
      'Domínio, WAF e política de rate limit',
    ],
  });

  items.push({
    id: 'conformidade.licenca',
    area: 'conformidade',
    label: 'Licença e conformidade para operar',
    status: 'MANUAL',
    detail: 'Referência de engenharia. Não é instituição financeira licenciada e não movimenta dinheiro real.',
    needs: [
      'Autorização do BCB como IP/SCD ou parceria com banco/BaaS licenciado',
      'KYC/KYB e PLD/FT com fornecedor aprovado',
      'PCI DSS, LGPD/DPO e contratos de consentimento',
      'Auditoria independente, capital mínimo e plano de continuidade',
    ],
  });

  const summary: Record<ReadinessStatus, number> = { READY: 0, PARTIAL: 0, MISSING: 0, MANUAL: 0 };
  let score = 0;
  for (const item of items) {
    summary[item.status] += 1;
    if (item.status === 'READY') score += 1;
    else if (item.status === 'PARTIAL') score += 0.5;
  }

  const blockers = items
    .filter((item) => item.status === 'MISSING' || item.status === 'MANUAL')
    .flatMap((item) => item.needs.map((need) => `${item.label}: ${need}`));

  return {
    generatedAt: new Date().toISOString(),
    environment: config.env,
    demoMode: config.demoMode,
    readyForProduction: items.every((item) => item.status === 'READY'),
    progressPct: Math.round((score / items.length) * 100),
    summary,
    items,
    blockers,
  };
}
