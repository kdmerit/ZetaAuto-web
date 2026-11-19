import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheCandles, openCacheDatabase, writeValue } from './database';
import type { EnvelopeBatchJob } from './envelopeBatch';
import { envelopeOptimizerVersion, type EnvelopeStatisticsJob, type EnvelopeStatisticsRow } from './envelopeStatistics';
import { defaultVerificationResultOptions, emptyVerificationSummary, loadEnvelopeVerification, orderVerificationRows, parseVerificationMonths, planEnvelopeVerification, recordVerificationMonth, verificationRowKey, verificationValue, type VerificationRequest } from './envelopeVerification';
import { executeEnvelopeVerification } from './envelopeVerificationJob';
import { minuteRows } from './test/envelopeFixtures';
import type { BacktestSettings, Candle } from './types';

const at = (date: string, time = '09:00'): number => Date.parse(`${date}T${time}:00+09:00`) / 1000;
const today = at('2026-11-19');
const day = 86400;
const options = { minTrades: '1', minReturnPercent: '0', minProfitRatioPercent: '0', sort: 'returnPercent' } as const;
const settings: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', side: 'LONG', interval: '1d', envelopeStatisticsInterval: '1d',
  startDate: '2026-06-01', startTime: '09:00', endDate: '2026-11-01', endTime: '09:00', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '5',
  partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100',
  minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeMa20Enabled: false, envelopeHalfCandleEnabled: false, envelopeResultOptions: options,
};
const ordinaryRow: EnvelopeStatisticsRow = {
  side: 'LONG', interval: '1d', maPeriod: 1, deviationPercent: 1, stopLossPercent: 0.5, exitMode: 'OPPOSITE', leverage: 5,
  returnPercent: 10, profitUsdt: 100, realizedProfitUsdt: 100, feesUsdt: 1, entryCount: 2,
  closedTradeCount: 2, winCount: 2, lossCount: 0, maxDrawdownPercent: 1, winRatePercent: 100, openPositionCount: 0, profitRatioPercent: 100,
};
const request: VerificationRequest = { source: 'SINGLE_STATS', sourceId: 'single', direction: 'PAST', months: 3, resultOptions: options };

function dailyCandles(start: number, end: number): Candle[] {
  return Array.from({ length: (end - start) / day }, (_, index) => {
    const openTime = start + index * day;
    return { openTime, closeTime: openTime + day, open: 100, high: 100, low: 100, close: 100, volume: 20 };
  });
}

async function saveSingle(rows: EnvelopeStatisticsRow[], launchAt = 0, sourceSettings = settings) {
  const report: EnvelopeStatisticsJob = {
    id: 'single', version: envelopeOptimizerVersion, settings: sourceSettings, status: 'COMPLETED', updatedAt: Date.now(),
    intervalIndex: 1, periodIndex: 0, step: 1, exitIndex: 0, message: '완료', rows, maxSteps: {}, skippedIntervals: {},
    instrument: { symbol: 'BTCUSDT', launchAt, LONG: true, SHORT: true },
  };
  await writeValue('results', 'envelope-statistics:single', report);
}

describe('monthly verification windows and result metrics', () => {
  it('anchors calendar months to the saved day and time in Korea without month-end drift', () => {
    const period = { ...settings, startDate: '2026-05-31', endDate: '2026-08-31', startTime: '13:15', endTime: '23:45' };
    expect(planEnvelopeVerification(period, 'PAST', 2, today, today).windows).toEqual([
      { start: at('2026-04-30', '13:15'), end: at('2026-05-31', '13:15') },
      { start: at('2026-03-31', '13:15'), end: at('2026-04-30', '13:15') },
    ]);
    expect(planEnvelopeVerification(period, 'FUTURE', 3, today, today)).toMatchObject({ limit: 'PRESENT', windows: [
      { start: at('2026-08-31', '23:45'), end: at('2026-09-30', '23:45') },
      { start: at('2026-09-30', '23:45'), end: at('2026-10-31', '23:45') },
    ] });
  });

  it('accepts a larger request and excludes the first month crossing either date limit', () => {
    expect(parseVerificationMonths('120')).toBe(120);
    for (const invalid of ['0', '-1', '1.5', '', 'Infinity']) expect(() => parseVerificationMonths(invalid)).toThrow('1 이상의 정수');
    const past = planEnvelopeVerification(settings, 'PAST', 120, today, today);
    expect(past.limit).toBe('HISTORY');
    expect(past.windows.at(-1)).toEqual({ start: at('2021-12-01'), end: at('2022-01-01') });
    expect(planEnvelopeVerification(settings, 'FUTURE', 24, today, today)).toMatchObject({ limit: 'PRESENT', windows: [] });
  });

  it('counts flat months and compares verification metrics independently of training results', () => {
    const summary = [1200, 900, 1000, 1400].reduce((sum, end) => recordVerificationMonth(sum, 1000, end), emptyVerificationSummary);
    expect(summary).toMatchObject({ months: 4, profitMonths: 2, lossMonths: 1, profitUsdt: 600, lossUsdt: 100 });
    expect(verificationValue(summary, 'flatMonths')).toBe(1);
    expect(verificationValue(summary, 'averageProfit')).toBe(30);
    expect(verificationValue(summary, 'averageLoss')).toBe(10);
    const rows = [{ summary: undefined }, { summary }, { summary: { ...summary, lossUsdt: 0 } }];
    expect(orderVerificationRows(rows, { ...defaultVerificationResultOptions, sortBy: 'lossUsdt', sortOrder: 'LOW', filterBy: 'months', threshold: '4' }, row => row.summary)).toEqual([rows[2], rows[1]]);
  });
});

