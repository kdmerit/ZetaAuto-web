import { describe, expect, it } from 'vitest';
import { prepareSymbolBlock } from './engine';
import { bestEnvelopeLeverage } from './envelopeLeverage';
import { safeLeverageLimit, estimatedLiquidation } from './contractRisk';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestResult, BacktestSettings, Candle, ContractRisk, EnvelopeExitMode } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const risk: ContractRisk = { symbol: 'BTCUSDT', checkedAt: Date.now(), maxLeverage: 20, model: 'ISOLATED_ESTIMATE_V1',
  tiers: [{ limit: 1000000, maintenanceRate: 0.005, deduction: 0, maxLeverage: 20 }] };
const settings: BacktestSettings = { mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'LONG', startDate: '2026-01-01', startTime: '09:00', endDate: '2026-03-01', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false,
  roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeMaPeriod: '20', envelopeDeviationPercent: '1.0', envelopeExitMode: 'CENTER' };
function document(short: boolean, tail?: number[][]) {
  const prices = tail ?? Array.from({ length: 16 }, (_, i) => i % 2 ? [99.5, 101.5, 99.3, 101] : [99.5, 99.8, 98.5, 99]);
  const rows: Candle[] = [...Array.from({ length: 120 }, () => [100, 100, 100, 100]), ...prices].map((p, i) => {
    const v = short ? [200 - p[0]!, 200 - p[2]!, 200 - p[1]!, 200 - p[3]!] : p;
    return { openTime: origin + i * 3600, closeTime: origin + (i + 1) * 3600, open: v[0]!, high: v[1]!, low: v[2]!, close: v[3]!, volume: 10 };
  });
  return rows;
}

