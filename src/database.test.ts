import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheCandles, maintainCache, openCacheDatabase, readCandlePages } from './database';
import type { Candle } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
function row(index: number): Candle {
  return { openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600, open: 100, high: 102, low: 99, close: 101, volume: 10 };
}
afterEach(() => vi.unstubAllGlobals());

describe('partitioned candle database', () => {
  it('migrates legacy ranges without discarding valid saved candles', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('zetaauto-web-cache', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('candles', { keyPath: 'cacheKey' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction('candles', 'readwrite');
        transaction.objectStore('candles').put({ cacheKey: `BTCUSDT:1h:${origin}:${origin + 7200}`, candles: [row(0), row(1)], savedAt: Date.now() });
        transaction.oncomplete = () => { request.result.close(); resolve(); };
      };
    });
    await maintainCache(true);
    expect(await readCandlePages('BTCUSDT', '1h', origin, origin + 7200)).toEqual([row(0), row(1)]);
  });

  it('keeps more than 512 symbols and reads only the requested series/time pages', async () => {
    for (let i = 0; i < 601; i += 1) await cacheCandles(`COIN${i}USDT`, '1h', [row(0), row(1)]);
    await maintainCache(true);
    const spy = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    expect(await readCandlePages('COIN0USDT', '1h', origin, origin + 7200)).toHaveLength(2);
    expect(await readCandlePages('COIN600USDT', '1h', origin, origin + 3600)).toEqual([row(0)]);
    expect(spy.mock.calls.every(call => call[0] instanceof IDBKeyRange)).toBe(true);
    spy.mockRestore();
  });
  it('stores 1-minute pages separately and reuses overlapping minute ranges', async () => {
    const minutes = Array.from({ length: 1100 }, (_, i) => ({ ...row(0), openTime: origin + i * 60, closeTime: origin + (i + 1) * 60 }));
    await cacheCandles('MINUTEUSDT', '1m', minutes);
    await cacheCandles('MINUTEUSDT', '1h', [row(0)]);
    expect(await readCandlePages('MINUTEUSDT', '1m', origin + 990 * 60, origin + 1010 * 60)).toEqual(minutes.slice(990, 1010));
    expect(await readCandlePages('MINUTEUSDT', '1h', origin, origin + 3600)).toEqual([row(0)]);
  });

  it('merges overlaps, keeps chronological order, and never caches an unfinished candle', async () => {
    await cacheCandles('ETHUSDT', '1h', [row(2), row(0), row(1)]);
    await cacheCandles('ETHUSDT', '1h', [{ ...row(1), close: 100.5 }, row(3), { ...row(4), closeTime: Date.now() / 1000 + 3600 }]);
    expect(await readCandlePages('ETHUSDT', '1h', origin, origin + 5 * 3600)).toEqual([row(0), { ...row(1), close: 100.5 }, row(2), row(3)]);
  });

  it('evicts by metadata when the device quota is smaller than the configured budget', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 2000 }) } });
    await maintainCache(true);
    const db = await openCacheDatabase();
    const count = await new Promise<number>(resolve => {
      const request = db.transaction('pageMetadata').objectStore('pageMetadata').count();
      request.onsuccess = () => resolve(request.result);
    });
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(4);
  });
});
