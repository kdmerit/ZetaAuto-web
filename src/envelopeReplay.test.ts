import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareSymbolBlock } from './engine';
import { fixedEnvelopeSettings, replayFixedEnvelope } from './envelopeReplay';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle, ContractRisk, EnvelopeExitMode } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const risk: ContractRisk = { symbol: 'BTCUSDT', checkedAt: Date.now(), maxLeverage: 1, model: 'ISOLATED_ESTIMATE_V1',
  tiers: [{ limit: 1000000, maintenanceRate: 0.005, deduction: 0, maxLeverage: 1 }] };
const settings: BacktestSettings = { mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'LONG', startDate: '2026-01-01', startTime: '09:00', endDate: '2026-03-01', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '5', partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false,
  roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeMaPeriod: '20', envelopeDeviationPercent: '1.0', envelopeExitMode: 'CENTER' };
function candles(short: boolean, tail?: number[][]): Candle[] {
  const prices = tail ?? Array.from({ length: 16 }, (_, i) => i % 2 ? [99.5, 101.5, 99.3, 101] : [99.5, 99.8, 98.5, 99]);
  return [...Array.from({ length: 120 }, () => [100, 100, 100, 100]), ...prices].map((p, i) => {
    const v = short ? [200 - p[0]!, 200 - p[2]!, 200 - p[1]!, 200 - p[3]!] : p;
    return { openTime: origin + i * 3600, closeTime: origin + (i + 1) * 3600, open: v[0]!, high: v[1]!, low: v[2]!, close: v[3]!, volume: 10 };
  });
}
afterEach(() => vi.unstubAllGlobals());
describe('fixed-leverage envelope account replay', () => {
  it.each([false, true])('matches the ordinary 5x account for every exit mode without querying leverage or risk, short=%s', async short => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('fixed replay must not fetch risk'); }));
    for (const exit of ['CENTER', 'OPPOSITE', 'HALF'] as EnvelopeExitMode[]) {
      const p = { ...settings, side: short ? 'SHORT' as const : 'LONG' as const, envelopeExitMode: exit };
      const rows = candles(short); const start = rows[120]!.openTime; const end = rows.at(-1)!.closeTime;
      const prepared = prepareSymbolBlock('BTCUSDT', rows, p, 'ENVELOPE', start, end);
      const state = initialPortfolio(1000); replayPortfolioBlock(state, [prepared], p, start, end, 3600);
      const result = await replayFixedEnvelope(prepared, { ...p, envelopeRisk: risk }, 3600, new AbortController().signal, async () => {});
      expect(result).toEqual(portfolioResult(state, p)); expect(fetch).not.toHaveBeenCalled();
      expect(result.entryCount).toBeGreaterThan(0);
    }
  });
  it('preserves user leverage including decimals and strips only the risk snapshot from a copy', () => {
    const input = { ...settings, leverage: '5.25', envelopeRisk: risk };
    expect(fixedEnvelopeSettings(input)).toEqual({ ...input, envelopeRisk: undefined });
    expect(input.envelopeRisk).toBe(risk); expect(fixedEnvelopeSettings(input).leverage).toBe('5.25');
  });
  it.each(['0', '101', 'abc', '1.234', ''])('rejects invalid fixed leverage %s', leverage => {
    expect(() => fixedEnvelopeSettings({ ...settings, leverage })).toThrow('고정 레버리지');
  });
  it('keeps archived isolated-risk replay available while fixed statistics ignore that snapshot', async () => {
    const rows = candles(false, [[99.5, 99.8, 98.5, 99], [80, 81, 79, 80]]);
    const start = rows[120]!.openTime; const end = rows.at(-1)!.closeTime;
    const p = { ...settings, leverage: '20', envelopeRisk: risk };
    const prepared = prepareSymbolBlock('BTCUSDT', rows, p, 'ENVELOPE', start, end);
    const legacy = initialPortfolio(1000); replayPortfolioBlock(legacy, [prepared], p, start, end, 3600);
    expect(legacy.exitReasons.LIQ).toBe(1);
    const fixed = await replayFixedEnvelope(prepared, p, 3600, new AbortController().signal, async () => {});
    expect(fixed.exitReasons.LIQ).toBeUndefined(); expect(fixed.exitReasons.SL).toBe(1);
  });
});
