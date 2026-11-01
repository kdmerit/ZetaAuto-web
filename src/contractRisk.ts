/** Legacy saved-risk replay only. New statistics never fetch or optimize contract risk. */
import type { ContractRisk } from './types';

export const takerFee = 0.00055;
export class UnsupportedContractRisk extends Error {}

/** Solve isolated margin + unrealized P&L = maintenance + close-fee reserve. */
export function estimatedLiquidation(side: 'LONG' | 'SHORT', entry: number, quantity: number, margin: number, risk: ContractRisk): number | null {
  const notional = entry * quantity;
  let tierIndex = risk.tiers.findIndex(tier => tier.limit + 1e-8 >= notional);
  if (tierIndex < 0 || quantity <= 0 || margin <= 0) throw new UnsupportedContractRisk('포지션 금액이 공개 위험한도 범위를 초과합니다.');
  while (tierIndex < risk.tiers.length) {
    const tier = risk.tiers[tierIndex]!;
    const rate = tier.maintenanceRate + takerFee;
    const price = side === 'LONG' ? (notional - margin - tier.deduction) / (quantity * (1 - rate))
      : (notional + margin + tier.deduction) / (quantity * (1 + rate));
    if (side === 'LONG' && price <= 0) return null;
    if (!Number.isFinite(price) || price <= 0) throw new UnsupportedContractRisk('예상 LIQ 계산에 필요한 값이 올바르지 않습니다.');
    if (price * quantity <= tier.limit + 1e-8) return price;
    tierIndex += 1;
  }
  throw new UnsupportedContractRisk('예상 LIQ의 포지션 금액이 공개 위험한도를 초과합니다.');
}
