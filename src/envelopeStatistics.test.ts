import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intervalSeconds } from './api';
import { cacheCandles, openCacheDatabase, readValue, writeValue } from './database';
import { envelopeOptimizerVersion, executeEnvelopeStatistics, isCurrentEnvelopeStatisticsVersion, loadEnvelopeStatistics, selectedStatisticsIntervals, settingsForStatisticsRow, statisticsAnalysisWindow, statisticsIntervals, statisticsPeriods, statisticsProgress, statisticsTotalFor, usesFiveEnvelopePeriods } from './envelopeStatistics';
import { currentEnvelopeSettings } from './envelope';
import { analysisWindow } from './marketData';
import type { BacktestSettings, Candle } from './types';
import { minuteRows } from './test/envelopeFixtures';

const settings: BacktestSettings = currentEnvelopeSettings({
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', startDate: '2026-02-01', startTime: '09:00', endDate: '2026-02-13', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '5', side: 'BOTH', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100',
  minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeDeviationPercent: '0.1', envelopeExitMode: 'CENTER', envelopeMaPeriod: '20', envelopeDailyTrend: false,
  envelopeResultOptions: { minTrades: '0', minReturnPercent: '-100', minProfitRatioPercent: '0', sort: 'returnPercent' },
});

function rows(interval: BacktestSettings['interval']): Candle[] {
  const seconds = intervalSeconds(interval); const { start, end } = analysisWindow({ ...settings, interval });
  return Array.from({ length: Math.ceil((end - start) / seconds) + 200 }, (_, index) => {
    const phase = (index - 200) % 4;
    const close = phase === 0 ? 99.76 : phase === 1 ? 100 : phase === 2 ? 100.24 : 100;
    return { openTime: start + (index - 200) * seconds, closeTime: start + (index - 199) * seconds,
      open: index < 200 ? 100 : close, high: index < 200 ? 100 : Math.max(close, 100.24), low: index < 200 ? 100 : Math.min(close, 99.76), close: index < 200 ? 100 : close, volume: 10 };
  });
}

function lowerRows(interval: BacktestSettings['interval']): Candle[] {
  return minuteRows(rows(interval).slice(200));
}

async function clearDatabase(): Promise<void> {
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => { const tx = db.transaction([...db.objectStoreNames], 'readwrite'); for (const name of db.objectStoreNames) tx.objectStore(name).clear(); tx.oncomplete = () => resolve(); });
}

beforeEach(async () => {
  await clearDatabase();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('seeded statistics must not fetch'); }));
  await writeValue('publicData', 'instruments:BTCUSDT', { expiresAt: Date.now() + 300000, data: [{ symbol: 'BTCUSDT', launchAt: 0 }] });
  await writeValue('publicData', 'orderbook:BTCUSDT', { expiresAt: Date.now() + 300000, data: { b: [['99.99', '10000']], a: [['100.01', '10000']] } });
});
afterEach(() => vi.unstubAllGlobals());

