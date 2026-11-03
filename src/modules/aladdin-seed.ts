import type { AppConfig } from '../config.ts';
import { log } from '../kernel/logger.ts';
import type { AladdinEngine } from './aladdin.ts';
import type { CrossChainHub } from './crosschain.ts';
import { DEMO_MERCHANT_ID } from './seed.ts';

/**
 * Semeia o motor Aladdin e uma lane CCIP com liquidez P2P na demonstração.
 * Não gera prova Groth16 no boot (caro por design); a prova é criada sob demanda.
 */
export function seedAladdin(aladdin: AladdinEngine, crosschain: CrossChainHub, config: AppConfig): void {
  if (!config.demoMode || !config.seedDemo) return;
  if (crosschain.listLanes().length > 0) return;
  try {
    aladdin.simulateRisk({
      merchantId: DEMO_MERCHANT_ID,
      volatilityBps: 180,
      driftBps: 6,
      samples: 2_000,
      confidenceBps: 9_900,
      ttlSeconds: 86_400,
      hasCollateral: true,
      onTimeRatioBps: 9_200,
    });
    const { lane } = crosschain.registerLane({
      name: 'Consórcio → Subnet Agro',
      sourceChainId: 771_001,
      destChainId: 771_002,
      sourceSelector: '7710010000000000001',
      destSelector: '7710020000000000002',
      router: '0x1000000000000000000000000000000000000005',
      receiver: '0x1000000000000000000000000000000000000006',
      feeBps: 20,
      maxUnits: 10_000,
    });
    crosschain.registerLiquidity({
      merchantId: DEMO_MERCHANT_ID,
      laneId: lane.id,
      symbol: 'NFCR',
      availableUnits: 1_000,
      rateBps: 25,
      riskTier: 'A',
    });
    log.info('seed.aladdin', { merchantId: DEMO_MERCHANT_ID, laneId: lane.id });
  } catch (error) {
    log.error('seed.aladdin_failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
