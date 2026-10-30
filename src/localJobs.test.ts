import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lease, openCacheDatabase, readValue } from './database';
import { executeLocalJob, loadLocalJob, loadLocalResult, type LocalJobView } from './localJobs';
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
  fullTpWavePercent: '100', minDisparityPercent: '1.0', ma20HalfCloseEnabled: false, roiClosePercent: '100', volatilityK: '0.5',
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
      const spike = Math.round((at - origin) / 3600) % 20 === 10;
      rows.push({ openTime: at, closeTime: at + 3600, open: 100, high: spike ? 103 : 101, low: spike ? 99.5 : 99, close: spike ? 102 : 100, volume: 10 });
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
});
