import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChartModal } from './ChartModal';
import { defaultMarketIndicators, enrichMarketCandles, marketIndicatorStorageKey } from '../marketIndicators';
import type { Candle, ChartData } from '../types';

const rows: Candle[] = Array.from({ length: 30 }, (_, index) => ({ openTime: index * 86400, closeTime: (index + 1) * 86400, open: 100, high: 105, low: 95, close: 100, volume: 500 }));
const chart: ChartData = { symbol: 'BTCUSDT', interval: '1h', side: 'LONG', referenceAt: new Date(rows[25]!.openTime * 1000).toISOString(), referenceIndex: 25,
  candles: enrichMarketCandles(rows, '1d'), markers: [], executions: [], waves: [], priceLines: [],
  envelope: { interval: '1d', period: 3, deviationPercent: 3, bands: [
    { openTime: rows[26]!.openTime, center: 200, upper: 206, lower: 194 },
    { openTime: rows[25]!.openTime, center: 100, upper: 103.1234999, lower: 97.9876999 },
  ] } };

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

const html = (value: ChartData) => renderToStaticMarkup(<ChartModal chart={value} onClose={() => {}} />);
const readout = (markup: string) => /<span class="candle-envelope-prices">([^<]*)<\/span>/.exec(markup)?.[1];
const atrReadout = (markup: string) => /<span class="candle-atr-prices">([^<]*)<\/span>/.exec(markup)?.[1];
const bollingerReadout = (markup: string) => /<span class="candle-bollinger-prices">([^<]*)<\/span>/.exec(markup)?.[1];

describe('selected-candle envelope prices', () => {
  it('uses the exact displayed candle timestamp, not array order or another timeframe', () => {
    const markup = html(chart);
    expect(readout(markup)).toBe('엔벨 상단 103.1234 · 하단 97.9876');
    expect(markup).toContain('엔벨로프 1d · SMA3 · ±3%');
    expect(markup).toContain('stroke="#CFB1FF"');
    expect(readout(html({ ...chart, referenceIndex: 26 }))).toBe('엔벨 상단 206 · 하단 194');
  });

  it('shows the configured envelope in the standalone chart menu too', () => {
    values.set(marketIndicatorStorageKey, JSON.stringify({ ...defaultMarketIndicators, smaPeriod: '3', deviationPercent: '3.0' }));
    const markup = html({ ...chart, interval: '1d', side: null, market: { sourceCandles: rows } });
    expect(readout(markup)).toBe('엔벨 상단 103 · 하단 97');
    expect(markup).toContain('envelope-upper');
    expect(markup).not.toContain('매수가');
  });

  it('omits the prices when the standalone envelope is hidden or its period is zero', () => {
    expect(readout(html({ ...chart, side: null, market: { sourceCandles: rows } }))).toBeUndefined();
    values.set(marketIndicatorStorageKey, JSON.stringify({ ...defaultMarketIndicators, smaPeriod: '0', deviationPercent: '3.0' }));
    expect(readout(html({ ...chart, side: null, market: { sourceCandles: rows } }))).toBeUndefined();
  });

  it('does not invent a band when the selected candle has no envelope sample', () => {
    expect(readout(html({ ...chart, referenceIndex: 24 }))).toBeUndefined();
    expect(readout(html({ ...chart, envelope: undefined }))).toBeUndefined();
  });

  it('floors tiny and large envelope prices to at most four decimal places', () => {
    const definition = { ...chart.envelope!, bands: [{ openTime: rows[25]!.openTime, center: 100, upper: 83146.62833999, lower: 0.00179999 }] };
    expect(readout(html({ ...chart, envelope: definition }))).toBe('엔벨 상단 83,146.6283 · 하단 0.0017');
  });

  it('shows the active standalone ATR and Bollinger bands using their displayed indicator settings', () => {
    const markup = html({ ...chart, interval: '1d', side: null, market: { sourceCandles: rows } });
    expect(atrReadout(markup)).toBe('ATR 엔벨 상단 120 · 하단 80');
    expect(bollingerReadout(markup)).toBe('볼린저 상단 100 · 하단 100');
    expect(readout(markup)).toBeUndefined();
  });

  it('independently hides every disabled indicator rather than reusing stale band prices', () => {
    const market = { ...chart, interval: '1d' as const, side: null, market: { sourceCandles: rows } };
    values.set(marketIndicatorStorageKey, JSON.stringify({ ...defaultMarketIndicators, smaPeriod: '3', deviationPercent: '3.0', atrMultiplier: '0.0', bollingerPeriod: '0' }));
    let markup = html(market);
    expect(readout(markup)).toBeDefined();
    expect(atrReadout(markup)).toBeUndefined();
    expect(bollingerReadout(markup)).toBeUndefined();
    values.set(marketIndicatorStorageKey, JSON.stringify({ ...defaultMarketIndicators, atrPeriod: '0', bollingerMultiplier: '0.0' }));
    markup = html(market);
    expect(readout(markup)).toBeUndefined();
    expect(atrReadout(markup)).toBeUndefined();
    expect(bollingerReadout(markup)).toBeUndefined();
  });

  it('floors all band readouts and matches each band by candle time', () => {
    const current = rows[25]!.openTime;
    const other = rows[26]!.openTime;
    const markup = html({ ...chart,
      atrEnvelope: { emaPeriod: 20, atrPeriod: 14, multiplier: 2, bands: [{ openTime: other, center: 999, upper: 999, lower: 999 }, { openTime: current, center: 100, upper: 120.1234999, lower: 80.9876999 }] },
      bollinger: { period: 20, multiplier: 2, bands: [{ openTime: current, center: 100, upper: 110.1234999, lower: 90.9876999 }] },
    });
    expect(atrReadout(markup)).toBe('ATR 엔벨 상단 120.1234 · 하단 80.9876');
    expect(bollingerReadout(markup)).toBe('볼린저 상단 110.1234 · 하단 90.9876');
  });
});