describe('envelope breakout statistics', () => {
  it.each(['2.10.92', '2.10.97'])('keeps the five-center grid for version %s', version => {
    expect(isCurrentEnvelopeStatisticsVersion(version)).toBe(false);
    expect(usesFiveEnvelopePeriods(version)).toBe(true);
    expect(statisticsTotalFor(settings, version)).toBe(2000);
  });
  it('counts 10 centers × 100 deviations × 100 stops for each direction', () => {
    expect(statisticsPeriods(envelopeOptimizerVersion)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(statisticsTotalFor({ ...settings, side: 'LONG' })).toBe(100_000);
    expect(statisticsTotalFor(settings)).toBe(200_000);
  });
  it('offers only 1h, 4h and 1d and uses the selected period for validation', () => {
    expect(statisticsIntervals).toEqual(['1h', '4h', '1d']);
    expect(selectedStatisticsIntervals({ envelopeStatisticsInterval: '4h' })).toEqual(['4h']);
    expect(selectedStatisticsIntervals({ envelopeStatisticsInterval: 'ALL' })).toEqual(['1h', '4h', '1d']);
    expect(statisticsAnalysisWindow({ ...settings, envelopeStatisticsInterval: '4h' }).end - statisticsAnalysisWindow({ ...settings, envelopeStatisticsInterval: '4h' }).start).toBe(12 * 86400);
    expect(() => selectedStatisticsIntervals({ envelopeStatisticsInterval: '30m' } as unknown as BacktestSettings)).toThrow('통계 분석 주기');
  });

  it('simulates and restores every stop step independently of the saved manual SL', async () => {
    const candles = rows('1h').slice(0, 210).map((row, index) => index === 200
      ? { ...row, open: 99.9, low: 99.75, high: 100.25, close: 100 }
      : { ...row, open: 100, low: 100, high: 100, close: 100 });
    await cacheCandles('BTCUSDT', '1h', candles);
    await cacheCandles('BTCUSDT', '1m', minuteRows(candles.slice(200)));
    await executeEnvelopeStatistics({ settings: { ...settings, side: 'LONG', endDate: settings.startDate, endTime: '19:00',
      envelopeStatisticsInterval: '1h', envelopeStopLossPercent: 'invalid' } }, () => {}, new AbortController().signal);
    const job = (await loadEnvelopeStatistics())!;
    expect(job.status).toBe('COMPLETED'); expect(job.settings.envelopeStatisticsInterval).toBe('1h');
    expect(job.settings.envelopeStopLossPercent).toBeUndefined();
    expect(job.rows.every(row => row.interval === '1h' && row.exitMode === 'OPPOSITE' && row.leverage === 5)).toBe(true);
    expect([...new Set(job.rows.map(row => row.maPeriod))]).toEqual(statisticsPeriods(envelopeOptimizerVersion));
    expect([...new Set(job.rows.map(row => row.deviationPercent))]).toEqual([0.1, 0.2]);
    const stops = job.rows.filter(row => row.maPeriod === 1 && row.deviationPercent === 0.1);
    expect(stops.map(row => row.stopLossPercent)).toEqual(Array.from({ length: 100 }, (_, index) => (index + 1) / 10));
    expect(stops[0]!.returnPercent).toBeLessThan(0);
    expect(stops[99]!.returnPercent).toBeGreaterThan(0);
    expect(settingsForStatisticsRow(job.settings, stops[99]!)).toMatchObject({ envelopeMaPeriod: '1', envelopeDeviationPercent: '0.1', envelopeStopLossPercent: '10.0' });
    expect(statisticsProgress(job)).toBe(statisticsTotalFor(job.settings)); expect(await readValue('results', `envelope-statistics:${job.id}`)).not.toBeNull();
    const paused = { ...job, status: 'PAUSED' as const, intervalIndex: 0, periodIndex: 0, sideIndex: 0, step: 1, stopStep: 2, rows: [stops[0]!], best: null, bestBySide: {} };
    expect(statisticsProgress(paused)).toBe(1);
    await writeValue('jobs', 'ENVELOPE_STATISTICS', paused);
    await executeEnvelopeStatistics({ resumeId: paused.id }, () => {}, new AbortController().signal);
    expect((await loadEnvelopeStatistics())!.rows).toEqual(job.rows);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('loads and searches 4h data rather than forcing hourly candles', async () => {
    await cacheCandles('BTCUSDT', '4h', rows('4h'));
    await cacheCandles('BTCUSDT', '1m', lowerRows('4h'));
    await executeEnvelopeStatistics({ settings: { ...settings, interval: '4h', envelopeStatisticsInterval: '4h' } }, () => {}, new AbortController().signal);
    const job = (await loadEnvelopeStatistics())!;
    expect(job.status).toBe('COMPLETED'); expect(job.settings.envelopeStatisticsInterval).toBe('4h');
    expect(job.rows.length).toBeGreaterThan(0); expect(job.rows.every(row => row.interval === '4h' && row.exitMode === 'OPPOSITE')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it.each(['LONG', 'SHORT'] as const)('loads minutes before a completed daily %s half-range rejection could hide earlier entries', async side => {
    const exitPrice = side === 'LONG' ? 110 : 90;
    const candles = rows('1d').map((row, index) => {
      if (index < 200) return row;
      if (index === 200) return { ...row, open: 100, high: side === 'LONG' ? 104 : 107, low: side === 'LONG' ? 93 : 96, close: 100 };
      return { ...row, open: exitPrice, high: exitPrice, low: exitPrice, close: exitPrice };
    });
    const path = [[100, 100, 97, 97], [97, 104, 97, 104], [104, 104, 93, 93], [93, 100, 93, 100]];
    const lower = candles.slice(200).flatMap((parent, parentIndex) => Array.from({ length: 96 }, (_, index) => {
      const raw = path[index] ?? [100, 100, 100, 100];
      const prices = parentIndex > 0 ? [exitPrice, exitPrice, exitPrice, exitPrice]
        : side === 'LONG' ? raw : [200 - raw[0]!, 200 - raw[2]!, 200 - raw[1]!, 200 - raw[3]!];
      return { openTime: parent.openTime + index * 900, closeTime: parent.openTime + (index + 1) * 900,
        open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: parent.volume / 96 };
    }));
    await cacheCandles('BTCUSDT', '1d', candles);
    await cacheCandles('BTCUSDT', '1m', minuteRows(lower));
    await executeEnvelopeStatistics({ settings: { ...settings, side, interval: '1d', envelopeStatisticsInterval: '1d' } }, () => {}, new AbortController().signal);
    const job = (await loadEnvelopeStatistics())!;
    expect(job.status).toBe('COMPLETED');
    const threePercent = job.rows.filter(row => row.deviationPercent === 3 && row.stopLossPercent === 3);
    expect(threePercent).toHaveLength(10);
    expect(threePercent.every(row => row.side === side && row.entryCount > 0)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('keeps only the requested direction and normalizes current settings to opposite-band exits', async () => {
    await cacheCandles('BTCUSDT', '1h', rows('1h'));
    await cacheCandles('BTCUSDT', '1m', lowerRows('1h'));
    await executeEnvelopeStatistics({ settings: { ...settings, side: 'SHORT', envelopeExitMode: 'OPPOSITE', envelopeMoveSlOnCenter: true, envelopeStatisticsInterval: '1h' } }, () => {}, new AbortController().signal);
    const job = (await loadEnvelopeStatistics())!;
    expect(job.settings.envelopeExitMode).toBe('OPPOSITE'); expect(job.settings.envelopeMoveSlOnCenter).toBe(false);
    expect(job.rows.every(row => row.side === 'SHORT' && row.exitMode === 'OPPOSITE')).toBe(true);
  }, 30000);

  it('resumes a paused current job without changing the saved period or duplicating rows', async () => {
    await cacheCandles('BTCUSDT', '1h', rows('1h'));
    await cacheCandles('BTCUSDT', '1m', lowerRows('1h'));
    const controller = new AbortController();
    await executeEnvelopeStatistics({ settings: { ...settings, envelopeStatisticsInterval: '1h' } }, job => { if (job.rows.length >= 1) controller.abort(); }, controller.signal);
    const paused = (await loadEnvelopeStatistics())!; expect(paused.status).toBe('PAUSED');
    await executeEnvelopeStatistics({ resumeId: paused.id }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeStatistics())!;
    expect(done.status).toBe('COMPLETED'); expect(done.settings.envelopeStatisticsInterval).toBe('1h');
    expect(new Set(done.rows.map(row => `${row.side}:${row.interval}:${row.maPeriod}:${row.deviationPercent}:${row.stopLossPercent}`)).size).toBe(done.rows.length);
  }, 30000);
});
