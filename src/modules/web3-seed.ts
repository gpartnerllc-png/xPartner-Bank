import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { log } from '../kernel/logger.ts';
import { sha256Hex } from '../kernel/crypto.ts';
import type { Web3Hub } from './web3.ts';
import { DEMO_MERCHANT_ID } from './seed.ts';

/**
 * Popula o stack Web3 na demonstração: appchain registrada, feeds de oráculo com preço,
 * oferta DVP aberta, atestação de predicado verificada com nullifier e orçamento de paymaster.
 * Idempotente: só executa quando ainda não existe rede registrada.
 */
export function seedWeb3(db: Db, hub: Web3Hub, config: AppConfig): void {
  if (!config.demoMode || !config.seedDemo) return;
  const existing = db.prepare('SELECT COUNT(*) AS count FROM web3_networks').get() as { count: number };
  if (existing.count > 0) return;

  try {
    const { network } = hub.registerNetwork({
      name: 'xPartner AppChain — Consórcio',
      chainId: 771_001,
      kind: 'APPCHAIN',
      rpcUrl: 'https://rpc.appchain.xpartner.demo',
      explorerUrl: 'https://explorer.appchain.xpartner.demo',
      nativeSymbol: 'BRLT',
      bridgeContract: '0x1000000000000000000000000000000000000001',
      tokenContract: '0x1000000000000000000000000000000000000002',
      dvpContract: '0x1000000000000000000000000000000000000003',
      paymasterContract: '0x1000000000000000000000000000000000000004',
      finalitySeconds: 2,
      governance: 'XPARTNER_COUNCIL',
    });

    hub.registerNetwork({
      name: 'Subnet Agro — Cerrado',
      chainId: 771_002,
      kind: 'SUBNET',
      rpcUrl: 'https://rpc.agro.xpartner.demo',
      nativeSymbol: 'AGROT',
      bridgeContract: '0x1000000000000000000000000000000000000011',
      finalitySeconds: 4,
      governance: 'AGRO_COMMITTEE',
    });

    hub.registerFeed({ symbol: 'SOJA', source: 'CHAINLINK', decimals: 2, maxAgeSeconds: 86_400 });
    hub.publishPrice({ symbol: 'SOJA', priceUnits: 13_500 });
    hub.registerFeed({ symbol: 'BOI', source: 'BAND', decimals: 2, maxAgeSeconds: 86_400 });
    hub.publishPrice({ symbol: 'BOI', priceUnits: 32_000 });

    hub.createOffer({
      networkId: network.id,
      makerId: DEMO_MERCHANT_ID,
      kind: 'CASH_FOR_TOKEN',
      sellSymbol: 'NFCR',
      sellUnits: 100,
      cashCents: 95_000,
      feeBps: 50,
      expiresInSeconds: 7 * 86_400,
    });

    const commitment = sha256Hex('xpartner:demo:commitment:v1:seed');
    const attestation = hub.attestClaim({
      commitment,
      claimType: 'FATURAMENTO_PJ',
      predicate: 'GTE',
      threshold: 50_000_000,
      issuer: 'compliance@xpartner.demo',
      expiresInSeconds: 90 * 86_400,
    });
    hub.verifyClaim({
      attestationId: attestation.attestation.id,
      purpose: 'demo-onboarding',
      relyingParty: DEMO_MERCHANT_ID,
    });

    hub.createPaymasterBudget({
      merchantId: DEMO_MERCHANT_ID,
      networkId: network.id,
      label: 'Gas patrocinado — tesouraria demo',
      capCents: 50_000,
      perOpMaxCents: 5_000,
    });

    log.info('seed.web3', { merchantId: DEMO_MERCHANT_ID, chainId: 771_001 });
  } catch (error) {
    log.error('seed.web3_failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
