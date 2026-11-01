import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intervalSeconds } from './api';
import { cacheCandles, deleteValue, openCacheDatabase, readValue, writeValue } from './database';
import { prepareSymbolBlock } from './engine';
import { envelopePeriods } from './envelope';
import { executeEnvelopeStatistics, loadEnvelopeStatistics, statisticsIntervals, statisticsProgress, statisticsTotal, type EnvelopeStatisticsJob } from './envelopeStatistics';
import { analysisWindow } from './marketData';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const settings: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '15m', startDate: '2026-02-01', startTime: '09:00', endDate: '2026-02-13', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', side: 'BOTH', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100',
  minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeDeviationPercent: '0.1', envelopeExitMode: 'CENTER', envelopeMaPeriod: '20',
};

function rows(interval: typeof settings.interval): Candle[] {
  const seconds = intervalSeconds(interval);
  const { start, end } = analysisWindow({ ...settings, interval });
  return Array.from({ length: (end - start) / seconds + 200 }, (_, index) => ({
    openTime: start + (index - 200) * seconds, closeTime: start + (index - 199) * seconds,
    open: 100, high: 100.15, low: 99.85, close: 100, volume: 10,
  }));
}

beforeEach(async () => {
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => {
    const transaction = db.transaction([...db.objectStoreNames], 'readwrite');
    for (const name of db.objectStoreNames) transaction.objectStore(name).clear();
    transaction.oncomplete = () => resolve();
  });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('seeded statistics must not fetch'); }));
  await writeValue('publicData', 'instruments:BTCUSDT', { expiresAt: Date.now() + 300000, data: [{ symbol: 'BTCUSDT', launchAt: 0 }] });
  await writeValue('publicData', 'orderbook:BTCUSDT', { expiresAt: Date.now() + 300000, data: { b: [['99.99', '10000']], a: [['100.01', '10000']] } });
  await writeValue('publicData', 'contract-risk:v1:BTCUSDT', { symbol: 'BTCUSDT', checkedAt: Date.now(), maxLeverage: 3, model: 'ISOLATED_ESTIMATE_V1', tiers: [{ limit: 1000000, maintenanceRate: 0.005, deduction: 0, maxLeverage: 3 }] });
  for (const interval of statisticsIntervals) await cacheCandles('BTCUSDT', interval, rows(interval));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('persisted envelope parameter search', () => {
  it('searches all periods/timeframes/exit modes, skips untouchable wider bands, and matches the ordinary engine', async () => {
    let final: EnvelopeStatisticsJob | null = null;
    await executeEnvelopeStatistics({ settings }, job => { final = structuredClone(job); }, new AbortController().signal);
    const job = final as unknown as EnvelopeStatisticsJob;
    expect(job.status).toBe('COMPLETED'); expect(statisticsProgress(job)).toBe(statisticsTotal); expect(statisticsTotal).toBe(19200);
    expect(job.rows).toHaveLength(4 * 8 * 3);
    expect(new Set(job.rows.map(row => row.maPeriod))).toEqual(new Set(envelopePeriods));
    expect(Object.values(job.maxSteps).every(step => step === 1)).toBe(true);
    const row = job.rows.find(value => value.interval === '1h' && value.maPeriod === 10 && value.exitMode === 'CENTER')!;
    const parameters = { ...settings, interval: '1h' as const, envelopeMaPeriod: '10' };
    const { start, end } = analysisWindow(parameters);
    const document = prepareSymbolBlock('BTCUSDT', rows('1h'), parameters, 'ENVELOPE', start, end);
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], parameters, start, end, 3600);
    const result = portfolioResult(state, parameters);
    expect(row.returnPercent).toBe(result.returnPercent); expect(row.winCount).toBe(result.winCount);
    expect(row.profitUsdt).toBeCloseTo(result.finalEquityUsdt - 1000, 10);
    expect((await loadEnvelopeStatistics())?.rows).toEqual(job.rows);
    expect(await readValue('results', `envelope-statistics:${job.id}`)).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it('resumes a completed-case checkpoint without duplicate rows', async () => {
    const controller = new AbortController();
    await executeEnvelopeStatistics({ settings }, job => {
      if (job.status === 'RUNNING' && job.rows.length >= 3) controller.abort();
    }, controller.signal);
    const paused = (await loadEnvelopeStatistics())!;
    expect(paused.status).toBe('PAUSED'); expect(paused.rows).toHaveLength(3); expect(paused.periodIndex).toBe(1);
    await executeEnvelopeStatistics({ resumeId: paused.id }, () => undefined, new AbortController().signal);
    const done = (await loadEnvelopeStatistics())!;
    expect(done.status).toBe('COMPLETED'); expect(done.id).toBe(paused.id); expect(done.rows).toHaveLength(96);
    expect(new Set(done.rows.map(row => `${row.interval}:${row.maPeriod}:${row.deviationPercent}:${row.exitMode}`)).size).toBe(96);
    expect(done.rows.slice(0, 3)).toEqual(paused.rows);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it('rejects all-symbol search and preserves the prior statistics result', async () => {
    await expect(executeEnvelopeStatistics({ settings: { ...settings, mode: 'ALL' } }, () => undefined, new AbortController().signal)).rejects.toThrow('개별종목');
    expect(await loadEnvelopeStatistics()).toBeNull();
  });
  it('persists a resumable checkpoint even when paused before the first data request', async () => {
    const controller = new AbortController(); controller.abort();
    await executeEnvelopeStatistics({ settings }, () => undefined, controller.signal);
    const job = await loadEnvelopeStatistics();
    expect(job?.status).toBe('PAUSED'); expect(job?.rows).toEqual([]);
    expect(job?.settings.symbol).toBe('BTC'); expect(fetch).not.toHaveBeenCalled();
  });
  it('resumes a v2.10.38 zero-percent job through raw string-flag risk replies without clearing history or changing the job id', async () => {
    const controller = new AbortController(); controller.abort();
    await executeEnvelopeStatistics({ settings }, () => undefined, controller.signal);
    const paused = (await loadEnvelopeStatistics())!;
    await writeValue('jobs', 'ENVELOPE_STATISTICS', { ...paused, message: 'BTCUSDT의 유지증거금·위험한도 자료가 부족합니다. 임의의 LIQ로 계산하지 않습니다.' });
    await deleteValue('publicData', 'contract-risk:v1:BTCUSDT');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({ retCode: 0, result: String(input).includes('instruments-info')
      ? { list: [{ symbol: 'BTCUSDT', leverageFilter: { maxLeverage: '3' } }] }
      : { list: [{ symbol: 'BTCUSDT', riskLimitValue: '1000000', maintenanceMargin: '0.005', initialMargin: '0.333333333333', maxLeverage: '3', mmDeduction: '', isLowestRisk: '1' }] } }))));
    await executeEnvelopeStatistics({ resumeId: paused.id }, () => undefined, new AbortController().signal);
    const done = (await loadEnvelopeStatistics())!;
    expect(done.id).toBe(paused.id); expect(done.version).toBe('2.10.38'); expect(done.status).toBe('COMPLETED');
    expect(done.risk?.tiers[0]!.deduction).toBe(0); expect(done.rows).toHaveLength(96);
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 30000);
});
