import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheCandles, openCacheDatabase } from './database';
import { ensureCandles, orderBookSlippage, refreshMismatchedLowerTimeframes } from './marketData';
import type { Candle, CandleInterval } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const row = (index: number): Candle => ({ openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600, open: 100, high: 102, low: 99, close: 101, volume: 10 });
beforeEach(async () => {
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => {
    const transaction = db.transaction(['pages', 'pageMetadata', 'publicData'], 'readwrite');
    for (const name of ['pages', 'pageMetadata', 'publicData']) transaction.objectStore(name).clear();
    transaction.oncomplete = () => resolve();
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('public market data and reuse', () => {
  it.each<[CandleInterval, number, string]>([
    ['1m', 60, '2026-11-11T06:29:00Z'],
    ['15m', 900, '2026-11-11T06:15:00Z'],
    ['1h', 3600, '2026-11-11T06:00:00Z'],
    ['4h', 14400, '2026-11-11T04:00:00Z'],
    ['1d', 86400, '2026-11-11T00:00:00Z'],
  ])('uses only completed %s candles when the requested end is in the future', async (interval, seconds, boundary) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T06:29:00Z'));
    const end = Date.parse(boundary) / 1000;
    const previous = { ...row(0), openTime: end - seconds, closeTime: end };
    await cacheCandles('BTCUSDT', interval, [previous]);
    const fetcher = vi.fn(() => { throw new Error('A forming candle must not be requested'); });
    vi.stubGlobal('fetch', fetcher);
    expect(await ensureCandles({ symbol: 'BTCUSDT', launchAt: origin }, interval, previous.openTime, Date.now() / 1000 + 86400)).toEqual([previous]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('excludes the partial last daily candle at a historical intraday end and at today\'s 09:00 KST', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T06:29:00Z'));
    const today = Date.parse('2026-11-11T00:00:00Z') / 1000;
    const yesterday = { ...row(0), openTime: today - 86400, closeTime: today };
    await cacheCandles('BTCUSDT', '1d', [yesterday]);
    const fetcher = vi.fn(() => { throw new Error('No complete candle is missing'); });
    vi.stubGlobal('fetch', fetcher);
    const instrument = { symbol: 'BTCUSDT', launchAt: origin };
    expect(await ensureCandles(instrument, '1d', yesterday.openTime, today + 6 * 3600)).toEqual([yesterday]);
    expect(await ensureCandles(instrument, '1d', today, today + 6 * 3600)).toEqual([]);
    // This daily candle is now complete, but had not closed at the requested historical end.
    expect(await ensureCandles(instrument, '1d', yesterday.openTime, yesterday.openTime + 6 * 3600)).toEqual([]);
    vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
    expect(await ensureCandles(instrument, '1d', yesterday.openTime, today)).toEqual([yesterday]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requests only missing 1-minute candles and never confuses them with cached hourly bars', async () => {
    const minutes = Array.from({ length: 60 }, (_, i) => ({ ...row(0), openTime: origin + i * 60, closeTime: origin + (i + 1) * 60 }));
    await cacheCandles('MINUTEUSDT', '1h', [row(0)]);
    await cacheCandles('MINUTEUSDT', '1m', minutes.slice(0, 20));
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('interval')).toBe('1');
      expect(Number(url.searchParams.get('start'))).toBe((origin + 20 * 60) * 1000);
      return new Response(JSON.stringify({ retCode: 0, result: { list: minutes.slice(20).reverse().map(candle => [candle.openTime * 1000, candle.open, candle.high, candle.low, candle.close, candle.volume].map(String)) } }));
    });
    vi.stubGlobal('fetch', fetcher);
    const instrument = { symbol: 'MINUTEUSDT', launchAt: origin };
    expect(await ensureCandles(instrument, '1m', origin, origin + 3600)).toEqual(minutes);
    expect(await ensureCandles(instrument, '1m', origin, origin + 3600)).toEqual(minutes);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
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
    await cacheCandles('GAPUSDT', '1h', [row(0), row(2), row(4)]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ retCode: 0, result: { list: [] } }))));
    await expect(ensureCandles({ symbol: 'GAPUSDT', launchAt: origin }, '1h', origin, origin + 5 * 3600)).rejects.toThrow('캔들이 누락');
  });

  it('uses the real first CTUSDT hour instead of expecting a candle in its registration hour', async () => {
    // Verified public data: registered 2026-10-01 17:45:28 KST, first 1h candle at 18:00 KST.
    const launchAt = 1790844328;
    const first = 1790845200;
    const candles = [
      { openTime: first, closeTime: first + 3600, open: 0.424, high: 0.4732, low: 0.423, close: 0.4594, volume: 630969 },
      { openTime: first + 3600, closeTime: first + 7200, open: 0.4594, high: 0.5313, low: 0.4574, close: 0.483, volume: 10455042 },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ retCode: 0, result: { list: candles.map(c => [c.openTime * 1000, c.open, c.high, c.low, c.close, c.volume].map(String)).reverse() } })));
    vi.stubGlobal('fetch', fetcher);
    const instrument = { symbol: 'CTUSDT', launchAt };
    expect(await ensureCandles(instrument, '1h', first - 200 * 3600, first + 7200)).toEqual(candles);
    expect(await ensureCandles(instrument, '1h', first - 200 * 3600, first + 7200)).toEqual(candles);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('repairs the exact paused-job case using previously cached candles without re-downloading them', async () => {
    const launchAt = 1790844328;
    const first = 1790845200;
    const candles = [0, 1, 2].map(index => ({ ...row(index), openTime: first + index * 3600, closeTime: first + (index + 1) * 3600 }));
    await cacheCandles('CTUSDT', '1h', candles);
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(Number(url.searchParams.get('start'))).toBe(1790841600000);
      expect(Number(url.searchParams.get('end'))).toBe(first * 1000 - 1);
      return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }));
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await ensureCandles({ symbol: 'CTUSDT', launchAt }, '1h', first - 200 * 3600, first + 3 * 3600)).toEqual(candles);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('allows a first 15m candle later than both the registration bucket and the next bucket', async () => {
    const launchAt = 1790844328;
    const first = 1790846100;
    const candles = [0, 1].map(index => ({ ...row(index), openTime: first + index * 900, closeTime: first + (index + 1) * 900 }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ retCode: 0, result: { list: candles.map(c => [c.openTime * 1000, c.open, c.high, c.low, c.close, c.volume].map(String)) } }))));
    expect(await ensureCandles({ symbol: 'CTUSDT', launchAt }, '15m', first - 3600, first + 1800)).toEqual(candles);
  });

  it('keeps a real candle in the registration bucket rather than always rounding listing up', async () => {
    await cacheCandles('EARLYUSDT', '1h', [row(0), row(1)]);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('must use cached real candles'); }));
    expect(await ensureCandles({ symbol: 'EARLYUSDT', launchAt: origin + 28 }, '1h', origin - 3600, origin + 7200)).toEqual([row(0), row(1)]);
  });

  it('retries an isolated internal gap and uses the recovered bar', async () => {
    await cacheCandles('RETRYUSDT', '1h', [row(0), row(2)]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ retCode: 0, result: { list: [] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ retCode: 0, result: { list: [[row(1).openTime * 1000, 100, 102, 99, 101, 10].map(String)] } })));
    vi.stubGlobal('fetch', fetcher);
    expect(await ensureCandles({ symbol: 'RETRYUSDT', launchAt: origin }, '1h', origin, origin + 3 * 3600)).toEqual([row(0), row(1), row(2)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refreshes only a mismatched parent and its 15-minute range', async () => {
    const parent = { openTime: origin, closeTime: origin + 3600, open: 100, high: 105, low: 95, close: 104, volume: 40 };
    const correctedParent = { ...parent, high: 104, low: 96 };
    const children = Array.from({ length: 4 }, (_, index) => ({
      openTime: origin + index * 900, closeTime: origin + (index + 1) * 900,
      open: index === 0 ? 100 : 100 + index - 1, high: 101 + index, low: 99 - index, close: index === 3 ? 104 : 100 + index, volume: 10,
    }));
    await cacheCandles('REPAIRUSDT', '1h', [parent]);
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const interval = url.searchParams.get('interval');
      const rows = interval === '60' ? [correctedParent] : children;
      return new Response(JSON.stringify({ retCode: 0, result: { list: rows.map(candle => [candle.openTime * 1000, candle.open, candle.high, candle.low, candle.close, candle.volume].map(String)) } }));
    });
    vi.stubGlobal('fetch', fetcher);
    const repaired = await refreshMismatchedLowerTimeframes({ symbol: 'REPAIRUSDT', launchAt: origin }, '1h', [parent], children);
    expect(repaired).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('interval'))).toEqual(['60', '15']);
    expect(await ensureCandles({ symbol: 'REPAIRUSDT', launchAt: origin }, '1h', origin, origin + 3600)).toEqual([correctedParent]);
  });

  it('does not classify malformed prices as an empty listing prefix', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ retCode: 0, result: { list: [[origin * 1000, 'bad', 102, 99, 101, 10]] } }))));
    await expect(ensureCandles({ symbol: 'BADUSDT', launchAt: origin }, '1h', origin, origin + 3600)).rejects.toThrow('올바르지');
  });

  it('uses both sides of the 10,000 USDT order book and rejects inadequate depth', () => {
    expect(orderBookSlippage([[99.9, 200]], [[100.1, 200]], 'LONG')).toBeCloseTo(0.001);
    expect(orderBookSlippage([[99.9, 200]], [[100.1, 200]], 'SHORT')).toBeCloseTo(0.001);
    expect(orderBookSlippage([[99.9, 1]], [[100.1, 1]], 'LONG')).toBeNull();
    expect(orderBookSlippage([[101, 200]], [[100, 200]], 'LONG')).toBeNull();
  });
});
