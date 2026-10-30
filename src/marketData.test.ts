import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheCandles } from './database';
import { ensureCandles, orderBookSlippage } from './marketData';
import type { Candle } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const row = (index: number): Candle => ({ openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600, open: 100, high: 102, low: 99, close: 101, volume: 10 });
afterEach(() => vi.unstubAllGlobals());

describe('public market data and reuse', () => {
  it('downloads only missing candles, then reuses them without a network request', async () => {
    await cacheCandles('BTCUSDT', '1h', [row(0), row(1)]);
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('api.bybit.com');
      expect(init?.headers).toBeUndefined();
      expect(Number(url.searchParams.get('start')) / 1000).toBe(row(2).openTime);
      return new Response(JSON.stringify({ retCode: 0, result: { list: [row(4), row(3), row(2)].map(c => [c.openTime * 1000, c.open, c.high, c.low, c.close, c.volume].map(String)) } }));
    });
    vi.stubGlobal('fetch', fetcher);
    const instrument = { symbol: 'BTCUSDT', launchAt: origin };
    expect(await ensureCandles(instrument, '1h', origin, origin + 5 * 3600)).toHaveLength(5);
    expect(await ensureCandles(instrument, '1h', origin, origin + 5 * 3600)).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('skips the period before listing but rejects a real hole in the middle', async () => {
    await cacheCandles('NEWUSDT', '1h', [row(3), row(4)]);
    expect(await ensureCandles({ symbol: 'NEWUSDT', launchAt: row(3).openTime }, '1h', origin, origin + 5 * 3600)).toHaveLength(2);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ retCode: 0, result: { list: [] } }))));
    await expect(ensureCandles({ symbol: 'GAPUSDT', launchAt: origin }, '1h', origin, origin + 5 * 3600)).rejects.toThrow('캔들이 누락');
  });

  it('uses both sides of the 10,000 USDT order book and rejects inadequate depth', () => {
    expect(orderBookSlippage([[99.9, 200]], [[100.1, 200]], 'LONG')).toBeCloseTo(0.001);
    expect(orderBookSlippage([[99.9, 200]], [[100.1, 200]], 'SHORT')).toBeCloseTo(0.001);
    expect(orderBookSlippage([[99.9, 1]], [[100.1, 1]], 'LONG')).toBeNull();
    expect(orderBookSlippage([[101, 200]], [[100, 200]], 'LONG')).toBeNull();
  });
});
