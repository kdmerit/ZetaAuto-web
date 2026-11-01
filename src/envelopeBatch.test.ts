import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheCandles, openCacheDatabase, readValue, writeValue } from './database';
import { executeEnvelopeBatch, loadEnvelopeBatch, loadEnvelopeBatchHistory, loadEnvelopeBatchReport, type EnvelopeBatchJob } from './envelopeBatch';
import { intervalSeconds } from './api';
import { analysisWindow } from './marketData';
import { statisticsAnalysisWindow } from './envelopeStatistics';
import type { BacktestSettings } from './types';

const settings: BacktestSettings = { mode: 'ALL', symbol: 'AAA', interval: '15m', side: 'BOTH', startDate: '2026-02-01', startTime: '09:00', endDate: '2026-02-11', endTime: '09:00',
  initialCapitalUsdt: '101', betAmountUsdt: '100', leverage: '5', partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false };

beforeEach(async () => {
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => { const tx = db.transaction([...db.objectStoreNames], 'readwrite'); for (const name of db.objectStoreNames) tx.objectStore(name).clear(); tx.oncomplete = () => resolve(); });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unseeded public request; no orderbook screening is allowed'); }));
  const instruments = ['AAAUSDT', 'BBBUSDT'].map(symbol => ({ symbol, launchAt: 0 }));
  await writeValue('publicData', 'instruments:ALL', { expiresAt: Date.now() + 300000, data: instruments });
  for (const instrument of instruments) {
    for (const interval of ['15m', '1h', '4h', '1d'] as const) {
      const seconds = intervalSeconds(interval); const { start, end } = analysisWindow({ ...settings, interval });
      const rows = Array.from({ length: (end - start) / seconds + 200 }, (_, index) => ({ openTime: start + (index - 200) * seconds, closeTime: start + (index - 199) * seconds, open: 100, high: 100.15, low: 99.85, close: 100, volume: 10 }));
      await cacheCandles(instrument.symbol, interval, rows);
    }
  }
});
afterEach(() => vi.unstubAllGlobals());

async function sourceReport(interval: '15m' | '1h' = '15m', mixed = false): Promise<EnvelopeBatchJob> {
  const source: EnvelopeBatchJob = { id: 'source', version: '2.10.40', kind: 'ALL_STATS', status: 'COMPLETED', updatedAt: Date.now(), message: 'complete', settings,
    universe: ['AAAUSDT', 'BBBUSDT'].map(symbol => ({ symbol, launchAt: 0 })), cursor: 2,
    rows: ['AAAUSDT', 'BBBUSDT'].map((symbol, index) => ({ symbol, launchAt: 0, status: 'OK', best: {
      interval: mixed && index === 1 ? '15m' : interval, maPeriod: 5, deviationPercent: 0.1, exitMode: 'OPPOSITE', leverage: 5, returnPercent: 100,
      profitUsdt: 101, realizedProfitUsdt: 101, feesUsdt: 10, entryCount: 1, closedTradeCount: 1, winCount: 1, lossCount: 0, winRatePercent: 100, maxDrawdownPercent: 0, openPositionCount: 0,
    } })) };
  await writeValue('results', 'envelope-batch:source', source); return source;
}