async function verifyEveryLeverage(rows: Candle[], parameters: BacktestSettings) {
  const start = rows[120]!.openTime; const end = rows.at(-1)!.closeTime;
  const prepared = prepareSymbolBlock('BTCUSDT', rows, parameters, 'ENVELOPE', start, end);
  let best: { leverage: number; result: BacktestResult } | null = null;
  for (let leverage = 1; leverage <= safeLeverageLimit(risk, Number(parameters.betAmountUsdt), Number(parameters.envelopeDeviationPercent), parameters.side); leverage += 1) {
    const p = { ...parameters, leverage: String(leverage), envelopeRisk: risk }; const state = initialPortfolio(Number(p.initialCapitalUsdt));
    replayPortfolioBlock(state, [prepared], p, start, end, 3600); const result = portfolioResult(state, p);
    if (result.entryCount && (!best || result.finalEquityUsdt > best.result.finalEquityUsdt + 1e-9)) best = { leverage, result };
  }
  expect(best).not.toBeNull();
  const optimized = await bestEnvelopeLeverage(prepared, parameters, risk, 3600, new AbortController().signal, async () => {});
  expect(optimized.leverage).toBe(best!.leverage);
  expect(optimized.result.finalEquityUsdt).toBeCloseTo(best!.result.finalEquityUsdt, 7);
  expect(optimized.result.feesUsdt).toBeCloseTo(best!.result.feesUsdt, 7);
  expect(optimized.result.exitReasons).toEqual(best!.result.exitReasons);
  return optimized;
}
describe('leverage optimization and isolated LIQ safety', () => {
  it('enforces both SL-relative 0.3% boundaries and the published tier leverage limit', () => {
    const large = { ...risk, maxLeverage: 125, tiers: [{ ...risk.tiers[0]!, maxLeverage: 125 }] };
    for (const side of ['LONG', 'SHORT', 'BOTH'] as const) {
      const limit = safeLeverageLimit(large, 100, 2.3, side); expect(limit).toBeGreaterThan(1); expect(limit).toBeLessThan(125);
      if (side !== 'SHORT') expect(estimatedLiquidation('LONG', 1, 100 * limit, 100, large)!).toBeLessThanOrEqual(0.977 * 0.997 + 1e-12);
      if (side !== 'LONG') expect(estimatedLiquidation('SHORT', 1, 100 * limit, 100, large)!).toBeGreaterThanOrEqual(1.023 * 1.003 - 1e-12);
    }
  });
  it.each([false, true])('matches exhaustive account replays for all three exit modes, short=%s', async short => {
    for (const exit of ['CENTER', 'OPPOSITE', 'HALF'] as EnvelopeExitMode[]) {
      const parameters = { ...settings, side: short ? 'SHORT' as const : 'LONG' as const, envelopeExitMode: exit };
      const rows = document(short); const start = rows[120]!.openTime; const end = rows.at(-1)!.closeTime;
      const prepared = prepareSymbolBlock('BTCUSDT', rows, parameters, 'ENVELOPE', start, end);
      let best = -Infinity; let leverage = 1;
      for (let l = 1; l <= safeLeverageLimit(risk, 100, 1, parameters.side); l += 1) {
        const p = { ...parameters, leverage: String(l), envelopeRisk: risk }; const state = initialPortfolio(1000);
        replayPortfolioBlock(state, [prepared], p, start, end, 3600); const result = portfolioResult(state, p);
        if (result.entryCount && result.finalEquityUsdt > best + 1e-9) { best = result.finalEquityUsdt; leverage = l; }
      }
      const optimized = await bestEnvelopeLeverage(prepared, parameters, risk, 3600, new AbortController().signal, async () => {});
      expect(optimized.leverage).toBe(leverage); expect(optimized.result.finalEquityUsdt).toBeCloseTo(best, 7);
    }
  });
  it('handles an opening gap beyond LIQ with isolated collateral loss and still matches the exhaustive engine', async () => {
    const rows = document(false, [[99.5, 99.8, 98.5, 99], [80, 81, 79, 80], [99.5, 101.5, 98.5, 101]]);
    const start = rows[120]!.openTime; const end = rows.at(-1)!.closeTime;
    const prepared = prepareSymbolBlock('BTCUSDT', rows, settings, 'ENVELOPE', start, end);
    const p = { ...settings, leverage: '20', envelopeRisk: risk }; const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [prepared], p, start, end, 3600);
    expect(state.exitReasons.LIQ).toBe(1); expect(state.cash).toBeGreaterThan(700);
    const optimized = await bestEnvelopeLeverage(prepared, settings, risk, 3600, new AbortController().signal, async () => {});
    expect(Number.isFinite(optimized.result.returnPercent)).toBe(true);
  });
  it('values a still-open half position at the final candle without overwriting its mark with a partial fill', async () => {
    const rows = document(false, [[99.5, 99.8, 98.5, 99], [99, 100.3, 98.8, 99.8], [99.8, 100, 99, 99.6]]);
    const result = await verifyEveryLeverage(rows, { ...settings, envelopeExitMode: 'HALF' });
    expect(result.result.openPositionCount).toBe(1);
    expect(result.result.exitReasons.PARTIAL_TP).toBe(1);
  });
  it.each([false, true])('matches exhaustive cash flows for a partial fill followed by a liquidation gap, short=%s', async short => {
    const rows = document(short, [[99.5, 99.8, 98.5, 99], [99, 100.3, 98.8, 99.8], [80, 81, 79, 80], [99.5, 101.5, 98.5, 101]]);
    await verifyEveryLeverage(rows, { ...settings, side: short ? 'SHORT' : 'LONG', envelopeExitMode: 'HALF' });
  });
  it('does not choose zero-entry high leverage when cash can fund only 1x', async () => {
    const result = await verifyEveryLeverage(document(false), { ...settings, initialCapitalUsdt: '100.06' });
    expect(result.leverage).toBe(1); expect(result.result.entryCount).toBeGreaterThan(0);
  });
  it('compares both-direction ambiguous band touches against every exact replay', async () => {
    await verifyEveryLeverage(document(false, Array.from({ length: 16 }, (_, i) => i % 2 ? [99.5, 101.5, 98.5, 101] : [100.5, 101.5, 98.5, 99])), { ...settings, side: 'BOTH', envelopeExitMode: 'HALF' });
  });
});
