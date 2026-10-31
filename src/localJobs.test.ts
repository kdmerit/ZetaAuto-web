import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheCandles, lease, openCacheDatabase, readValue, writeValue } from './database';
import { engineVersionFor, executeLocalJob, loadLocalJob, loadLocalResult, type LocalJobView } from './localJobs';
import { ensureCandles, instrumentEligibility, listInstruments } from './marketData';
import type { BacktestSettings, Candle } from './types';

vi.mock('./marketData', async importOriginal => {
  const actual = await importOriginal<typeof import('./marketData')>();
  return { ...actual, listInstruments: vi.fn(), instrumentEligibility: vi.fn(), ensureCandles: vi.fn() };
});

const origin = Date.UTC(2026, 0, 1) / 1000;
const settings: BacktestSettings = {
  mode: 'ALL', symbol: 'AAA', interval: '1h', startDate: '2026-01-01', startTime: '09:00', endDate: '2026-01-12', endTime: '05:00',
  initialCapitalUsdt: '250', betAmountUsdt: '100', leverage: '2', side: 'BOTH', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1.0', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1.0',
};

beforeEach(async () => {
  vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4 * 1024 ** 3 }) } });
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => {
    const transaction = db.transaction([...db.objectStoreNames], 'readwrite');
    for (const name of db.objectStoreNames) transaction.objectStore(name).clear();
    transaction.oncomplete = () => resolve();
  });
  vi.mocked(listInstruments).mockResolvedValue([{ symbol: 'AAAUSDT', launchAt: origin - 200 * 3600 }, { symbol: 'ZZZUSDT', launchAt: origin - 200 * 3600 }]);
  vi.mocked(instrumentEligibility).mockImplementation(async instrument => ({ ...instrument, LONG: true, SHORT: true }));
  vi.mocked(ensureCandles).mockImplementation(async (_instrument, _interval, from, end) => {
    const rows: Candle[] = [];
    for (let at = from; at < end; at += 3600) {
      const phase = ((Math.round((at - origin) / 3600) % 20) + 20) % 20;
      const prices = phase === 8 ? [101, 102, 99, 100] : phase === 9 ? [100, 102, 99, 101]
        : phase === 10 ? [101, 104, 100, 103] : phase === 11 ? [103, 108, 102, 106] : [100, 101, 99, 100];
      rows.push({ openTime: at, closeTime: at + 3600, open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 10 });
    }
    return rows;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('durable local analysis', () => {
  it('resumes from a committed shared-account block with identical trades and totals', async () => {
    const pause = new AbortController();
    const updates: LocalJobView[] = [];
    await executeLocalJob({ strategy: 'VOLATILITY', settings }, view => {
      updates.push(view);
      if (view.blockStart > origin && view.phase === 'DATA') pause.abort();
    }, pause.signal);
    const paused = await loadLocalJob('VOLATILITY');
    expect(paused?.status).toBe('PAUSED');
    expect(paused?.result?.entryCount).toBeGreaterThan(0);
    expect(paused?.blockStart).toBe(origin + 128 * 3600);
    const resumedUpdates: LocalJobView[] = [];
    await executeLocalJob({ strategy: 'VOLATILITY', settings: { ...settings, initialCapitalUsdt: '9999' }, resumeId: paused!.id }, view => resumedUpdates.push(view), new AbortController().signal);
    const resumed = await loadLocalJob('VOLATILITY');
    const stored = await loadLocalResult(resumed!.id);
    expect(resumed?.status).toBe('COMPLETED');
    expect(stored?.settings.initialCapitalUsdt).toBe('250');
    expect(stored?.result.recentTrades.some(trade => trade.symbol === 'ZZZUSDT')).toBe(true);
    await executeLocalJob({ strategy: 'VOLATILITY', settings }, () => undefined, new AbortController().signal);
    const uninterrupted = (await loadLocalJob('VOLATILITY'))!;
    expect({ ...uninterrupted.result, localRunId: undefined }).toEqual({ ...stored?.result, localRunId: undefined });
    expect(resumedUpdates.at(-1)?.completed).toBe(resumedUpdates.at(-1)?.total);
    expect(updates.at(-1)?.message).toContain('일시정지');
  });

  it('retains its cursor on a data failure and succeeds when retried', async () => {
    vi.mocked(ensureCandles).mockRejectedValueOnce(new Error('temporary candle failure'));
    await executeLocalJob({ strategy: 'VOLATILITY', settings }, () => undefined, new AbortController().signal);
    const paused = (await loadLocalJob('VOLATILITY'))!;
    expect(paused.status).toBe('PAUSED');
    expect(paused.cursor).toBe(0);
    expect(paused.blockStart).toBe(origin);
    expect(paused.message).toContain('temporary candle failure');
    await executeLocalJob({ strategy: 'VOLATILITY', resumeId: paused.id }, () => undefined, new AbortController().signal);
    expect((await loadLocalJob('VOLATILITY'))?.status).toBe('COMPLETED');
  });

  it('prevents another tab from replacing a running checkpoint', async () => {
    expect(await lease('other-tab')).toBe(true);
    await expect(executeLocalJob({ strategy: 'VOLATILITY', settings }, () => undefined, new AbortController().signal)).rejects.toThrow('다른 탭');
    expect(await readValue('jobs', 'VOLATILITY')).toBeNull();
    await lease('other-tab', true);
  });

  it('does not replace a newer completed job when an old tab tries to resume a stale ID', async () => {
    await executeLocalJob({ strategy: 'VOLATILITY', settings }, () => undefined, new AbortController().signal);
    const before = (await loadLocalJob('VOLATILITY'))!;
    await expect(executeLocalJob({ strategy: 'VOLATILITY', resumeId: 'obsolete-id' }, () => undefined, new AbortController().signal)).rejects.toThrow('이어갈 분석');
    const after = (await loadLocalJob('VOLATILITY'))!;
    expect(after.id).toBe(before.id);
    expect(after.status).toBe('COMPLETED');
    expect(after.result).toEqual(before.result);
  });

  it('resumes an existing 2.10.26 job paused on the CTUSDT listing hour using its cached data', async () => {
    const first = 1790845200;
    const launchAt = 1790844328;
    const october = { ...settings, startDate: '2026-10-01', startTime: '00:00', endDate: '2026-10-04', endTime: '00:00' };
    vi.mocked(listInstruments).mockResolvedValue([{ symbol: 'AAAUSDT', launchAt: origin }, { symbol: 'CTUSDT', launchAt }]);
    const originalLoader = vi.mocked(ensureCandles).getMockImplementation()!;
    vi.mocked(ensureCandles).mockImplementation((instrument, ...args) => {
      if (instrument.symbol === 'CTUSDT') throw new Error('CTUSDT의 2026. 10. 1. 오후 5:00:00 캔들이 누락되었습니다. 다시 이어가 주세요.');
      return originalLoader(instrument, ...args);
    });
    const end = Date.parse('2026-10-04T00:00:00+09:00') / 1000;
    const cached: Candle[] = [];
    for (let at = first; at < end; at += 3600) cached.push({ openTime: at, closeTime: at + 3600, open: 100, high: 102, low: 99, close: 101, volume: 10 });
    await cacheCandles('CTUSDT', '1h', cached);
    await executeLocalJob({ strategy: 'DISPARITY', settings: october }, () => undefined, new AbortController().signal);
    const paused = (await loadLocalJob('DISPARITY'))!;
    expect(paused.version).toBe('2.10.26');
    expect(paused.status).toBe('PAUSED');
    expect(paused.cursor).toBe(1);
    expect(paused.message).toContain('CTUSDT');

    const actual = await vi.importActual<typeof import('./marketData')>('./marketData');
    vi.mocked(ensureCandles).mockImplementation(actual.ensureCandles);
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.searchParams.get('symbol') === 'CTUSDT') {
        expect(Number(url.searchParams.get('start'))).toBe(1790841600000);
        expect(Number(url.searchParams.get('end'))).toBe(first * 1000 - 1);
        return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }));
      }
      throw new Error('prepared symbols must not be downloaded again');
    });
    vi.stubGlobal('fetch', fetcher);
    await executeLocalJob({ strategy: 'DISPARITY', resumeId: paused.id }, () => undefined, new AbortController().signal);
    const resumed = (await loadLocalJob('DISPARITY'))!;
    expect(resumed.id).toBe(paused.id);
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.universeCount).toBe(2);
    expect(resumed.result?.observedBars).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['2.10.26', '2.10.28'])('separates old volatility checkpoints (%s) but preserves other strategy versions and old results', async version => {
    expect(engineVersionFor('PULLBACK')).toBe('2.10.26');
    expect(engineVersionFor('DISPARITY')).toBe('2.10.26');
    expect(engineVersionFor('VOLATILITY')).toBe('2.10.29');
    const controller = new AbortController();
    await executeLocalJob({ strategy: 'VOLATILITY', settings }, view => {
      if (view.blockStart > origin) controller.abort();
    }, controller.signal);
    const header = (await readValue<Record<string, unknown>>('jobs', 'VOLATILITY'))!;
    await writeValue('jobs', 'VOLATILITY', { ...header, version });
    const old = (await loadLocalJob('VOLATILITY'))!;
    expect(old.message).toContain('분석 방식이 변경');
    await expect(executeLocalJob({ strategy: 'VOLATILITY', resumeId: old.id }, () => undefined, new AbortController().signal)).rejects.toThrow('새 분석');
    expect((await loadLocalJob('VOLATILITY'))!.id).toBe(old.id);
    await executeLocalJob({ strategy: 'VOLATILITY', settings }, () => undefined, new AbortController().signal);
    const completed = (await loadLocalJob('VOLATILITY'))!;
    expect(completed.id).not.toBe(old.id);
    expect(await loadLocalResult(completed.id)).not.toBeNull();
  });
});