describe('all-symbol envelope statistics and virtual account', () => {
  it('optimizes every USDT symbol without orderbook filters, saves one best per symbol, and resumes within the same report', async () => {
    const pause = new AbortController();
    await executeEnvelopeBatch({ kind: 'ALL_STATS', settings }, view => { if (view.rows.length === 1 && view.status === 'RUNNING') pause.abort(); }, pause.signal);
    const first = (await loadEnvelopeBatch('ALL_STATS'))!; expect(first.status).toBe('PAUSED'); expect(first.cursor).toBe(1);
    await executeEnvelopeBatch({ kind: 'ALL_STATS', resumeId: first.id }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('ALL_STATS'))!; expect(done.status).toBe('COMPLETED'); expect(done.id).toBe(first.id); expect(done.rows).toHaveLength(2);
    expect(done.rows.every(row => row.status === 'OK' && row.best!.leverage === 5)).toBe(true);
    expect(done.rows.some(row => row.symbol === 'BBBUSDT')).toBe(true);
    expect((await loadEnvelopeBatchHistory('ALL_STATS'))[0]!.optimized).toBe(2);
    expect((await loadEnvelopeBatchReport(done.id))!.rows.every(row => row.risk === undefined)).toBe(true);
    expect((await loadEnvelopeBatchHistory('ALL_STATS'))[0]!.version).toBe('2.10.41');
    expect(fetch).not.toHaveBeenCalled();
  }, 60000);
  it('requires a completed source report before virtual replay', async () => {
    await expect(executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'missing' }, () => {}, new AbortController().signal)).rejects.toThrow('전체통계');
  });
  it('uses one cash pool, preserves parent-bar entry gates, and resumes to identical results', async () => {
    await sourceReport('1h', true); const pause = new AbortController();
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'source' }, view => { if (view.result && view.status === 'RUNNING') pause.abort(); }, pause.signal);
    const paused = (await loadEnvelopeBatch('VIRTUAL'))!; expect(paused.status).toBe('PAUSED');
    const oldHeader = (await readValue<Record<string, unknown>>('jobs', 'ENVELOPE_BATCH:VIRTUAL'))!;
    await writeValue('jobs', 'ENVELOPE_BATCH:VIRTUAL', { ...oldHeader, version: '2.10.40', settings: { ...settings, envelopeStatisticsInterval: undefined } });
    await executeEnvelopeBatch({ kind: 'VIRTUAL', resumeId: paused.id }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!; expect(done.status).toBe('COMPLETED'); expect(done.result!.initialCapitalUsdt).toBe(101);
    expect(done.result!.insufficientFundsCount).toBeGreaterThan(0); expect(done.result!.entryCount).toBeGreaterThan(0);
    const trades = done.result!.recentTrades;
    expect(trades.filter(trade => trade.symbol === 'AAAUSDT').every(trade => trade.signal.envelopeSourceInterval === '1h')).toBe(true);
    expect(done.settings.leverage).toBe('5'); expect((await loadEnvelopeBatchReport(done.id))!.rows.every(row => !row.risk)).toBe(true);
    expect(done.version).toBe('2.10.41');
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'source' }, () => {}, new AbortController().signal);
    expect((await loadEnvelopeBatch('VIRTUAL'))!.result).toEqual(done.result);
    expect(await readValue('results', `envelope-batch:${done.id}`)).not.toBeNull(); expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it('allows at most one entry per selected parent candle even when a 15-minute fill closes early', async () => {
    const source = await sourceReport('1h'); source.rows = source.rows.slice(0, 1); source.universe = source.universe.slice(0, 1);
    await writeValue('results', 'envelope-batch:source', source);
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'source' }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!; expect(done.status).toBe('COMPLETED');
    expect(done.result!.entryCount).toBe(10 * 24); expect(done.result!.closedTradeCount).toBe(10 * 24);
  }, 30000);
  it('keeps old auto-leverage reports readable but does not reuse them as a fixed-leverage virtual source', async () => {
    const old = await sourceReport(); old.version = '2.10.38';
    await writeValue('results', 'envelope-batch:source', old);
    expect((await loadEnvelopeBatchReport('source'))!.version).toBe('2.10.38');
    await expect(executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'source' }, () => {}, new AbortController().signal)).rejects.toThrow('고정 레버리지');
  });
  it('converts an old all-statistics job with no finished symbols to the entered 5x', async () => {
    const controller = new AbortController(); controller.abort();
    await executeEnvelopeBatch({ kind: 'ALL_STATS', settings }, () => {}, controller.signal);
    const paused = (await loadEnvelopeBatch('ALL_STATS'))!;
    const header = (await readValue<Record<string, unknown>>('jobs', 'ENVELOPE_BATCH:ALL_STATS'))!;
    await writeValue('jobs', 'ENVELOPE_BATCH:ALL_STATS', { ...header, version: '2.10.38', settings: { ...settings, leverage: '1' } });
    await executeEnvelopeBatch({ kind: 'ALL_STATS', resumeId: paused.id, settings: { ...settings, envelopeStatisticsInterval: '4h' } }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('ALL_STATS'))!;
    expect(done.id).toBe(paused.id); expect(done.version).toBe('2.10.41'); expect(done.status).toBe('COMPLETED');
    expect(done.settings.leverage).toBe('5'); expect(done.rows.every(row => row.best?.leverage === 5)).toBe(true);
    expect(done.rows.every(row => row.best?.interval === '4h')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  }, 60000);
  it('uses only 4h data and a 4,800-case-per-symbol scale for selected-period all statistics', async () => {
    const db = await openCacheDatabase();
    await new Promise<void>(resolve => { const tx = db.transaction(['pages', 'pageMetadata'], 'readwrite'); tx.objectStore('pages').clear(); tx.objectStore('pageMetadata').clear(); tx.oncomplete = () => resolve(); });
    const selected = { ...settings, envelopeStatisticsInterval: '4h' as const };
    const { start, end } = statisticsAnalysisWindow(selected); const seconds = 14400;
    const rows = Array.from({ length: (end - start) / seconds + 200 }, (_, i) => ({ openTime: start + (i - 200) * seconds,
      closeTime: start + (i - 199) * seconds, open: 100, high: 100.15, low: 99.85, close: 100, volume: 10 }));
    for (const symbol of ['AAAUSDT', 'BBBUSDT']) await cacheCandles(symbol, '4h', rows);
    await executeEnvelopeBatch({ kind: 'ALL_STATS', settings: selected }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('ALL_STATS'))!;
    expect(done.status).toBe('COMPLETED'); expect(done.total).toBe(9600); expect(done.completed).toBe(9600);
    expect(done.rows.every(row => row.best?.interval === '4h' && row.best.leverage === 5)).toBe(true);
    expect(done.settings.envelopeStatisticsInterval).toBe('4h'); expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it('upgrades a partial v2.10.40 whole-period batch without resetting completed symbols', async () => {
    const pause = new AbortController();
    await executeEnvelopeBatch({ kind: 'ALL_STATS', settings }, view => { if (view.rows.length === 1) pause.abort(); }, pause.signal);
    const first = (await loadEnvelopeBatch('ALL_STATS'))!;
    const header = (await readValue<Record<string, unknown>>('jobs', 'ENVELOPE_BATCH:ALL_STATS'))!;
    await writeValue('jobs', 'ENVELOPE_BATCH:ALL_STATS', { ...header, version: '2.10.40', settings: { ...settings, envelopeStatisticsInterval: undefined } });
    await executeEnvelopeBatch({ kind: 'ALL_STATS', resumeId: first.id, settings: { ...settings, envelopeStatisticsInterval: '1h' } }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('ALL_STATS'))!;
    expect(done.id).toBe(first.id); expect(done.rows).toHaveLength(2); expect(done.rows[0]).toEqual(first.rows[0]);
    expect(done.settings.envelopeStatisticsInterval).toBe('ALL'); expect(done.total).toBe(38400); expect(fetch).not.toHaveBeenCalled();
  }, 60000);
  it('aligns a selected-period virtual replay to the same completed parent-period window', async () => {
    const source = await sourceReport('1h');
    source.version = '2.10.41'; source.settings = { ...settings, startTime: '09:17', endTime: '09:17', envelopeStatisticsInterval: '1h' };
    await writeValue('results', 'envelope-batch:source', source);
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: source.id }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!; const expected = statisticsAnalysisWindow(source.settings);
    expect(done.status).toBe('COMPLETED'); expect(done.start).toBe(expected.start); expect(done.end).toBe(expected.end);
    expect(done.settings.envelopeStatisticsInterval).toBe('1h'); expect(fetch).not.toHaveBeenCalled();
  }, 30000);
});
