import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheCandles, openCacheDatabase, readValue, writeValue } from './database';
import { executeEnvelopeBatch, loadEnvelopeBatch, loadEnvelopeBatchHistory, loadEnvelopeBatchReport, saveEnvelopeBatchSelection, validateVirtualSettings, virtualPeriodRelation, type EnvelopeBatchJob } from './envelopeBatch';
import { intervalSeconds } from './api';
import { analysisWindow } from './marketData';
import { currentEnvelopeSettings } from './envelope';
import type { EnvelopeStatisticsRow } from './envelopeStatistics';
import { dailyTrendRows } from './test/envelopeFixtures';
import type { BacktestSettings, Candle } from './types';

const settings: BacktestSettings = currentEnvelopeSettings({ mode: 'ALL', symbol: 'AAA', interval: '15m', side: 'BOTH', startDate: '2026-02-01', startTime: '09:00', endDate: '2026-02-11', endTime: '09:00', initialCapitalUsdt: '101', betAmountUsdt: '100', leverage: '5', partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false });
const evaluation: BacktestSettings = { ...settings, startDate: '2026-03-01', endDate: '2026-03-11', initialCapitalUsdt: '1500', betAmountUsdt: '50', leverage: '3' };
function candles(p: BacktestSettings, interval: BacktestSettings['interval'], slow = false): Candle[] {
  const { start, end } = analysisWindow({ ...p, interval }); const seconds = intervalSeconds(interval);
  const price = (index: number) => [99.76, 100, 100.24, 100][((Math.floor(index / (slow ? 16 : 1)) % 4) + 4) % 4]!;
  return Array.from({ length: (end - start) / seconds + 200 }, (_, i) => ({ openTime: start + (i - 200) * seconds, closeTime: start + (i - 199) * seconds,
    open: i <= 200 ? 100 : price(i - 201), high: i < 200 ? 100 : 100.24, low: i < 200 ? 100 : 99.76, close: i < 200 ? 100 : price(i - 200), volume: 10 }));
}
function lowerCandles(parents: Candle[]): Candle[] {
  const parentSeconds = parents[0]!.closeTime - parents[0]!.openTime; const count = parentSeconds / 900;
  return parents.flatMap(parent => Array.from({ length: count }, (_, index) => {
    const isFirst = index === 0; const isLast = index === count - 1;
    return { openTime: parent.openTime + index * 900, closeTime: parent.openTime + (index + 1) * 900,
      open: parent.open, high: isFirst ? parent.high : isLast ? Math.max(parent.open, parent.close) : parent.open,
      low: isFirst ? parent.low : isLast ? Math.min(parent.open, parent.close) : parent.open,
      close: isLast ? parent.close : parent.open, volume: parent.volume / count };
  }));
}
beforeEach(async () => {
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => { const tx = db.transaction([...db.objectStoreNames], 'readwrite'); for (const name of db.objectStoreNames) tx.objectStore(name).clear(); tx.oncomplete = () => resolve(); });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unseeded public request; no orderbook screening is allowed'); }));
  const instruments = ['AAAUSDT', 'BBBUSDT'].map(symbol => ({ symbol, launchAt: 0 }));
  await writeValue('publicData', 'instruments:ALL', { expiresAt: Date.now() + 300000, data: instruments });
  for (const instrument of instruments) for (const interval of ['1h', '4h', '1d'] as const) {
    await cacheCandles(instrument.symbol, interval, candles(evaluation, interval));
    await cacheCandles(instrument.symbol, interval, candles(settings, interval));
  }
  for (const instrument of instruments) {
    await cacheCandles(instrument.symbol, '15m', lowerCandles(candles(evaluation, '1h')));
    await cacheCandles(instrument.symbol, '15m', lowerCandles(candles(settings, '1h')));
  }
  for (const instrument of instruments) {
    await cacheCandles(instrument.symbol, '1d', dailyTrendRows(evaluation));
    await cacheCandles(instrument.symbol, '1d', dailyTrendRows(settings));
  }
});
afterEach(() => vi.unstubAllGlobals());
function best(side: 'LONG' | 'SHORT'): EnvelopeStatisticsRow {
  return { side, interval: '1h', maPeriod: side === 'LONG' ? 5 : 60, deviationPercent: .2, exitMode: 'OPPOSITE', leverage: 5, profitRatioPercent: 80, winningProfitUsdt: 4, losingLossUsdt: 1,
    returnPercent: 3, profitUsdt: 3.03, realizedProfitUsdt: 3.03, feesUsdt: .5, entryCount: 3, closedTradeCount: 3, winCount: 2, lossCount: 1, winRatePercent: 66.67, maxDrawdownPercent: 1, openPositionCount: 0 };
}
async function sourceReport(): Promise<EnvelopeBatchJob> {
  const source: EnvelopeBatchJob = { id: 'source', version: '2.10.91', kind: 'ALL_STATS', status: 'COMPLETED', updatedAt: Date.now(), message: 'complete', settings,
    universe: ['AAAUSDT', 'BBBUSDT'].map(symbol => ({ symbol, launchAt: 0 })), cursor: 2,
    rows: ['AAAUSDT', 'BBBUSDT'].map(symbol => ({ symbol, launchAt: 0, status: 'OK', best: best('LONG'), bestBySide: { LONG: best('LONG'), SHORT: best('SHORT') } })) };
  await writeValue('results', 'envelope-batch:source', source); return source;
}
describe('fixed-rule all statistics and separate-period virtual evaluation', () => {
  it('optimizes every USDT symbol without orderbook filtering and resumes without duplicating qualified directional settings', async () => {
    const pause = new AbortController();
    await executeEnvelopeBatch({ kind: 'ALL_STATS', settings }, view => { if (view.rows.length === 1) pause.abort(); }, pause.signal);
    const first = (await loadEnvelopeBatch('ALL_STATS'))!; expect(first.status).toBe('PAUSED');
    await executeEnvelopeBatch({ kind: 'ALL_STATS', resumeId: first.id }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('ALL_STATS'))!;
    expect(done.status).toBe('COMPLETED'); expect(done.rows).toHaveLength(2); expect(done.rows[0]).toEqual(first.rows[0]); expect(done.version).toBe('2.10.91');
    expect(done.rows.every(row => row.status === 'NO_TRADES' || row.status === 'NO_QUALIFYING' || row.status === 'OK')).toBe(true);
    expect((await loadEnvelopeBatchHistory('ALL_STATS'))[0]!.optimized).toBeGreaterThanOrEqual(0); expect(fetch).not.toHaveBeenCalled();
  }, 60000);
  it('uses only the selected-period cache and the reduced one-exit case count', async () => {
    const db = await openCacheDatabase();
    await new Promise<void>(resolve => { const tx = db.transaction(['pages', 'pageMetadata'], 'readwrite'); tx.objectStore('pages').clear(); tx.objectStore('pageMetadata').clear(); tx.oncomplete = () => resolve(); });
    for (const symbol of ['AAAUSDT', 'BBBUSDT']) {
      await cacheCandles(symbol, '4h', candles(settings, '4h')); await cacheCandles(symbol, '15m', lowerCandles(candles(settings, '4h'))); await cacheCandles(symbol, '1d', dailyTrendRows(settings));
    }
    await executeEnvelopeBatch({ kind: 'ALL_STATS', settings: { ...settings, envelopeStatisticsInterval: '4h' } }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('ALL_STATS'))!;
    expect(done.status).toBe('COMPLETED'); expect(done.total).toBe(4000); expect(done.completed).toBe(4000);
    expect(done.rows.every(row => row.status === 'NO_TRADES' || row.status === 'NO_QUALIFYING' || row.status === 'OK')).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it('distinguishes trades failing the optimal thresholds from symbols with no trades', async () => {
    await executeEnvelopeBatch({ kind: 'ALL_STATS', settings: { ...settings, initialCapitalUsdt: '1000000', envelopeStatisticsInterval: '1d' } }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('ALL_STATS'))!;
    expect(done.rows.every(row => !row.best && !row.bestBySide?.LONG && !row.bestBySide?.SHORT)).toBe(true);
  });
  it.each(['2.10.42', '2.10.43', '2.10.44', '2.10.46', '2.10.73', '2.10.88'])('preserves %s completed reports but refuses to mix prior trading rules into a new or resumed job', async oldVersion => {
    const old = await sourceReport(); old.version = oldVersion; await writeValue('results', 'envelope-batch:source', old);
    expect((await loadEnvelopeBatchReport(old.id))!.version).toBe(oldVersion);
    await expect(executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: old.id, settings: evaluation }, () => {}, new AbortController().signal)).rejects.toThrow('새 매매 조건');
    const pause = new AbortController(); pause.abort(); await executeEnvelopeBatch({ kind: 'ALL_STATS', settings }, () => {}, pause.signal);
    const header = (await readValue<Record<string, unknown>>('jobs', 'ENVELOPE_BATCH:ALL_STATS'))!;
    await writeValue('jobs', 'ENVELOPE_BATCH:ALL_STATS', { ...header, version: oldVersion });
    const first = (await loadEnvelopeBatch('ALL_STATS'))!;
    await executeEnvelopeBatch({ kind: 'ALL_STATS', resumeId: first.id }, () => {}, new AbortController().signal);
    expect((await loadEnvelopeBatch('ALL_STATS'))!.version).toBe(oldVersion); expect((await loadEnvelopeBatch('ALL_STATS'))!.status).toBe('PAUSED');
  });
  it('requires a current completed source and explicit evaluation settings before any market request', async () => {
    await expect(executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'missing', settings: evaluation }, () => {}, new AbortController().signal)).rejects.toThrow('전체통계');
    await sourceReport(); await expect(executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'source' }, () => {}, new AbortController().signal)).rejects.toThrow('기간·초기자금'); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses another period and newly entered capital, bet and leverage, retaining only saved directional geometry', async () => {
    const source = await sourceReport();
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: source.id, settings: evaluation }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!;
    expect(done.status).toBe('COMPLETED'); expect(done.start).toBe(analysisWindow(evaluation).start); expect(done.end).toBe(analysisWindow(evaluation).end);
    expect(done.settings).toMatchObject({ startDate: '2026-03-01', endDate: '2026-03-11', initialCapitalUsdt: '1500', betAmountUsdt: '50', leverage: '3', envelopeMoveSlOnCenter: false, envelopeExitMode: 'OPPOSITE', envelopeEntryMode: 'BAND_TOUCH' });
    expect(done.result!.initialCapitalUsdt).toBe(1500);
    for (const trade of done.result!.recentTrades) {
      expect(trade.entryAt).toBeGreaterThanOrEqual(done.start!); expect(trade.entryAt).toBeLessThan(done.end!);
      expect(trade.signal.envelopeSourceInterval).toBe('1h'); expect(trade.signal.envelopeMaPeriod).toBe(trade.side === 'LONG' ? 5 : 60);
      expect(trade.signal.envelopeExitMode).toBe('OPPOSITE'); expect(trade.signal.envelopeMoveSlOnCenter).toBe(false);
      expect(['ENVELOPE_OPPOSITE', 'SL']).toContain(trade.reason);
      const fills = trade.executions.filter(fill => fill.kind === 'ENTRY' || fill.kind === 'SPLIT_ENTRY');
      expect(fills[0]!.price * fills[0]!.quantity).toBeCloseTo(50 * 3, 8);
    }
    expect((await readValue('results', 'envelope-batch:source'))!).toEqual(source); expect(done.trainingSettings).toMatchObject(source.settings);
    const history = (await loadEnvelopeBatchHistory('VIRTUAL'))[0]!; expect(history.settings.startDate).toBe('2026-03-01'); expect(history.trainingSettings!.startDate).toBe('2026-02-01'); expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it.each(['LONG', 'SHORT'] as const)('runs virtual evaluation for the selected %s direction only', async side => {
    const source = await sourceReport();
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: source.id, settings: { ...evaluation, side } }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!;
    expect(done.status).toBe('COMPLETED'); expect(done.settings.side).toBe(side);
    expect(done.rows.every(row => Object.keys(row.bestBySide ?? {}).every(value => value === side))).toBe(true);
  }, 30000);
  it('resumes the same evaluation inputs, reclaim state and shared account to identical final results', async () => {
    await sourceReport(); const pause = new AbortController();
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'source', settings: evaluation }, view => { if (view.result?.entryCount) pause.abort(); }, pause.signal);
    const paused = (await loadEnvelopeBatch('VIRTUAL'))!; expect(paused.status).toBe('PAUSED');
    await executeEnvelopeBatch({ kind: 'VIRTUAL', resumeId: paused.id, settings: { ...evaluation, leverage: '20', startDate: '2026-04-01' } }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!; expect(done.status).toBe('COMPLETED'); expect(done.settings.leverage).toBe('3'); expect(done.settings.startDate).toBe('2026-03-01');
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'source', settings: evaluation }, () => {}, new AbortController().signal);
    expect((await loadEnvelopeBatch('VIRTUAL'))!.result).toEqual(done.result); expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it('uses the source period for the evaluation window', async () => {
    const source = await sourceReport(); source.settings = { ...source.settings, envelopeStatisticsInterval: '1h' }; await writeValue('results', 'envelope-batch:source', source);
    const p = { ...evaluation, startTime: '09:17', endTime: '09:17' };
    for (const symbol of ['AAAUSDT', 'BBBUSDT']) { await cacheCandles(symbol, '1h', candles(p, '1h')); await cacheCandles(symbol, '15m', lowerCandles(candles(p, '1h'))); }
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'source', settings: p }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!;
    expect(done.status).toBe('COMPLETED'); expect(done.start).toBe(analysisWindow(p).start); expect(done.end).toBe(analysisWindow(p).end); expect(done.settings.interval).toBe('1h'); expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it('does not reuse non-qualifying saved directions even when they have the largest training return', async () => {
    const source = await sourceReport(); for (const row of source.rows) row.bestBySide!.SHORT = { ...best('SHORT'), returnPercent: 999, entryCount: 1 };
    await writeValue('results', 'envelope-batch:source', source);
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: 'source', settings: evaluation }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!; expect(done.status).toBe('COMPLETED'); expect(done.rows.every(row => !row.bestBySide?.SHORT)).toBe(true);
    expect(done.result!.recentTrades.every(trade => trade.side === 'LONG')).toBe(true);
  }, 30000);
  it('retains losing out-of-sample results instead of filtering them or optimizing the evaluation period again', async () => {
    const source = await sourceReport(); source.rows = source.rows.slice(0, 1); source.universe = source.universe.slice(0, 1); source.rows[0]!.bestBySide = { LONG: best('LONG') };
    await writeValue('results', 'envelope-batch:source', source);
    for (const interval of ['15m', '1h'] as const) {
      const { start, end } = analysisWindow({ ...evaluation, interval }); const seconds = intervalSeconds(interval);
      await cacheCandles('AAAUSDT', interval, Array.from({ length: (end - start) / seconds + 200 }, (_, i) => ({
        openTime: start + (i - 200) * seconds, closeTime: start + (i - 199) * seconds, open: i <= 200 ? 100 : 99.6,
        high: i <= 200 ? 100 : 99.85, low: i < 200 ? 100 : 99.5, close: i < 200 ? 100 : 99.6, volume: 10 })));
    }
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: source.id, settings: evaluation }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!;
    expect(done.status).toBe('COMPLETED'); expect(Number.isFinite(done.result!.returnPercent)).toBe(true);
    expect(done.rows[0]!.bestBySide!.LONG).toEqual(source.rows[0]!.bestBySide!.LONG);
    expect((await readValue('results', 'envelope-batch:source'))!).toEqual(source); expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it('validates money fields and labels after-training, overlapping and backward-looking periods truthfully', () => {
    expect(() => validateVirtualSettings(evaluation)).not.toThrow();
    for (const invalid of [{ initialCapitalUsdt: '0' }, { betAmountUsdt: '1501' }, { betAmountUsdt: 'NaN' }, { leverage: '0' }, { leverage: '101' }]) expect(() => validateVirtualSettings({ ...evaluation, ...invalid })).toThrow();
    expect(virtualPeriodRelation(evaluation, settings)).toBe('AFTER'); expect(virtualPeriodRelation(settings, settings)).toBe('OVERLAP');
    expect(virtualPeriodRelation({ ...evaluation, startDate: '2026-01-01', endDate: '2026-01-11' }, settings)).toBe('BEFORE');
  });
  it('refilters a completed ALL report without market requests, and uses the persisted ordering for virtual source selection', async () => {
    const source = await sourceReport();
      const maximumReturn = { ...best('LONG'), returnPercent: 40, winRatePercent: 65, maPeriod: 5 };
    const maximumWin = { ...best('LONG'), returnPercent: 10, winRatePercent: 95, maPeriod: 120 };
    const excluded = { ...best('SHORT'), returnPercent: 999, winRatePercent: 100, profitRatioPercent: 79.9 };
    for (const row of source.rows) {
      row.candidatesKey = `checkpoint:envelope-candidates:source:${row.symbol}`;
      await writeValue('results', row.candidatesKey, [maximumReturn, maximumWin, excluded]);
      row.tradedSides = { LONG: true, SHORT: true };
    }
    await writeValue('results', 'envelope-batch:source', source);
    const options = { minTrades: '2', minReturnPercent: '2', minProfitRatioPercent: '80', sort: 'winRatePercent' as const };
    const selected = await saveEnvelopeBatchSelection(source.id, options);
    expect(selected.rows.every(row => row.best?.maPeriod === 120 && !row.bestBySide?.SHORT)).toBe(true);
    expect((await loadEnvelopeBatchReport(source.id))!.rows).toEqual(selected.rows);
    await executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: source.id, settings: evaluation }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeBatch('VIRTUAL'))!;
    expect(done.status).toBe('COMPLETED'); expect(done.rows.every(row => row.bestBySide?.LONG?.maPeriod === 120 && !row.bestBySide?.SHORT)).toBe(true);
    expect(done.trainingSettings!.envelopeResultOptions).toEqual(options);
    expect((await readValue('results', 'envelope-batch:source'))!).toEqual(source);
    const none = await saveEnvelopeBatchSelection(source.id, { ...options, minTrades: '100' });
    expect(none.rows.every(row => !row.best)).toBe(true);
    await expect(executeEnvelopeBatch({ kind: 'VIRTUAL', sourceId: source.id, settings: evaluation }, () => {}, new AbortController().signal)).rejects.toThrow('최적 세팅이 없습니다');
    const restored = await saveEnvelopeBatchSelection(source.id, { ...options, sort: 'returnPercent' });
    expect(restored.rows.every(row => row.best?.maPeriod === 5)).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it('drops the legacy daily-trend setting without fetching daily candles', async () => {
    const db = await openCacheDatabase();
    await new Promise<void>(resolve => { const tx = db.transaction(['pages', 'pageMetadata'], 'readwrite'); tx.objectStore('pages').clear(); tx.objectStore('pageMetadata').clear(); tx.oncomplete = () => resolve(); });
    for (const symbol of ['AAAUSDT', 'BBBUSDT']) {
      await cacheCandles(symbol, '1h', candles(settings, '1h')); await cacheCandles(symbol, '1h', candles(evaluation, '1h'));
      await cacheCandles(symbol, '15m', lowerCandles(candles(settings, '1h')));
    }
    await executeEnvelopeBatch({ kind: 'ALL_STATS', settings: { ...settings, envelopeDailyTrend: false } }, () => {}, new AbortController().signal);
    const source = (await loadEnvelopeBatch('ALL_STATS'))!;
    expect(source.status).toBe('COMPLETED'); expect(source.settings.envelopeDailyTrend).toBeUndefined();
    expect(source.settings.envelopeDailyTrend).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });
});
