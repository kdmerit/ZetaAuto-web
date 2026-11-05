import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultMarketIndicators, enrichMarketCandles, loadMarketIndicators, marketIndicatorParameters, marketIndicatorStorageKey, saveMarketIndicators, trueRange, volumeWindowSeconds, withMarketIndicators } from './marketIndicators';
import type { Candle, ChartData } from './types';

const start = Date.UTC(2026, 0, 1) / 1000;
const candle = (index: number, close = 100, volume = 500, seconds = 86400): Candle => ({ openTime: start + index * seconds, closeTime: start + (index + 1) * seconds, open: close, high: close + 2, low: close - 1, close, volume });
function chart(rows: Candle[]): ChartData {
  return { symbol: 'BTCUSDT', interval: '1d', side: null, referenceAt: new Date(rows.at(-1)!.openTime * 1000).toISOString(), referenceIndex: rows.length - 1,
    candles: enrichMarketCandles(rows, '1d'), market: { sourceCandles: rows }, markers: [], executions: [], waves: [], priceLines: [] };
}
afterEach(() => vi.unstubAllGlobals());

describe('TR and prior 120-calendar-day volume readouts', () => {
  it('takes the maximum of wick range, upward gap and downward gap, using the previous close', () => {
    expect(trueRange(candle(0))).toBe(3); expect(trueRange(candle(0), 100)).toBe(3);
    expect(trueRange(candle(0), 90)).toBe(12); expect(trueRange(candle(0), 110)).toBe(11);
    const rows = [candle(0, 90), { ...candle(1, 100), high: 105, low: 95 }];
    const metrics = enrichMarketCandles(rows, '1d')[1]!.marketMetrics!;
    expect(metrics.trueRange).toBe(15); expect(metrics.trueRangePercent).toBe(15);
  });
  it('displays twice/half the prior average as 200%/50%, excluding the selected candle', () => {
    const rows = Array.from({ length: 122 }, (_, index) => candle(index)); rows[0]!.volume = 1e9; rows[121]!.volume = 1000;
    const metrics = enrichMarketCandles(rows, '1d').at(-1)!.marketMetrics!;
    expect(metrics.averageVolume120d).toBe(500); expect(metrics.volumePercent).toBe(200); expect(metrics.volumeSamples).toBe(120);
    rows[121]!.volume = 250; expect(enrichMarketCandles(rows, '1d').at(-1)!.marketMetrics!.volumePercent).toBe(50);
  });
  it('uses 11,520 preceding 15m bars rather than 120 bars, includes the exact 120-day boundary, and ignores older volume', () => {
    const count = volumeWindowSeconds / 900; const rows = Array.from({ length: count + 2 }, (_, i) => candle(i, 100, 500, 900));
    rows[0]!.volume = 1e12; rows.at(-1)!.volume = 1000;
    const metrics = enrichMarketCandles(rows, '15m').at(-1)!.marketMetrics!;
    expect(metrics.volumeSamples).toBe(11520); expect(metrics.expectedVolumeSamples).toBe(11520); expect(metrics.averageVolume120d).toBe(500); expect(metrics.volumePercent).toBe(200);
  });
  it('never reads a later candle and reports limited history/zero mean without inventing a ratio', () => {
    const rows = [candle(0, 100, 0), candle(1, 100, 1000), candle(2, 200, 1e9)];
    const values = enrichMarketCandles(rows, '1d');
    expect(values[0]!.marketMetrics!.averageVolume120d).toBeNull();
    expect(values[1]!.marketMetrics).toMatchObject({ averageVolume120d: 0, volumePercent: null, volumeSamples: 1, expectedVolumeSamples: 120 });
    const prior = values[1]!.marketMetrics; rows[2]!.volume = 1;
    expect(enrichMarketCandles(rows, '1d')[1]!.marketMetrics).toEqual(prior);
  });
});

