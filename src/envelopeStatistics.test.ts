import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intervalSeconds } from './api';
import { cacheCandles, openCacheDatabase, readValue, writeValue } from './database';
import { executeEnvelopeStatistics, isCurrentEnvelopeStatisticsVersion, loadEnvelopeStatistics, selectedStatisticsIntervals, statisticsAnalysisWindow, statisticsIntervals, statisticsProgress, statisticsTotalFor, usesFiveEnvelopePeriods, type EnvelopeStatisticsJob } from './envelopeStatistics';
import { currentEnvelopeSettings } from './envelope';
import { analysisWindow } from './marketData';
import type { BacktestSettings, Candle } from './types';

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
  const parents = rows(interval); const parentSeconds = intervalSeconds(interval); const count = parentSeconds / 900;
  return parents.flatMap(parent => Array.from({ length: count }, (_, index) => {
    const isFirst = index === 0; const isLast = index === count - 1;
    return { openTime: parent.openTime + index * 900, closeTime: parent.openTime + (index + 1) * 900,
      open: parent.open, high: isFirst ? parent.high : isLast ? Math.max(parent.open, parent.close) : parent.open,
      low: isFirst ? parent.low : isLast ? Math.min(parent.open, parent.close) : parent.open,
      close: isLast ? parent.close : parent.open, volume: parent.volume / count };
  }));
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
  it('keeps v2.10.92 report totals without treating the body-only engine as current', () => {
    expect(isCurrentEnvelopeStatisticsVersion('2.10.92')).toBe(false);
    expect(usesFiveEnvelopePeriods('2.10.92')).toBe(true);
    expect(statisticsTotalFor(settings, '2.10.92')).toBe(2000);
  });
  it('offers only 1h, 4h and 1d and uses the selected period for validation', () => {
    expect(statisticsIntervals).toEqual(['1h', '4h', '1d']);
    expect(selectedStatisticsIntervals({ envelopeStatisticsInterval: '4h' })).toEqual(['4h']);
    expect(selectedStatisticsIntervals({ envelopeStatisticsInterval: 'ALL' })).toEqual(['1h', '4h', '1d']);
    expect(statisticsAnalysisWindow({ ...settings, envelopeStatisticsInterval: '4h' }).end - statisticsAnalysisWindow({ ...settings, envelopeStatisticsInterval: '4h' }).start).toBe(12 * 86400);
    expect(() => selectedStatisticsIntervals({ envelopeStatisticsInterval: '30m' } as unknown as BacktestSettings)).toThrow('통계 분석 주기');
  });

  it('searches the selected hourly period with one opposite-band exit case', async () => {
    await cacheCandles('BTCUSDT', '1h', rows('1h'));
    await cacheCandles('BTCUSDT', '15m', lowerRows('1h'));
    let final: EnvelopeStatisticsJob | null = null;
    await executeEnvelopeStatistics({ settings: { ...settings, envelopeStatisticsInterval: '1h' } }, job => { final = structuredClone(job); }, new AbortController().signal);
    const job = final as unknown as EnvelopeStatisticsJob;
    expect(job.status).toBe('COMPLETED'); expect(job.settings.envelopeStatisticsInterval).toBe('1h');
    expect(job.rows.length).toBeGreaterThan(0); expect(job.rows.every(row => row.interval === '1h' && row.exitMode === 'OPPOSITE' && row.leverage === 5)).toBe(true);
    expect(statisticsProgress(job)).toBe(statisticsTotalFor(job.settings)); expect(await readValue('results', `envelope-statistics:${job.id}`)).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('loads and searches 4h data rather than forcing hourly candles', async () => {
    await cacheCandles('BTCUSDT', '4h', rows('4h'));
    await cacheCandles('BTCUSDT', '15m', lowerRows('4h'));
    await executeEnvelopeStatistics({ settings: { ...settings, interval: '4h', envelopeStatisticsInterval: '4h' } }, () => {}, new AbortController().signal);
    const job = (await loadEnvelopeStatistics())!;
    expect(job.status).toBe('COMPLETED'); expect(job.settings.envelopeStatisticsInterval).toBe('4h');
    expect(job.rows.length).toBeGreaterThan(0); expect(job.rows.every(row => row.interval === '4h' && row.exitMode === 'OPPOSITE')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it.each(['LONG', 'SHORT'] as const)('loads 15m data for wider daily %s bands even when the 0.1%% half-range filter rejects every candle', async side => {
    const candles = rows('1d').map((row, index) => index < 200 ? row : {
      ...row, open: 100, high: side === 'LONG' ? 104 : 107, low: side === 'LONG' ? 93 : 96, close: 100,
    });
    const path = [[100, 100, 97, 97], [97, 104, 97, 104], [104, 104, 93, 93], [93, 100, 93, 100]];
    const lower = candles.flatMap((parent, parentIndex) => Array.from({ length: 96 }, (_, index) => {
      const raw = parentIndex >= 200 ? path[index] ?? [100, 100, 100, 100] : [100, 100, 100, 100];
      const prices = side === 'LONG' ? raw : [200 - raw[0]!, 200 - raw[2]!, 200 - raw[1]!, 200 - raw[3]!];
      return { openTime: parent.openTime + index * 900, closeTime: parent.openTime + (index + 1) * 900,
        open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: parent.volume / 96 };
    }));
    await cacheCandles('BTCUSDT', '1d', candles);
    await cacheCandles('BTCUSDT', '15m', lower);
    await executeEnvelopeStatistics({ settings: { ...settings, side, interval: '1d', envelopeStatisticsInterval: '1d' } }, () => {}, new AbortController().signal);
    const job = (await loadEnvelopeStatistics())!;
    expect(job.status).toBe('COMPLETED');
    const threePercent = job.rows.filter(row => row.deviationPercent === 3);
    expect(threePercent).toHaveLength(5);
    expect(threePercent.every(row => row.side === side && row.entryCount > 0 && row.winCount > 0 && row.lossCount === 0)).toBe(true);
    expect(job.rows.filter(row => row.deviationPercent === 0.1).every(row => row.entryCount === 0)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('keeps only the requested direction and normalizes current settings to opposite-band exits', async () => {
    await cacheCandles('BTCUSDT', '1h', rows('1h'));
    await cacheCandles('BTCUSDT', '15m', lowerRows('1h'));
    await executeEnvelopeStatistics({ settings: { ...settings, side: 'SHORT', envelopeExitMode: 'OPPOSITE', envelopeMoveSlOnCenter: true, envelopeStatisticsInterval: '1h' } }, () => {}, new AbortController().signal);
    const job = (await loadEnvelopeStatistics())!;
    expect(job.settings.envelopeExitMode).toBe('OPPOSITE'); expect(job.settings.envelopeMoveSlOnCenter).toBe(false);
    expect(job.rows.every(row => row.side === 'SHORT' && row.exitMode === 'OPPOSITE')).toBe(true);
  }, 30000);

  it('resumes a paused current job without changing the saved period or duplicating rows', async () => {
    await cacheCandles('BTCUSDT', '1h', rows('1h'));
    await cacheCandles('BTCUSDT', '15m', lowerRows('1h'));
    const controller = new AbortController();
    await executeEnvelopeStatistics({ settings: { ...settings, envelopeStatisticsInterval: '1h' } }, job => { if (job.rows.length >= 1) controller.abort(); }, controller.signal);
    const paused = (await loadEnvelopeStatistics())!; expect(paused.status).toBe('PAUSED');
    await executeEnvelopeStatistics({ resumeId: paused.id }, () => {}, new AbortController().signal);
    const done = (await loadEnvelopeStatistics())!;
    expect(done.status).toBe('COMPLETED'); expect(done.settings.envelopeStatisticsInterval).toBe('1h');
    expect(new Set(done.rows.map(row => `${row.side}:${row.interval}:${row.maPeriod}:${row.deviationPercent}:${row.exitMode}`)).size).toBe(done.rows.length);
  }, 30000);
});
