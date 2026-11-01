import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chartAtInterval, markerAtInterval, withChartExecutionTimes } from './chartIntervals';
import { intervalSeconds } from './api';
import { cacheCandles, openCacheDatabase, writeValue } from './database';
import type { BacktestInterval, BacktestTrade, Candle, ChartData } from './types';

const opened = Date.UTC(2026, 3, 21, 12) / 1000;
const intervals: BacktestInterval[] = ['15m', '1h', '4h', '1d'];
const row = (at: number, seconds: number): Candle => ({ openTime: at, closeTime: at + seconds,
  open: 100, high: 103, low: 98, close: 101, volume: 20 });

function fixture(): { chart: ChartData; trade: BacktestTrade } {
  const trade: BacktestTrade = {
    tradeId: 'chart-test', symbol: 'BTCUSDT', side: 'LONG', entryAt: opened + 3900, exitAt: opened + 14400,
    reason: 'FULL_TP', quantity: 1, entryPrice: 100.25, exitPrice: 101.55, netProfitUsdt: 1,
    entryIndex: 0, exitIndex: 0, signalIndex: 0,
    signal: { strategy: 'PULLBACK', side: 'LONG', index: 0, entry: 100.25, stop: 98, target: 105, initialTarget: 105 },
    executions: [
      { kind: 'ENTRY', at: opened + 3900, candleOpenAt: opened, price: 100.25, quantity: 0.5, timing: 'INTRABAR' },
      { kind: 'SPLIT_ENTRY', at: opened + 7800, candleOpenAt: opened, price: 99, quantity: 0.5, timing: 'INTRABAR' },
      { kind: 'PARTIAL_TP', at: opened + 9900, candleOpenAt: opened, price: 101, quantity: 0.5, timing: 'INTRABAR' },
      { kind: 'CLOSE', at: opened + 14400, candleOpenAt: opened, price: 101.55, quantity: 0.5, timing: 'BAR_CLOSE' },
    ],
  };
  const events = trade.executions.map((fill, i) => ({ id: `event-${i}`, orderId: `event-${i}`, kind: fill.kind,
    label: fill.kind === 'CLOSE' ? 'C' as const : fill.kind === 'PARTIAL_TP' ? 'S' as const : 'B' as const,
    openTime: opened, price: fill.price, quantity: fill.quantity, candleIndex: 0 }));
  const chart: ChartData = { symbol: 'BTCUSDT', interval: '4h', side: 'LONG', referenceAt: new Date(opened * 1000).toISOString(), referenceIndex: 0,
    candles: [{ ...row(opened, 14400), ma5: 101, ma10: 101, ma20: 101, ma60: 101, ma120: 101 }],
    markers: events, executions: events, priceLines: [{ kind: 'ENTRY', price: 100.25 }, { kind: 'SL', price: 98 }, { kind: 'TP', price: 105 }],
    waves: [{ label: 'CURRENT', direction: 'UP', startTime: opened, endTime: opened + 14400 - 1, startIndex: 0, endIndex: 0, complete: true, low: 98, high: 103 }],
  };
  return { chart, trade };
}

async function seed(periods: BacktestInterval[] = intervals): Promise<void> {
  await writeValue('publicData', 'instruments:BTCUSDT', { expiresAt: Date.now() + 300000, data: [{ symbol: 'BTCUSDT', launchAt: 0 }] });
  for (const interval of periods) {
    const seconds = intervalSeconds(interval);
    const center = Math.floor(opened / seconds) * seconds;
    await cacheCandles('BTCUSDT', interval, Array.from({ length: 1400 }, (_, i) => row(center + (i - 700) * seconds, seconds)));
  }
}

