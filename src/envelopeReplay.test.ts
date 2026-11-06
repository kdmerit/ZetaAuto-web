import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareSymbolBlock } from './engine';
import { fixedEnvelopeSettings, replayFixedEnvelope } from './envelopeReplay';
import { currentEnvelopeSettings } from './envelope';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle, ContractRisk } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const settings: BacktestSettings = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'LONG', startDate: '2026-01-01', startTime: '09:00', endDate: '2026-03-01', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '5', partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false,
  roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeMaPeriod: '20', envelopeDeviationPercent: '1.0' });
function candles(short = false): Candle[] {
  const tail = [[100, 101.5, 99.5, 100], [99.5, 100.4, 99.5, 99.8], [100, 101.2, 99.8, 101]];
  return [...Array.from({ length: 20 }, (_, index) => ({ openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600, open: 100, high: 100, low: 100, close: 100, volume: 10 })), ...tail.map((p, index) => {
    const v = short ? [200 - p[0]!, 200 - p[2]!, 200 - p[1]!, 200 - p[3]!] : p;
    return { openTime: origin + (index + 20) * 3600, closeTime: origin + (index + 21) * 3600, open: v[0]!, high: v[1]!, low: v[2]!, close: v[3]!, volume: 10 };
  })];
}
afterEach(() => vi.unstubAllGlobals());

describe('fixed-leverage envelope account replay', () => {
  it('matches ordinary replay without any risk-data request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('fixed replay must not fetch risk'); }));
    const rows = candles(); const start = rows[20]!.openTime; const end = rows.at(-1)!.closeTime;
    const prepared = prepareSymbolBlock('BTCUSDT', rows, settings, 'ENVELOPE', start, end);
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [prepared], settings, start, end, 3600);
    const result = await replayFixedEnvelope(prepared, { ...settings, envelopeRisk: { symbol: 'BTCUSDT', checkedAt: Date.now(), maxLeverage: 1, model: 'ISOLATED_ESTIMATE_V1', tiers: [{ limit: 1000000, maintenanceRate: .005, deduction: 0, maxLeverage: 1 }] } as ContractRisk }, 3600, new AbortController().signal, async () => {});
    expect(result).toEqual(portfolioResult(state, settings)); expect(result.entryCount).toBe(1); expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the entered decimal leverage and strips only the old risk snapshot', () => {
    const risk = { symbol: 'BTCUSDT', checkedAt: Date.now(), maxLeverage: 1, model: 'ISOLATED_ESTIMATE_V1' as const, tiers: [] };
    const input = { ...settings, leverage: '5.25', envelopeRisk: risk };
    expect(fixedEnvelopeSettings(input)).toEqual({ ...input, envelopeRisk: undefined }); expect(input.envelopeRisk).toBe(risk);
  });
  it.each(['0', '101', 'abc', '1.234', ''])('rejects invalid fixed leverage %s', leverage => {
    expect(() => fixedEnvelopeSettings({ ...settings, leverage })).toThrow('고정 레버리지');
  });
});