describe('editable SMA envelope and EMA/Wilder ATR envelope', () => {
  it('draws the selected SMA including the current completed close with symmetric percentage bands', () => {
    const result = withMarketIndicators(chart([candle(0, 100), candle(1, 102)]), { ...defaultMarketIndicators, smaPeriod: '2', deviationPercent: '0.5' });
    expect(result.envelope!.bands).toHaveLength(1);
    expect(result.envelope!.bands[0]!.center).toBe(101); expect(result.envelope!.bands[0]!.upper).toBeCloseTo(101.505, 10); expect(result.envelope!.bands[0]!.lower).toBeCloseTo(100.495, 10);
  });
  it('matches EMA span and TR.ewm(alpha=1/M, adjust=False), seeded with first values rather than an SMA', () => {
    const rows = [candle(0, 100), { ...candle(1, 110), high: 112, low: 109 }, { ...candle(2, 100), high: 101, low: 98 }];
    const result = withMarketIndicators(chart(rows), { ...defaultMarketIndicators, emaPeriod: '2', atrPeriod: '2', atrMultiplier: '2.0' });
    const bands = result.atrEnvelope!.bands;
    expect(bands[0]).toMatchObject({ center: 100, upper: 106, lower: 94 });
    expect(bands[1]!.center).toBeCloseTo(106.6666666667, 8); expect(bands[1]!.upper - bands[1]!.center).toBeCloseTo(15, 10);
    expect(bands[2]!.center).toBeCloseTo(102.2222222222, 8); expect(bands[2]!.upper - bands[2]!.center).toBeCloseTo(19.5, 10);
  });
  it('draws a standard population-deviation Bollinger band from the selected completed closes', () => {
    const result = withMarketIndicators(chart([candle(0, 100), candle(1, 102), candle(2, 104)]), { ...defaultMarketIndicators, bollingerPeriod: '3', bollingerMultiplier: '2.0' });
    const band = result.bollinger!.bands[0]!;
    expect(result.bollinger!.bands).toHaveLength(1);
    expect(band.center).toBe(102); expect(band.upper).toBeCloseTo(105.2659863237, 8); expect(band.lower).toBeCloseTo(98.7340136763, 8);
  });
  it('removes only the indicator containing a zero, preserving the other independent indicator', () => {
    const source = chart([candle(0), candle(1)]); const p = { ...defaultMarketIndicators, smaPeriod: '1', deviationPercent: '1.0' };
    for (const key of ['smaPeriod', 'deviationPercent'] as const) {
      const result = withMarketIndicators(source, { ...p, [key]: '0' }); expect(result.envelope).toBeUndefined(); expect(result.atrEnvelope).toBeDefined();
    }
    for (const key of ['emaPeriod', 'atrPeriod', 'atrMultiplier'] as const) {
      const result = withMarketIndicators(source, { ...p, [key]: '0' }); expect(result.atrEnvelope).toBeUndefined(); expect(result.envelope).toBeDefined();
    }
    for (const key of ['bollingerPeriod', 'bollingerMultiplier'] as const) {
      const result = withMarketIndicators(source, { ...p, [key]: '0' }); expect(result.bollinger).toBeUndefined(); expect(result.envelope).toBeDefined();
    }
  });
  it('is causal, preserves the source, and never retains fake trade metadata in a standalone chart', () => {
    const source = chart([candle(0), candle(1, 110), candle(2, 105)]); source.priceLines = [{ kind: 'ENTRY', price: 777 }]; source.side = 'LONG';
    const before = structuredClone(source); const result = withMarketIndicators(source, defaultMarketIndicators);
    expect(source).toEqual(before); expect(result.priceLines).toEqual([]); expect(result.markers).toEqual([]); expect(result.executions).toEqual([]); expect(result.side).toBeNull();
    source.market!.sourceCandles[2]!.close = 1e8;
    expect(withMarketIndicators(source, defaultMarketIndicators).atrEnvelope!.bands[1]).toEqual(result.atrEnvelope!.bands[1]);
    const trade = { ...source, market: undefined }; expect(withMarketIndicators(trade, defaultMarketIndicators)).toBe(trade);
  });
  it('accepts inclusive input limits and rejects invalid, fractional-period or overprecision inputs', () => {
    expect(() => marketIndicatorParameters({ ...defaultMarketIndicators, smaPeriod: '120', deviationPercent: '20.0', emaPeriod: '0', atrPeriod: '120', atrMultiplier: '20.0', bollingerPeriod: '120', bollingerMultiplier: '10.0' })).not.toThrow();
    for (const invalid of [{ smaPeriod: '121' }, { smaPeriod: '1.5' }, { smaPeriod: '-1' }, { smaPeriod: '' }, { deviationPercent: '20.1' }, { deviationPercent: '1.01' }, { emaPeriod: '121' }, { atrPeriod: '-1' }, { atrMultiplier: 'Infinity' }, { atrMultiplier: '20.1' }, { bollingerPeriod: '121' }, { bollingerPeriod: '1.5' }, { bollingerMultiplier: '10.1' }, { bollingerMultiplier: '1.01' }]) {
      expect(() => marketIndicatorParameters({ ...defaultMarketIndicators, ...invalid })).toThrow();
    }
  });
  it('stores only valid last-applied settings and falls back safely on corrupt/unavailable local storage', () => {
    const values = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    expect(loadMarketIndicators()).toEqual(defaultMarketIndicators);
    const settings = { ...defaultMarketIndicators, smaPeriod: '120', deviationPercent: '2.4', atrMultiplier: '3.0' }; saveMarketIndicators(settings); expect(loadMarketIndicators()).toEqual(settings);
    expect(() => saveMarketIndicators({ ...settings, smaPeriod: '999' })).toThrow(); expect(loadMarketIndicators()).toEqual(settings);
    values.set(marketIndicatorStorageKey, '{broken'); expect(loadMarketIndicators()).toEqual(defaultMarketIndicators);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } });
    expect(loadMarketIndicators()).toEqual(defaultMarketIndicators); expect(() => saveMarketIndicators(settings)).not.toThrow();
  });
});