beforeEach(async () => {
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => {
    const transaction = db.transaction([...db.objectStoreNames], 'readwrite');
    for (const name of db.objectStoreNames) transaction.objectStore(name).clear();
    transaction.oncomplete = () => resolve();
  });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('cached chart must not fetch'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('chart resolution without changing trade results', () => {
  it.each([
    ['15m', opened + 3600, opened + 13500],
    ['1h', opened + 3600, opened + 10800],
    ['4h', opened, opened],
    ['1d', Math.floor(opened / 86400) * 86400, Math.floor(opened / 86400) * 86400],
  ] as const)('maps actual fills to %s and places a closing-boundary fill in the preceding candle', (interval, entryAt, exitAt) => {
    const { chart, trade } = fixture();
    const source = withChartExecutionTimes(chart, trade);
    expect(markerAtInterval(source.executions![0]!, interval, '4h')).toBe(entryAt);
    expect(markerAtInterval(source.executions![3]!, interval, '4h')).toBe(exitAt);
    expect(chart.executions![0]!.executedAt).toBeUndefined();
  });

  it('keeps original fill times and prices through repeated smaller/larger timeframe switches', async () => {
    await seed();
    const { chart, trade } = fixture();
    const source = withChartExecutionTimes(chart, trade);
    const fifteen = await chartAtInterval(source, '15m');
    const daily = await chartAtInterval(fifteen, '1d');
    const back = await chartAtInterval(daily, '15m');
    expect(back.executions).toEqual(fifteen.executions);
    expect(back.priceLines).toEqual(chart.priceLines);
    expect(back.sourceInterval).toBe('4h');
    expect(back.candles.every(candle => candle.closeTime - candle.openTime === 900)).toBe(true);
    expect(back.waves[0]).toMatchObject({ low: 98, high: 103, startTime: opened });
    expect(trade.entryPrice).toBe(100.25);
    expect(chart.interval).toBe('4h');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses known entry/final-close times from an old server trade but does not invent a partial execution time', () => {
    const { chart, trade } = fixture();
    trade.executions = [];
    const source = withChartExecutionTimes(chart, trade);
    expect(source.executions![0]!.executedAt).toBe(trade.entryAt);
    expect(source.executions![3]).toMatchObject({ executedAt: trade.exitAt, timing: 'BAR_CLOSE' });
    expect(source.executions![2]!.executedAt).toBeUndefined();
    expect(markerAtInterval(source.executions![2]!, '15m', '4h')).toBe(opened);
    trade.reason = 'PARTIAL_TP';
    expect(withChartExecutionTimes(chart, trade).executions![3]!.executedAt).toBeUndefined();
  });

  it('retains execution order when only the final close is visible on the current page', async () => {
    await seed();
    const { chart, trade } = fixture();
    chart.markers = [chart.executions![3]!];
    const source = withChartExecutionTimes(chart, trade);
    const view = await chartAtInterval(source, '15m');
    expect(source.executions!.map(fill => fill.kind)).toEqual(['ENTRY', 'SPLIT_ENTRY', 'PARTIAL_TP', 'CLOSE']);
    expect(view.executions!.map(fill => fill.id)).toEqual(chart.executions!.map(fill => fill.id));
  });

  it('downloads only the missing selected-interval series and then reuses it', async () => {
    await seed(['4h']);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v5/market/kline');
      expect(url.searchParams.get('interval')).toBe('60');
      const start = Number(url.searchParams.get('start')) / 1000;
      const end = (Number(url.searchParams.get('end')) + 1) / 1000;
      const rows = Array.from({ length: (end - start) / 3600 }, (_, i) => [String((start + i * 3600) * 1000), '100', '103', '98', '101', '20']);
      return new Response(JSON.stringify({ retCode: 0, result: { list: rows.reverse() } }));
    });
    vi.stubGlobal('fetch', fetcher);
    const { chart, trade } = fixture();
    const source = withChartExecutionTimes(chart, trade);
    const first = await chartAtInterval(source, '1h');
    const second = await chartAtInterval(source, '1h');
    expect(first.candles).toEqual(second.candles);
    expect(first.candles).toHaveLength(300);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shows only completed candles when a requested higher-timeframe candle is still open', async () => {
    await seed();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((opened + 7 * 3600) * 1000);
    const { chart, trade } = fixture();
    const view = await chartAtInterval(withChartExecutionTimes(chart, trade), '1d', { focusAt: opened });
    const today = Math.floor(opened / 86400) * 86400;
    expect(view.candles.every(candle => candle.closeTime <= Date.now() / 1000)).toBe(true);
    expect(view.referenceAt).toBe(new Date((today - 86400) * 1000).toISOString());
    expect(view.markers).toEqual([]);
  });

  it('leaves the input chart untouched if selected-interval data is unavailable', async () => {
    await seed(['4h']);
    const { chart, trade } = fixture();
    const source = withChartExecutionTimes(chart, trade);
    const previous = structuredClone(source);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(chartAtInterval(source, '15m')).rejects.toThrow('403');
    expect(source).toEqual(previous);
  });

  it('keeps envelope bands on the original strategy timeframe when price-chart resolution changes', async () => {
    await seed();
    const { chart, trade } = fixture();
    chart.envelope = { interval: '4h', period: 20, deviationPercent: 1, bands: [] };
    const source = withChartExecutionTimes(chart, trade);
    const view = await chartAtInterval(source, '1h');
    expect(view.interval).toBe('1h');
    expect(view.envelope).toMatchObject({ interval: '4h', period: 20, deviationPercent: 1 });
    expect(view.envelope!.bands).toHaveLength(view.candles.length);
    expect(view.envelope!.bands[0]).toMatchObject({ center: 101, upper: 102.01, lower: 99.99 });
    expect(view.priceLines).toEqual(chart.priceLines);
    expect(fetch).not.toHaveBeenCalled();
  });
});