describe('saved statistics verification', () => {
  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(today * 1000);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('this verification fixture reads cached candles'); }));
    const db = await openCacheDatabase();
    await new Promise<void>(resolve => {
      const tx = db.transaction([...db.objectStoreNames], 'readwrite');
      for (const store of db.objectStoreNames) tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('replays fixed SL values with separate monthly capital and resumes without double-counting', async () => {
    const wideStop = { ...ordinaryRow, stopLossPercent: 5 };
    const noEntry = { ...ordinaryRow, deviationPercent: 9 };
    const excluded = { ...ordinaryRow, maPeriod: 2, entryCount: 0 };
    await saveSingle([ordinaryRow, wideStop, noEntry, excluded], at('2026-03-15'));
    const candles = dailyCandles(at('2026-03-31'), at('2026-06-01')).map(candle => {
      if (candle.openTime === at('2026-04-01')) return { ...candle, open: 98.9, low: 95 };
      if (candle.openTime === at('2026-05-01')) return { ...candle, open: 98.9, low: 98.9, high: 102 };
      return candle;
    });
    await cacheCandles('BTCUSDT', '1d', candles);
    await cacheCandles('BTCUSDT', '1m', minuteRows(candles.slice(1)));
    const abort = new AbortController();
    await executeEnvelopeVerification(request, report => { if (report.completed === 1) abort.abort(); }, abort.signal);
    const paused = (await loadEnvelopeVerification(request))!;
    expect(paused).toMatchObject({ status: 'PAUSED', nextMonth: 1, targetCount: 3 });
    expect(paused.summaries[verificationRowKey('BTCUSDT', ordinaryRow)]).toMatchObject({ months: 1, profitMonths: 1, lossMonths: 0 });

    await executeEnvelopeVerification({ ...request, months: 1, resumeId: paused.id }, () => {}, new AbortController().signal);
    const result = (await loadEnvelopeVerification(request))!;
    const tight = result.summaries[verificationRowKey('BTCUSDT', ordinaryRow)]!;
    expect(result).toMatchObject({ id: paused.id, status: 'COMPLETED', request: { months: 3 }, dataStops: 1, completed: 3 });
    expect(tight).toMatchObject({ months: 2, profitMonths: 1, lossMonths: 1 });
    expect(tight.profitUsdt).toBeGreaterThan(0); expect(tight.lossUsdt).toBeGreaterThan(0);
    expect(result.summaries[verificationRowKey('BTCUSDT', wideStop)]).toMatchObject({ months: 2, profitMonths: 2, lossMonths: 0 });
    expect(result.summaries[verificationRowKey('BTCUSDT', noEntry)]).toMatchObject({ months: 2, profitMonths: 0, lossMonths: 0 });
    expect(result.summaries[verificationRowKey('BTCUSDT', excluded)]).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  }, 20_000);

  it('stops a newly listed symbol per full month and completes other all-statistics settings', async () => {
    const instruments = [{ symbol: 'OLDUSDT', launchAt: 0 }, { symbol: 'NEWUSDT', launchAt: at('2026-05-15') }];
    const winner = { ...ordinaryRow, side: 'SHORT' as const };
    const source: EnvelopeBatchJob = {
      id: 'all', kind: 'ALL_STATS', version: envelopeOptimizerVersion, settings: { ...settings, mode: 'ALL', side: 'BOTH' },
      status: 'COMPLETED', updatedAt: Date.now(), message: '완료', universe: instruments, cursor: 2,
      rows: instruments.map(instrument => ({ ...instrument, status: 'OK', best: winner, bestBySide: { SHORT: winner } })),
    };
    await writeValue('results', 'envelope-batch:all', source);
    await cacheCandles('OLDUSDT', '1d', dailyCandles(at('2026-04-30'), at('2026-06-01')));
    const all: VerificationRequest = { ...request, source: 'ALL_STATS', sourceId: 'all', months: 1 };
    await executeEnvelopeVerification(all, () => {}, new AbortController().signal);
    const result = (await loadEnvelopeVerification(all))!;
    expect(result).toMatchObject({ status: 'COMPLETED', targetCount: 2, dataStops: 1 });
    expect(result.summaries[verificationRowKey('OLDUSDT', winner)]!.months).toBe(1);
    expect(result.summaries[verificationRowKey('NEWUSDT', winner)]!.months).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips market requests when a full month after the saved end is unavailable', async () => {
    await saveSingle([ordinaryRow]);
    const future: VerificationRequest = { ...request, direction: 'FUTURE', months: 24 };
    await executeEnvelopeVerification(future, () => {}, new AbortController().signal);
    expect(await loadEnvelopeVerification(future)).toMatchObject({ status: 'COMPLETED', plan: { windows: [], limit: 'PRESENT' } });
    expect(await loadEnvelopeVerification(request)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
