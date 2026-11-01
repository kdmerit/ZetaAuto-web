/** Public current risk limits, never private account data or historical-exchange LIQ claims. */
import { readValue, writeValue } from './database';
import { publicRequest } from './marketData';
import type { BacktestSide, ContractRisk } from './types';

export const liquidationBuffer = 0.003;
export const takerFee = 0.00055;
export class UnsupportedContractRisk extends Error {}

export function validContractRisk(value: unknown, symbol: string): value is ContractRisk {
  if (!value || typeof value !== 'object') return false;
  const risk = value as ContractRisk;
  return risk.symbol === symbol && risk.model === 'ISOLATED_ESTIMATE_V1' && Number.isFinite(risk.checkedAt)
    && Number.isInteger(risk.maxLeverage) && risk.maxLeverage >= 1 && risk.maxLeverage <= 1000
    && Array.isArray(risk.tiers) && risk.tiers.length > 0 && risk.tiers.length <= 1000
    && risk.tiers.every((tier, index) => Number.isFinite(tier.limit) && tier.limit > 0
      && (!index || tier.limit > risk.tiers[index - 1]!.limit)
      && Number.isFinite(tier.maintenanceRate) && tier.maintenanceRate >= 0 && tier.maintenanceRate < 0.5
      && Number.isFinite(tier.deduction) && tier.deduction >= 0
      && Number.isFinite(tier.maxLeverage) && tier.maxLeverage >= 1);
}

export async function loadContractRisk(symbol: string, signal?: AbortSignal): Promise<ContractRisk> {
  const key = `contract-risk:v1:${symbol}`;
  const cached = await readValue<unknown>('publicData', key);
  if (validContractRisk(cached, symbol) && Date.now() - cached.checkedAt < 86400_000 && cached.checkedAt <= Date.now()) return cached;
  const instrument = await publicRequest<{ list: { symbol: string; leverageFilter?: { maxLeverage?: string } }[] }>('instruments-info', { symbol }, signal);
  const maximum = Number(instrument.list.find(item => item.symbol === symbol)?.leverageFilter?.maxLeverage);
  if (!Number.isFinite(maximum) || maximum < 1 || maximum > 1000) throw new UnsupportedContractRisk(`${symbol}의 최대 레버리지를 확인하지 못했습니다.`);
  const tiers: ContractRisk['tiers'] = [];
  let cursor = '';
  for (let page = 0; page < 100; page += 1) {
    const result = await publicRequest<{ list: { symbol: string; riskLimitValue: string; initialMargin: string | number; maintenanceMargin: string | number; mmDeduction: string; maxLeverage: string; isLowestRisk?: number }[]; nextPageCursor?: string }>('risk-limit', { symbol, ...(cursor ? { cursor } : {}) }, signal);
    for (const item of result.list ?? []) if (item.symbol === symbol) {
      const maximumLeverage = Number(item.maxLeverage); const initial = Number(item.initialMargin) * maximumLeverage;
      const units = Math.abs(initial - 1) < 0.01 ? 1 : Math.abs(initial - 100) < 1 ? 100 : NaN;
      const deduction = item.mmDeduction === '' ? item.isLowestRisk === 1 ? 0 : NaN : Number(item.mmDeduction);
      tiers.push({ limit: Number(item.riskLimitValue), maintenanceRate: Number(item.maintenanceMargin) / units, deduction, maxLeverage: maximumLeverage });
    }
    if (!result.nextPageCursor) { cursor = ''; break; }
    if (result.nextPageCursor === cursor) throw new Error('위험한도 페이지 조회가 진행되지 않았습니다.');
    cursor = result.nextPageCursor;
  }
  const risk: ContractRisk = { symbol, checkedAt: Date.now(), maxLeverage: Math.floor(maximum), model: 'ISOLATED_ESTIMATE_V1',
    tiers: [...new Map(tiers.map(tier => [tier.limit, tier])).values()].sort((a, b) => a.limit - b.limit) };
  if (cursor || !validContractRisk(risk, symbol)) throw new UnsupportedContractRisk(`${symbol}의 유지증거금·위험한도 자료가 부족합니다. 임의의 LIQ로 계산하지 않습니다.`);
  await writeValue('publicData', key, risk); return risk;
}

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

export function safeLeverageLimit(risk: ContractRisk, bet: number, deviation: number, side: BacktestSide): number {
  let safe = 0;
  for (let leverage = 1; leverage <= risk.maxLeverage; leverage += 1) {
    const tier = risk.tiers.find(value => value.limit + 1e-8 >= bet * leverage);
    if (!tier || leverage > tier.maxLeverage + 1e-10) break;
    try {
      const long = side === 'SHORT' ? null : estimatedLiquidation('LONG', 1, bet * leverage, bet, risk);
      const short = side === 'LONG' ? null : estimatedLiquidation('SHORT', 1, bet * leverage, bet, risk);
      if (long !== null && long > (1 - deviation / 100) * (1 - liquidationBuffer) + 1e-12) break;
      if (short !== null && short < (1 + deviation / 100) * (1 + liquidationBuffer) - 1e-12) break;
    } catch { break; }
    safe = leverage;
  }
  return safe;
}
