import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intervalSeconds } from './api';
import { cacheCandles, openCacheDatabase } from './database';
import { loadMarketChart, marketChartWindow, matchingChartInstruments, mergeMarketChartPages, NoMarketCandlesError, normalizeChartQuery } from './marketChart';
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

describe('standalone USDT charts and cache-only prefix search', () => {
  it('normalizes to English capitals only and applies literal prefix matching, not substring matching', () => {
    const instruments = ['BBBUSDT', 'BTCUSDT', 'ETHUSDT', 'ABUSDT', '1000BONKUSDT'].map(symbol => ({ symbol, launchAt: 0 }));
    expect(normalizeChartQuery('bT c한글_%123')).toBe('BTC');
    expect(normalizeChartQuery('ßıＢ한글')).toBe('');
    expect(matchingChartInstruments(instruments, 'B').map(row => row.symbol)).toEqual(['BBBUSDT', 'BTCUSDT']);
    expect(matchingChartInstruments(instruments, 'bt').map(row => row.symbol)).toEqual(['BTCUSDT']);
    expect(matchingChartInstruments(instruments, '')).toEqual([]); expect(matchingChartInstruments(instruments, 'ZZ')).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['15m', '1h', '4h', '1d'] as const)('loads %s candles with true 120-day warmup from IndexedDB, no trade data or repeated requests', async interval => {
    const window = marketChartWindow(interval); const data = rows(interval, window.warmupStart, window.end); data.at(-1)!.volume = 1000;
    const instrument = { symbol: 'BTCUSDT', launchAt: window.warmupStart }; await cacheCandles(instrument.symbol, interval, data);
    const chart = await loadMarketChart(instrument, interval);
    expect(chart.candles).toHaveLength(300); expect(chart.referenceIndex).toBe(299); expect(chart.candles.at(-1)!.closeTime).toBe(window.end);
    expect(chart.market!.sourceCandles).toHaveLength(data.length); expect(chart.side).toBeNull(); expect(chart.markers).toEqual([]); expect(chart.priceLines).toEqual([]); expect(chart.waves).toEqual([]);
    expect(chart.candles.at(-1)!.marketMetrics).toMatchObject({ averageVolume120d: 500, volumePercent: 200, volumeSamples: 120 * 86400 / intervalSeconds(interval) });
    expect(await loadMarketChart(instrument, interval)).toEqual(chart); expect(fetch).not.toHaveBeenCalled();
  });
  it('fetches only one absent cached candle, using public prices without Authorization or orderbook requests', async () => {
    const window = marketChartWindow('1h'); const data = rows('1h', window.warmupStart, window.end); const missing = data[data.length - 5]!;
    await cacheCandles('BTCUSDT', '1h', data.filter(candle => candle !== missing));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); expect(url.pathname).toBe('/v5/market/kline'); expect(url.searchParams.get('interval')).toBe('60'); expect(init?.headers).toBeUndefined();
      expect(Number(url.searchParams.get('start'))).toBe(missing.openTime * 1000); expect(Number(url.searchParams.get('end'))).toBe(missing.closeTime * 1000 - 1);
      return new Response(JSON.stringify({ retCode: 0, result: { list: [[missing.openTime * 1000, missing.open, missing.high, missing.low, missing.close, missing.volume].map(String)] } }));
    }); vi.stubGlobal('fetch', fetcher);
    const instrument = { symbol: 'BTCUSDT', launchAt: window.warmupStart };
    expect((await loadMarketChart(instrument, '1h')).candles).toHaveLength(300); await loadMarketChart(instrument, '1h'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('merges adjacent older pages, retains volume warmup, preserves latest focus and refuses to join gaps', async () => {
    const window = marketChartWindow('1h'); const oldWindow = marketChartWindow('1h', { beforeAt: window.start });
    const instrument = { symbol: 'BTCUSDT', launchAt: oldWindow.warmupStart };
    await cacheCandles(instrument.symbol, '1h', rows('1h', oldWindow.warmupStart, window.end));
    const current = await loadMarketChart(instrument, '1h'); const older = await loadMarketChart(instrument, '1h', { beforeAt: window.start });
    const merged = mergeMarketChartPages(older, current);
    expect(merged.candles).toHaveLength(600); expect(merged.referenceIndex).toBe(599); expect(merged.candles[0]!.marketMetrics!.averageVolume120d).toBe(500);
    expect(merged.priceLines).toEqual([]); expect(merged.executions).toEqual([]); expect(merged.market!.sourceCandles.length).toBeGreaterThan(current.market!.sourceCandles.length);
    expect(() => mergeMarketChartPages({ ...older, symbol: 'ETHUSDT' }, current)).toThrow('서로 다른');
    expect(() => mergeMarketChartPages({ ...older, candles: older.candles.slice(0, -1) }, current)).toThrow('누락'); expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps a selected historical time in a new resolution and only uses completed bars', async () => {
    const focusAt = now - 10 * 86400 + 17; const window = marketChartWindow('4h', { focusAt });
    await cacheCandles('BTCUSDT', '4h', rows('4h', window.warmupStart, window.end));
    const chart = await loadMarketChart({ symbol: 'BTCUSDT', launchAt: window.warmupStart }, '4h', { focusAt });
    expect(chart.candles[chart.referenceIndex!]!.openTime).toBe(Math.floor(focusAt / 14400) * 14400); expect(chart.candles.every(row => row.closeTime <= now)).toBe(true);
  });
  it('fails empty/unavailable windows explicitly and supports cancellation before any public request', async () => {
    await expect(loadMarketChart({ symbol: 'NEWUSDT', launchAt: now }, '1h')).rejects.toBeInstanceOf(NoMarketCandlesError);
    const abort = new AbortController(); abort.abort(); await expect(loadMarketChart({ symbol: 'BTCUSDT', launchAt: 0 }, '1h', { signal: abort.signal })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
