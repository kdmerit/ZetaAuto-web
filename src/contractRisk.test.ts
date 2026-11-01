import { describe, expect, it } from 'vitest';
import { estimatedLiquidation } from './contractRisk';
import type { ContractRisk } from './types';

const risk: ContractRisk = { symbol: 'BTCUSDT', checkedAt: 1, maxLeverage: 100, model: 'ISOLATED_ESTIMATE_V1',
  tiers: [{ limit: 1000000, maintenanceRate: 0.005, deduction: 0, maxLeverage: 100 }] };
describe('archived isolated-risk snapshots, without public API loading', () => {
  it('preserves the stored long/short liquidation formulas', () => {
    expect(estimatedLiquidation('LONG', 100, 10, 100, risk)).toBeCloseTo(900 / (10 * 0.99445), 10);
    expect(estimatedLiquidation('SHORT', 100, 10, 100, risk)).toBeCloseTo(1100 / (10 * 1.00555), 10);
  });
  it('has no positive long liquidation price at fully funded 1x', () => {
    expect(estimatedLiquidation('LONG', 100, 1, 100, risk)).toBeNull();
  });
  it('rejects an archived position outside its saved risk tiers', () => {
    expect(() => estimatedLiquidation('LONG', 100, 10001, 100, risk)).toThrow('위험한도');
  });
});
