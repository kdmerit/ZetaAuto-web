import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intervalSeconds } from './api';
import { cacheCandles, openCacheDatabase } from './database';
import { loadMarketChart, loadOlderMarketChart, marketChartWindow, matchingChartInstruments, NoMarketCandlesError, normalizeChartQuery } from './marketChart';
import type { BacktestInterval, Candle } from './types';

const now = Date.UTC(2026, 10, 2, 12, 45) / 1000;
function rows(interval: BacktestInterval, from: number, end: number): Candle[] {
  const seconds = intervalSeconds(interval);
  return Array.from({ length: (end - from) / seconds }, (_, i) => ({ openTime: from + i * seconds, closeTime: from + (i + 1) * seconds, open: 100, high: 102, low: 99, close: 100, volume: 500 }));
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now * 1000);
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => { const tx = db.transaction([...db.objectStoreNames], 'readwrite'); for (const name of db.objectStoreNames) tx.objectStore(name).clear(); tx.oncomplete = () => resolve(); });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('cached public market chart must not fetch'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function apiResponse(candles: Candle[]): Response {
  return new Response(JSON.stringify({ retCode: 0, result: {
    list: candles.slice().reverse().map(candle => [candle.openTime * 1000, candle.open, candle.high, candle.low, candle.close, candle.volume].map(String)),
  } }));
}

describe('standalone USDT charts and cache-only prefix search', () => {
  it('normalizes to English capitals only and applies literal prefix matching, not substring matching', () => {
    const instruments = ['BBBUSDT', 'BTCUSDT', 'ETHUSDT', 'ABUSDT', '1000BONKUSDT'].map(symbol => ({ symbol, launchAt: 0 }));
    expect(normalizeChartQuery('bT c한글_%123')).toBe('BTC');
    expect(normalizeChartQuery('ßıＢ한글')).toBe('');
    expect(matchingChartInstruments(instruments, 'B').map(row => row.symbol)).toEqual(['BBBUSDT', 'BTCUSDT']);
    expect(matchingChartInstruments(instruments, 'bt').map(row => row.symbol)).toEqual(['BTCUSDT']);
    expect(matchingChartInstruments(instruments, '')).toEqual([]); expect(matchingChartInstruments(instruments, 'ZZ')).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['15m', '1h', '4h', '1d'] as const)('loads 300 %s candles from a 1000-bar buffer, including the live bar and ATR14', async interval => {
    const { end } = marketChartWindow(interval);
    const step = intervalSeconds(interval);
    const start = end - 1000 * step;
    const data = rows(interval, start, end);
    data.at(-1)!.volume = 1000;
    data.at(-15)!.high = 202;
    data.at(-1)!.high = 116;
    const instrument = { symbol: 'BTCUSDT', launchAt: 0 };
    await cacheCandles(instrument.symbol, interval, data);
    const fetcher = vi.fn(async () => apiResponse(data));
    vi.stubGlobal('fetch', fetcher);
    const chart = await loadMarketChart(instrument, interval);
    expect(chart.candles).toHaveLength(300);
    expect(chart.referenceIndex).toBe(299);
    expect(chart.candles.at(-1)!.closeTime).toBe(end);
    expect(chart.candles.at(-1)!.openTime).toBe(end - step);
    expect(chart.candles.at(-1)!.closeTime).toBeGreaterThan(now);
    expect(chart.market!.sourceCandles).toHaveLength(1000);
    expect(chart.side).toBeNull(); expect(chart.markers).toEqual([]); expect(chart.priceLines).toEqual([]); expect(chart.waves).toEqual([]);
    expect(chart.candles.at(-1)!.marketMetrics).toMatchObject({
      averageTrueRange14: 4, atrSamples: 14, expectedAtrSamples: 14,
      averageVolume120d: 500, volumePercent: 200, volumeSamples: Math.min(999, 120 * 86400 / step),
    });
    expect(await loadMarketChart(instrument, interval)).toEqual(chart);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('fills an incomplete buffer in one public 1000-bar request without Authorization', async () => {
    const { end } = marketChartWindow('1h');
    const start = end - 1000 * 3600;
    const data = rows('1h', start, end);
    const missing = data[data.length - 5]!;
    await cacheCandles('BTCUSDT', '1h', data.filter(candle => candle !== missing));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); expect(url.pathname).toBe('/v5/market/kline'); expect(url.searchParams.get('interval')).toBe('60'); expect(init?.headers).toBeUndefined();
      expect(url.searchParams.get('limit')).toBe('1000');
      expect(Number(url.searchParams.get('start'))).toBe(start * 1000);
      expect(Number(url.searchParams.get('end'))).toBe(end * 1000 - 1);
      return apiResponse([missing, data.at(-1)!]);
    }); vi.stubGlobal('fetch', fetcher);
    const instrument = { symbol: 'BTCUSDT', launchAt: 0 };
    const chart = await loadMarketChart(instrument, '1h');
    expect(chart.candles).toHaveLength(300);
    expect(chart.market!.sourceCandles).toHaveLength(1000);
    await loadMarketChart(instrument, '1h');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('reuses two 300-bar pages before requesting the next batch at the oldest buffered candle', async () => {
    const interval = '15m';
    const { end } = marketChartWindow(interval);
    const step = intervalSeconds(interval);
    const instrument = { symbol: 'BTCUSDT', launchAt: 0 };
    const requestedEnds: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const to = (Number(url.searchParams.get('end')) + 1) / 1000;
      requestedEnds.push(to);
      expect(url.searchParams.get('limit')).toBe('1000');
      expect(Number(url.searchParams.get('start')) / 1000).toBe(to - 1000 * step);
      const list = rows(interval, to - 1000 * step, to).reverse().map(candle =>
        [candle.openTime * 1000, candle.open, candle.high, candle.low, candle.close, candle.volume].map(String));
      return new Response(JSON.stringify({ retCode: 0, result: { list } }));
    }));
    const initial = await loadMarketChart(instrument, interval);
    const second = (await loadOlderMarketChart(instrument, initial)).chart;
    const third = (await loadOlderMarketChart(instrument, second)).chart;
    expect([initial.candles.length, second.candles.length, third.candles.length]).toEqual([300, 600, 900]);
    expect(requestedEnds).toEqual([end]);
    const fourth = (await loadOlderMarketChart(instrument, third)).chart;
    expect(requestedEnds).toEqual([end, end - 1000 * step]);
    expect(fourth.candles).toHaveLength(1200);
    expect(fourth.candles[0]!.openTime).toBe(end - 1200 * step);
    expect(fourth.candles[299]!.closeTime).toBe(third.candles[0]!.openTime);
    expect(fourth.referenceIndex).toBe(1199);
    expect(fourth.market!.sourceCandles).toHaveLength(2000);
    expect(fourth.candles.every(candle => candle.marketMetrics!.atrSamples === 14)).toBe(true);
  });
  it('uses the final short page at the listing boundary and stops paging', async () => {
    const { end } = marketChartWindow('1h');
    const instrument = { symbol: 'BTCUSDT', launchAt: end - 350 * 3600 };
    const data = rows('1h', instrument.launchAt, end);
    await cacheCandles(instrument.symbol, '1h', data);
    vi.stubGlobal('fetch', vi.fn(async () => apiResponse([data.at(-1)!])));
    const chart = await loadMarketChart(instrument, '1h');
    const older = await loadOlderMarketChart(instrument, chart);
    expect(older.hasOlder).toBe(false);
    expect(older.chart.candles).toHaveLength(350);
    expect(older.chart.candles[0]!.marketMetrics!.atrSamples).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a selected historical time in a new resolution and only uses completed bars', async () => {
    const focusAt = now - 40 * 86400 + 17; const window = marketChartWindow('4h', { focusAt });
    await cacheCandles('BTCUSDT', '4h', rows('4h', window.end - 1000 * 14400, window.end));
    const chart = await loadMarketChart({ symbol: 'BTCUSDT', launchAt: 0 }, '4h', { focusAt });
    expect(chart.candles[chart.referenceIndex!]!.openTime).toBe(Math.floor(focusAt / 14400) * 14400); expect(chart.candles.every(row => row.closeTime <= now)).toBe(true);
  });
  it('fails empty/unavailable windows explicitly and supports cancellation before any public request', async () => {
    await expect(loadMarketChart({ symbol: 'NEWUSDT', launchAt: marketChartWindow('1h').end }, '1h')).rejects.toBeInstanceOf(NoMarketCandlesError);
    const abort = new AbortController(); abort.abort(); await expect(loadMarketChart({ symbol: 'BTCUSDT', launchAt: 0 }, '1h', { signal: abort.signal })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
