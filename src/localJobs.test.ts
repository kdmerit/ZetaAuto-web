import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheCandles, lease, openCacheDatabase, readValue, writeValue } from './database';
import { chartForLocalTrade } from './localBacktest';
import { canResumeLocalJob, engineVersionFor, executeLocalJob, loadLocalJob, loadLocalResult, type LocalJobView } from './localJobs';
import { ensureCandles, instrumentEligibility, listInstruments, MissingCandleError } from './marketData';
import { advanceAtrEnvelope, atrEnvelopeParameters, type AtrEnvelopeState } from './marketIndicators';
import type { BacktestSettings, Candle } from './types';
import { universeRetentionMs, weeklyUniverseDatabaseKey, type WeeklyUniverseSnapshot } from './universeCache';
import { dailyTrendRows, minuteRows } from './test/envelopeFixtures';

vi.mock('./marketData', async importOriginal => {
  const actual = await importOriginal<typeof import('./marketData')>();
  return { ...actual, listInstruments: vi.fn(), instrumentEligibility: vi.fn(), ensureCandles: vi.fn() };
});

const origin = Date.UTC(2026, 0, 1) / 1000;
let activeParentSeconds = 3600;
const settings: BacktestSettings = {
  mode: 'ALL', symbol: 'AAA', interval: '1h', startDate: '2026-01-01', startTime: '09:00', endDate: '2026-01-12', endTime: '05:00',
  initialCapitalUsdt: '250', betAmountUsdt: '100', leverage: '2', side: 'BOTH', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1.0', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1.0',
  volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
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
  vi.mocked(ensureCandles).mockClear(); activeParentSeconds = 3600;
  vi.mocked(ensureCandles).mockImplementation(async (_instrument, interval, from, end) => {
    const step = interval === '1m' ? 60 : interval === '15m' ? 900 : interval === '4h' ? 14400 : interval === '1d' ? 86400 : 3600;
    if (interval !== '15m' && interval !== '1m') activeParentSeconds = step;
    if (interval === '1d') return dailyTrendRows(settings).filter(row => row.openTime >= from && row.openTime < end);
    const rows: Candle[] = [];
    for (let at = from; at < end; at += step) {
      const parentAt = Math.floor((at - origin) / activeParentSeconds) * activeParentSeconds + origin;
      const phase = ((Math.floor((parentAt - origin) / 3600) % 20) + 20) % 20;
      const prices = phase === 8 ? [101, 102, 99, 100] : phase === 9 ? [100, 102, 99, 101]
        : phase === 10 ? [101, 104, 100, 103] : phase === 11 ? [103, 108, 102, 106] : [100, 101, 99, 100];
      const minute = Math.round((at % 3600) / 60);
      const p = interval !== '1m' ? prices : minute === 0 ? [prices[0]!, prices[0]!, prices[2]!, prices[0]!]
        : minute === 1 ? [prices[0]!, prices[1]!, Math.min(prices[0]!, prices[3]!), prices[3]!]
          : [prices[3]!, prices[3]!, prices[3]!, prices[3]!];
      rows.push({ openTime: at, closeTime: at + step, open: p[0]!, high: p[1]!, low: p[2]!, close: p[3]!, volume: 10 });
    }
    return rows;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('durable local analysis', () => {
  it('resumes an envelope breakout across minute-replay blocks with all 245 warmup candles', async () => {
    const seconds = 3600;
    const warmup = 245;
    const entryAt = origin + 24 * seconds;
    const exitAt = entryAt + seconds;
    const input: BacktestSettings = { ...settings, mode: 'SINGLE', side: 'LONG', endDate: '2026-01-02', endTime: '10:00',
      envelopeMaPeriod: '240', envelopeDeviationPercent: '3', envelopeStopLossPercent: '20' };
    const parents: Candle[] = Array.from({ length: warmup + 25 }, (_, index) => {
      const offset = index - warmup;
      const [open, high, low, close] = offset === 23 ? [100, 108, 100, 106] : offset === 24 ? [106, 107, 100, 102] : [100, 100, 100, 100];
      return { openTime: origin + offset * seconds, closeTime: origin + (offset + 1) * seconds,
        open: open!, high: high!, low: low!, close: close!, volume: 1 };
    });
    const minutes = minuteRows(parents.slice(warmup));
    vi.mocked(listInstruments).mockResolvedValue([{ symbol: 'AAAUSDT', launchAt: origin - warmup * seconds }]);
    vi.mocked(instrumentEligibility).mockClear();
    vi.mocked(ensureCandles).mockImplementation(async (_instrument, interval, from, end) =>
      (interval === '1m' ? minutes : parents).filter(candle => candle.openTime >= from && candle.closeTime <= end));

    const pause = new AbortController();
    await executeLocalJob({ strategy: 'ENVELOPE_BREAKOUT', settings: input }, view => {
      if (view.phase === 'DATA' && view.blockStart === entryAt) pause.abort();
    }, pause.signal);
    const paused = (await loadLocalJob('ENVELOPE_BREAKOUT'))!;
    expect(paused).toMatchObject({ status: 'PAUSED', blockStart: entryAt, result: { entryCount: 1, openPositionCount: 1 } });
    expect(canResumeLocalJob(paused)).toBe(true);
    expect(canResumeLocalJob({ ...paused, version: '2.11.3' })).toBe(false);
    expect(vi.mocked(ensureCandles).mock.calls[0]?.slice(1, 4)).toEqual(['1h', origin - warmup * seconds, entryAt]);
    expect(instrumentEligibility).not.toHaveBeenCalled();

    await executeLocalJob({ strategy: 'ENVELOPE_BREAKOUT', resumeId: paused.id }, () => {}, new AbortController().signal);
    const completed = (await loadLocalJob('ENVELOPE_BREAKOUT'))!;
    expect(completed).toMatchObject({ status: 'COMPLETED', result: { exitReasons: { ENVELOPE_BREAKOUT_CLOSE: 1 } } });
    expect(completed.result?.recentTrades[0]).toMatchObject({ entryAt, exitAt });
  });

  it('resumes a held NEW_HIGH short and fetches 15m candles only from the first possible exit', async () => {
    const hour = 3600;
    const entryBar = 127;
    const nextBlockStart = origin + (entryBar + 1) * hour;
    const end = origin + 135 * hour;
    const input: BacktestSettings = { ...settings, mode: 'SINGLE', symbol: 'BTC', side: 'SHORT',
      endDate: '2026-01-07', endTime: '00:00', newHighDailyMa20Enabled: true };
    const instrument = { symbol: 'BTCUSDT', launchAt: origin - 500 * hour };
    vi.mocked(listInstruments).mockResolvedValue([instrument]);
    const parents: Candle[] = [];
    for (let index = -500; index < 135; index += 1) {
      const [open, high, low, close] = index === entryBar - 2 ? [99.25, 102.5, 98, 99]
        : index === entryBar - 1 ? [99, 100, 97, 98]
        : index === entryBar ? [98, 98.5, 92, 93]
        : index === entryBar + 1 ? [91.5, 94, 89, 90]
        : index === entryBar + 2 ? [90, 96, 89.5, 95] : [100, 102, 98, 100];
      const openTime = origin + index * hour;
      parents.push({ openTime, closeTime: openTime + hour, open: open!, high: high!, low: low!, close: close!, volume: index === entryBar ? 50 : 10 });
    }
    const lower = parents.filter(row => row.openTime >= nextBlockStart).flatMap(row => Array.from({ length: 4 }, (_, i) => {
      const openTime = row.openTime + i * 900;
      const prices = i === 0 ? row : { open: row.close, high: row.close, low: row.close, close: row.close };
      return { ...prices, openTime, closeTime: openTime + 900, volume: row.volume / 4 };
    }));
    await cacheCandles(instrument.symbol, '1h', parents);
    await cacheCandles(instrument.symbol, '15m', lower);
    const actual = await vi.importActual<typeof import('./marketData')>('./marketData');
    vi.mocked(ensureCandles).mockImplementation(actual.ensureCandles);
    const fetcher = vi.fn(() => { throw new Error('All candle pages must be read from the cache'); });
    vi.stubGlobal('fetch', fetcher);

    const pause = new AbortController();
    await executeLocalJob({ strategy: 'NEW_HIGH', settings: input }, view => {
      if (view.phase === 'DATA' && view.blockStart === nextBlockStart) pause.abort();
    }, pause.signal);
    const paused = (await loadLocalJob('NEW_HIGH'))!;
    expect(paused).toMatchObject({ status: 'PAUSED', completed: 128, total: 135, result: { entryCount: 1, openPositionCount: 1 } });
    expect(vi.mocked(ensureCandles).mock.calls.map(call => call[1])).toEqual(['1h']);

    await executeLocalJob({ strategy: 'NEW_HIGH', resumeId: paused.id }, () => {}, new AbortController().signal);
    const resumed = (await loadLocalJob('NEW_HIGH'))!;
    expect(resumed).toMatchObject({ id: paused.id, status: 'COMPLETED', completed: 135,
      result: { exitReasons: { NEW_HIGH_PREVIOUS_HIGH_CLOSE: 1 }, lossCount: 1, openPositionCount: 0 } });
    expect(resumed.result?.recentTrades[0]).toMatchObject({ side: 'SHORT', entryAt: nextBlockStart, exitAt: nextBlockStart + 2 * hour });
    expect(vi.mocked(ensureCandles).mock.calls.filter(call => call[1] === '15m').map(call => call.slice(2, 4))).toEqual([[nextBlockStart, end]]);
    expect(fetcher).not.toHaveBeenCalled();

    await executeLocalJob({ strategy: 'NEW_HIGH', settings: input }, () => {}, new AbortController().signal);
    const fresh = (await loadLocalJob('NEW_HIGH'))!;
    expect({ ...fresh.result, localRunId: undefined }).toEqual({ ...resumed.result, localRunId: undefined });
  });

  it.each(['1h', '4h'] as const)('saves and resumes NEW_HIGH %s with ATR/lookback warmup and the original stake', async interval => {
    const input = { ...settings, interval, newHighLookback: '30' };
    const pause = new AbortController();
    await executeLocalJob({ strategy: 'NEW_HIGH', settings: input }, view => { if (view.blockStart > origin && view.phase === 'DATA') pause.abort(); }, pause.signal);
    const paused = (await loadLocalJob('NEW_HIGH'))!;
    const seconds = interval === '1h' ? 3600 : 14400;
    const firstParent = vi.mocked(ensureCandles).mock.calls.find(call => call[1] === interval);
    expect(firstParent?.[2]).toBe(origin - (20 * 86400 + 21 * seconds));
    if (paused.status === 'PAUSED') {
      expect(canResumeLocalJob({ ...paused, version: '2.11.7' })).toBe(false);
      await executeLocalJob({ strategy: 'NEW_HIGH', settings: { ...input, betAmountUsdt: '1' }, resumeId: paused.id }, () => {}, new AbortController().signal);
    }
    const completed = (await loadLocalJob('NEW_HIGH'))!; expect(completed.status).toBe('COMPLETED'); expect(completed.version).toBe('2.11.8');
    expect(canResumeLocalJob({ ...completed, version: '2.10.93' })).toBe(false);
    expect(completed.id).toBe(paused.id); expect(completed.settings.newHighLookback).toBeUndefined(); expect(completed.settings.betAmountUsdt).toBe('100');
    expect(completed.settings.interval).toBe(interval); expect(completed.total).toBe((completed.end - completed.start) / seconds * 2);
    const saved = (await loadLocalResult(completed.id))!; expect(saved.result).toEqual(completed.result);
    await executeLocalJob({ strategy: 'NEW_HIGH', settings: input }, () => {}, new AbortController().signal);
    const whole = (await loadLocalJob('NEW_HIGH'))!;
    expect({ ...whole.result, localRunId: undefined }).toEqual({ ...saved.result, localRunId: undefined });
  });
  it.each(['2.10.36', '2.10.95', '2.10.96'])('preserves an old envelope checkpoint %s but requires a new analysis after the model change', async version => {
    const controller = new AbortController();
    await executeLocalJob({ strategy: 'ENVELOPE', settings }, view => { if (view.blockStart > origin) controller.abort(); }, controller.signal);
    const header = (await readValue<Record<string, unknown>>('jobs', 'ENVELOPE'))!;
    await writeValue('jobs', 'ENVELOPE', { ...header, version });
    const paused = (await loadLocalJob('ENVELOPE'))!; expect(canResumeLocalJob(paused)).toBe(false);
    expect(canResumeLocalJob({ ...paused, settings: { ...settings, envelopeMoveSlOnCenter: true } })).toBe(false);
    await expect(executeLocalJob({ strategy: 'ENVELOPE', resumeId: paused.id }, () => {}, new AbortController().signal)).rejects.toThrow('새 분석');
    expect((await loadLocalJob('ENVELOPE'))!.id).toBe(paused.id);
    await executeLocalJob({ strategy: 'ENVELOPE', settings }, () => {}, new AbortController().signal);
    expect((await loadLocalJob('ENVELOPE'))!.version).toBe('2.10.97');
  });
  it('preserves the selected envelope timeframe and drops the legacy daily filter', async () => {
    for (const mode of ['SINGLE', 'ALL'] as const) for (const envelopeDailyTrend of [true, false]) {
      vi.mocked(ensureCandles).mockClear();
      await executeLocalJob({ strategy: 'ENVELOPE', settings: { ...settings, mode, interval: '4h', envelopeDailyTrend } }, () => {}, new AbortController().signal);
      const done = (await loadLocalJob('ENVELOPE'))!;
      expect(done.status).toBe('COMPLETED'); expect(done.settings.interval).toBe('4h'); expect(done.settings.envelopeDailyTrend).toBeUndefined();
      const intervals = new Set(vi.mocked(ensureCandles).mock.calls.map(call => call[1]));
      expect(intervals).toEqual(new Set(['4h', '1m']));
    }
  });
  it('uses all 240 prior closes from the first analysis candle and the first visible chart candle', async () => {
    const day = 86400;
    const end = origin + 10 * day;
    const chartEnd = origin + 2 * day;
    const chartStart = chartEnd - 300 * day;
    const firstCached = chartStart - 240 * day;
    const rows = Array.from({ length: (end - firstCached) / day }, (_, index): Candle => {
      const openTime = firstCached + index * day;
      const earlierCloses = openTime >= origin - 240 * day && openTime < origin - 200 * day;
      const price = openTime === origin ? 98 : openTime === origin + day ? 108 : earlierCloses ? 112 : 100;
      return { openTime, closeTime: openTime + day, open: price, high: price, low: price, close: price, volume: 1440 };
    });
    vi.mocked(listInstruments).mockResolvedValue([{ symbol: 'BTCUSDT', launchAt: 0 }]);
    const actual = await vi.importActual<typeof import('./marketData')>('./marketData');
    vi.mocked(ensureCandles).mockImplementation(actual.ensureCandles);
    await cacheCandles('BTCUSDT', '1d', rows);
    await cacheCandles('BTCUSDT', '1m', minuteRows(rows.filter(row => row.openTime >= origin && row.openTime < chartEnd)));
    const fetcher = vi.fn(() => { throw new Error('All required candle data is already cached'); });
    vi.stubGlobal('fetch', fetcher);

    await executeLocalJob({ strategy: 'ENVELOPE', settings: {
      ...settings, mode: 'SINGLE', symbol: 'BTC', interval: '1d', side: 'LONG', endDate: '2026-01-11', endTime: '09:00',
      envelopeMaPeriod: '240', envelopeDeviationPercent: '3', envelopeHalfCandleEnabled: false,
    } }, () => {}, new AbortController().signal);
    const completed = (await loadLocalJob('ENVELOPE'))!;
    expect(completed).toMatchObject({ status: 'COMPLETED', settings: { envelopeMaPeriod: '240' }, result: { closedTradeCount: 1 } });
    const trade = completed.result!.recentTrades[0]!;
    expect(trade).toMatchObject({ entryAt: origin, exitAt: origin + day, signal: { envelopeMaPeriod: 240, envelopeCenter: 102 } });
    expect(vi.mocked(ensureCandles).mock.calls.find(call => call[1] === '1d')?.[2]).toBe(origin - 240 * day);

    const chart = await chartForLocalTrade(completed.result!, trade, completed.settings, chartEnd);
    expect(chart.envelope).toMatchObject({ period: 240 });
    expect(chart.envelope?.bands[0]).toMatchObject({ openTime: chartStart, center: 100 });
    expect(chart.envelope?.bands.find(band => band.openTime === origin)?.center).toBe(102);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { mode: 'SINGLE', stopEnabled: true },
    { mode: 'ALL', stopEnabled: true },
    { mode: 'SINGLE', stopEnabled: false },
  ] as const)('resumes $mode ATR envelope with its original seed and stop setting ($stopEnabled)', async ({ mode, stopEnabled }) => {
    const day = 86400;
    const atrEnvelope = { emaPeriod: '120', atrPeriod: '120', atrMultiplier: '1' };
    const input: BacktestSettings = { ...settings, mode, symbol: 'BTC', interval: '1d', side: 'LONG',
      endDate: '2026-01-13', endTime: '09:00', envelopeHalfCandleEnabled: false, atrEnvelope,
      atrEnvelopeStopMultiplier: stopEnabled ? '0.5' : '0' };
    const exitOpen = stopEnabled ? 50 : 140;
    const rows: Candle[] = Array.from({ length: 212 }, (_, index) => {
      const openTime = origin + (index - 200) * day;
      const open = index === 200 ? 70 : index === 201 ? exitOpen : 100;
      return { openTime, closeTime: openTime + day, open, close: open,
        high: index === 0 ? 154 : index >= 200 ? open : 102,
        low: index === 0 ? 84 : index >= 200 ? open : 98, volume: 1440 };
    });
    vi.mocked(listInstruments).mockResolvedValue([{ symbol: 'BTCUSDT', launchAt: 0 }]);
    vi.mocked(ensureCandles).mockImplementation((await vi.importActual<typeof import('./marketData')>('./marketData')).ensureCandles);
    await cacheCandles('BTCUSDT', '1d', rows);
    await cacheCandles('BTCUSDT', '1m', minuteRows(rows.slice(200, 202)));
    const fetcher = vi.fn(() => { throw new Error('All required candle data is already cached'); });
    vi.stubGlobal('fetch', fetcher);

    const pause = new AbortController();
    await executeLocalJob({ strategy: 'ATR_ENVELOPE', settings: input }, view => {
      if (view.phase === 'DATA' && view.blockStart === origin + day) pause.abort();
    }, pause.signal);
    if (!stopEnabled) {
      const legacy = (await readValue<{ settings: BacktestSettings }>('jobs', 'ATR_ENVELOPE'))!;
      delete legacy.settings.atrEnvelopeStopMultiplier;
      await writeValue('jobs', 'ATR_ENVELOPE', legacy);
    }
    const paused = (await loadLocalJob('ATR_ENVELOPE'))!;
    expect(paused).toMatchObject({ status: 'PAUSED', completed: 1, result: { openPositionCount: 1 },
      settings: { atrEnvelopeStopMultiplier: input.atrEnvelopeStopMultiplier } });
    await executeLocalJob({ strategy: 'ATR_ENVELOPE', resumeId: paused.id }, () => {}, new AbortController().signal);
    const resumed = (await loadLocalJob('ATR_ENVELOPE'))!;
    expect(resumed).toMatchObject({ id: paused.id, status: 'COMPLETED', completed: 12, result: {
      entryCount: 1, closedTradeCount: 1, atrEnvelopeSeedFrom: rows[0]!.openTime,
    } });
    const trade = resumed.result!.recentTrades[0]!;
    expect(trade.exitAt).toBe(origin + day);
    expect(trade.reason).toBe(stopEnabled ? 'SL' : 'ENVELOPE_OPPOSITE');
    expect(trade.exitPrice).toBeCloseTo(exitOpen * 0.9998, 10);
    const header = (await readValue<{ snapshotKey: string }>('jobs', 'ATR_ENVELOPE'))!;
    const checkpoint = await readValue<{ atrEnvelopeStates: Record<string, AtrEnvelopeState> }>('results', header.snapshotKey);
    const parameters = atrEnvelopeParameters(atrEnvelope);
    const expected = rows.reduce<AtrEnvelopeState | undefined>((state, row) => advanceAtrEnvelope(state, row, parameters), undefined);
    expect(checkpoint?.atrEnvelopeStates.BTCUSDT).toEqual(expected);

    await executeLocalJob({ strategy: 'ATR_ENVELOPE', settings: input }, () => {}, new AbortController().signal);
    const fresh = (await loadLocalJob('ATR_ENVELOPE'))!;
    expect(fresh).toMatchObject({ status: 'COMPLETED', completed: 12 });
    expect({ ...fresh.result, localRunId: undefined }).toEqual({ ...resumed.result, localRunId: undefined });
    expect(await loadLocalJob('ENVELOPE')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['LONG', 'SHORT'] as const)('replays a wick-only BTC day with close-only %s entry, including saved progress', async side => {
    const day = 86400;
    const wickAt = origin + day;
    const entryBarAt = wickAt + day;
    const exitBarAt = entryBarAt + day;
    const input: BacktestSettings = { ...settings, mode: 'SINGLE', symbol: 'BTC', interval: '1d', side,
      endDate: '2026-01-13', endTime: '09:00', envelopeMaPeriod: '3', envelopeDeviationPercent: '3',
      envelopeCloseOnlyEntryEnabled: true, envelopeTrailingStopEnabled: true, envelopeTrailingStopPercent: '4' };
    const activeDays = new Map([
      [wickAt, { open: 100, high: 100, low: 96, close: 100 }],
      [entryBarAt, { open: 100, high: 100, low: 97, close: 97 }],
      [exitBarAt, { open: 97, high: 104, low: 97, close: 100 }],
    ]);
    const parents: Candle[] = Array.from({ length: 212 }, (_, index) => {
      const openTime = origin + (index - 200) * day;
      const long = activeDays.get(openTime) ?? { open: 100, high: 100, low: 100, close: 100 };
      const prices = side === 'LONG' ? long : { open: 200 - long.open, high: 200 - long.low, low: 200 - long.high, close: 200 - long.close };
      return { openTime, closeTime: openTime + day, volume: 1440, ...prices };
    });
    vi.mocked(listInstruments).mockResolvedValue([{ symbol: 'BTCUSDT', launchAt: 0 }]);
    const actual = await vi.importActual<typeof import('./marketData')>('./marketData');
    vi.mocked(ensureCandles).mockImplementation(actual.ensureCandles);
    await cacheCandles('BTCUSDT', '1d', parents);
    await cacheCandles('BTCUSDT', '1m', minuteRows(parents.filter(bar => bar.openTime === entryBarAt || bar.openTime === exitBarAt)));
    const fetcher = vi.fn(() => { throw new Error('All required candle data is already cached'); });
    vi.stubGlobal('fetch', fetcher);

    const pause = new AbortController();
    await executeLocalJob({ strategy: 'ENVELOPE', settings: input }, view => {
      if (view.phase === 'REPLAY' && view.blockStart === wickAt) pause.abort();
    }, pause.signal);
    const paused = (await loadLocalJob('ENVELOPE'))!;
    expect(paused).toMatchObject({ status: 'PAUSED', blockStart: wickAt, cursor: 1, completed: 2 });
    await executeLocalJob({ strategy: 'ENVELOPE', resumeId: paused.id }, () => {}, new AbortController().signal);
    const resumed = (await loadLocalJob('ENVELOPE'))!;
    expect(resumed).toMatchObject({ id: paused.id, status: 'COMPLETED', completed: 12, message: '분석이 완료되었습니다.' });
    expect(resumed.result?.recentTrades).toMatchObject([{ side, entryAt: exitBarAt, reason: 'TRAILING_STOP' }]);
    expect(vi.mocked(ensureCandles).mock.calls.filter(call => call[1] === '1m').map(call => call[2])).toEqual([entryBarAt, exitBarAt]);

    await executeLocalJob({ strategy: 'ENVELOPE', settings: input }, () => {}, new AbortController().signal);
    const fresh = (await loadLocalJob('ENVELOPE'))!;
    expect(fresh).toMatchObject({ status: 'COMPLETED', completed: 12 });
    expect(fresh.result?.recentTrades).toEqual(resumed.result?.recentTrades);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('restores independent SL and obtains candle-filter history from cached minute data', async () => {
    vi.mocked(ensureCandles).mockClear();
    await executeLocalJob({ strategy: 'ENVELOPE', settings: { ...settings, mode: 'SINGLE', envelopeCandleFilterEnabled: true, envelopeStopLossPercent: '1.5' } }, () => {}, new AbortController().signal);
    const done = (await loadLocalJob('ENVELOPE'))!;
    expect(done.status).toBe('COMPLETED');
    expect(done.settings).toMatchObject({ envelopeCandleFilterEnabled: true, envelopeStopLossPercent: '1.5' });
    const lowerCalls = vi.mocked(ensureCandles).mock.calls.filter(call => call[1] === '1m');
    expect(lowerCalls.length).toBeGreaterThan(0);
    expect(lowerCalls[0]![2] % 86400).toBe(0);
    expect(lowerCalls[0]![2]).toBeLessThan(origin);
    expect(new Set(vi.mocked(ensureCandles).mock.calls.map(call => call[1]))).toEqual(new Set(['1h', '1m']));
  });
  it('reuses one direction-neutral weekly universe across all four strategies and refreshes after seven days', async () => {
    const candidates = ['AAAUSDT', 'ZZZUSDT', 'NONEUSDT'].map(symbol => ({ symbol, launchAt: origin - 200 * 3600 }));
    vi.mocked(listInstruments).mockClear().mockResolvedValue(candidates);
    vi.mocked(instrumentEligibility).mockClear().mockImplementation(async instrument => ({ ...instrument,
      LONG: instrument.symbol === 'AAAUSDT', SHORT: instrument.symbol === 'ZZZUSDT' }));
    const run = async (strategy: 'PULLBACK' | 'DISPARITY' | 'VOLATILITY' | 'ENVELOPE', side: BacktestSettings['side']) => {
      await executeLocalJob({ strategy, settings: { ...settings, side } }, () => undefined, new AbortController().signal);
      const view = (await loadLocalJob(strategy))!; expect(view.status).toBe('COMPLETED'); return view;
    };
    expect((await run('PULLBACK', 'LONG')).universeCount).toBe(1);
    expect((await run('DISPARITY', 'SHORT')).universeCount).toBe(1);
    expect((await run('VOLATILITY', 'BOTH')).universeCount).toBe(2);
    expect((await run('ENVELOPE', 'BOTH')).excludedCount).toBe(1);
    expect(listInstruments).toHaveBeenCalledTimes(1); expect(instrumentEligibility).toHaveBeenCalledTimes(3);
    const snapshot = (await readValue<WeeklyUniverseSnapshot>('publicData', weeklyUniverseDatabaseKey))!;
    expect(snapshot.instruments).toHaveLength(3);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(snapshot.checkedAt + universeRetentionMs);
    const refreshed = await run('PULLBACK', 'BOTH');
    expect(listInstruments).toHaveBeenCalledTimes(2); expect(instrumentEligibility).toHaveBeenCalledTimes(6);
    expect(refreshed.universeCheckedAt).toBe(snapshot.checkedAt + universeRetentionMs);
  });

  it('does not replace the prior complete snapshot when a refresh fails partway', async () => {
    vi.mocked(listInstruments).mockClear(); vi.mocked(instrumentEligibility).mockClear();
    const checkedAt = Date.now() - 8 * 86400_000;
    const previous: WeeklyUniverseSnapshot = { version: 1, checkedAt, expiresAt: checkedAt + universeRetentionMs,
      notionalUsdt: 10000, maxSlippagePercent: 0.5, instruments: [{ symbol: 'OLDUSDT', launchAt: 0, LONG: true, SHORT: true }] };
    await writeValue('publicData', weeklyUniverseDatabaseKey, previous);
    vi.mocked(instrumentEligibility).mockRejectedValueOnce(new Error('temporary orderbook failure'));
    await executeLocalJob({ strategy: 'ENVELOPE', settings }, () => undefined, new AbortController().signal);
    expect((await loadLocalJob('ENVELOPE'))?.status).toBe('PAUSED');
    expect(await readValue('publicData', weeklyUniverseDatabaseKey)).toEqual(previous);
    const paused = (await loadLocalJob('ENVELOPE'))!;
    await executeLocalJob({ strategy: 'ENVELOPE', resumeId: paused.id }, () => undefined, new AbortController().signal);
    expect((await loadLocalJob('ENVELOPE'))?.status).toBe('COMPLETED');
    expect((await readValue<WeeklyUniverseSnapshot>('publicData', weeklyUniverseDatabaseKey))!.checkedAt).toBeGreaterThan(checkedAt);
  });

  it('keeps ALL slippage checks separate and skips them for a single envelope symbol', async () => {
    vi.mocked(listInstruments).mockClear(); vi.mocked(instrumentEligibility).mockClear();
    vi.mocked(ensureCandles).mockRejectedValueOnce(new Error('temporary candle failure'));
    await executeLocalJob({ strategy: 'ENVELOPE', settings }, () => undefined, new AbortController().signal);
    const paused = (await loadLocalJob('ENVELOPE'))!; expect(paused.status).toBe('PAUSED');
    const initialCalls = vi.mocked(instrumentEligibility).mock.calls.length;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 8 * 86400_000);
    await executeLocalJob({ strategy: 'ENVELOPE', resumeId: paused.id }, () => undefined, new AbortController().signal);
    expect(instrumentEligibility).toHaveBeenCalledTimes(initialCalls);
    vi.mocked(listInstruments).mockResolvedValueOnce([{ symbol: 'AAAUSDT', launchAt: origin - 200 * 3600 }]);
    await executeLocalJob({ strategy: 'ENVELOPE', settings: { ...settings, mode: 'SINGLE' } }, () => undefined, new AbortController().signal);
    expect(instrumentEligibility).toHaveBeenCalledTimes(initialCalls);
    expect(listInstruments).toHaveBeenLastCalledWith('AAAUSDT', expect.any(AbortSignal));
    expect((await loadLocalJob('ENVELOPE'))?.excludedCount).toBe(0);
  });
  it('resumes from a committed shared-account block with identical trades and totals', async () => {
    vi.mocked(ensureCandles).mockImplementation(async (_instrument, interval, from, end) => {
      const rows: Candle[] = [];
      const pattern = [
        [110, 111, 109, 110], [110, 111, 109, 110], [110, 111, 109, 110], [110, 111, 109, 110],
        [108.5, 109.5, 108, 109], [107.5, 108.5, 107, 108], [106.5, 107.5, 85, 107], [105.5, 106.5, 105, 106], [104.5, 105.5, 104, 105],
        [108, 130, 90, 120], [120, 125, 115, 121], [121, 123, 94, 95],
      ];
      const step = interval === '15m' ? 900 : interval === '4h' ? 14400 : 3600;
      for (let at = from; at < end; at += step) {
        const phase = ((Math.floor((at - origin) / 3600) % pattern.length) + pattern.length) % pattern.length;
        const prices = pattern[phase]!;
        rows.push({ openTime: at, closeTime: at + step, open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 10 });
      }
      return rows;
    });
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
  it('skips a permanently missing-candle symbol in ALL mode and completes the remaining universe', async () => {
    vi.mocked(listInstruments).mockResolvedValue([
      { symbol: 'DATAUSDT', launchAt: origin - 200 * 3600 },
      { symbol: 'GOODUSDT', launchAt: origin - 200 * 3600 },
    ]);
    const loader = vi.mocked(ensureCandles).getMockImplementation()!;
    vi.mocked(ensureCandles).mockImplementation(async (instrument, ...args) => {
      if (instrument.symbol === 'DATAUSDT') throw new MissingCandleError('DATAUSDT', '1h', origin);
      return loader(instrument, ...args);
    });
    await executeLocalJob({ strategy: 'VOLATILITY', settings }, () => undefined, new AbortController().signal);
    const completed = (await loadLocalJob('VOLATILITY'))!;
    expect(completed.status).toBe('COMPLETED');
    expect(completed.universeCount).toBe(1);
    expect(completed.failedSymbols).toEqual(['DATAUSDT']);
    expect(completed.result?.failedSymbols).toEqual(['DATAUSDT']);
  });
  it('does not request minute ordering data for the selected-timeframe strategy', async () => {
    const snapshot = { ...settings, volatilityTpEnabled: false, volatilityNextCloseEnabled: true };
    await executeLocalJob({ strategy: 'VOLATILITY', settings: snapshot }, () => undefined, new AbortController().signal);
    const finished = (await loadLocalJob('VOLATILITY'))!;
    expect(finished.status).toBe('COMPLETED');
    expect(finished.settings.volatilityTpEnabled).toBe(false); expect(finished.settings.volatilityNextCloseEnabled).toBe(true);
    expect(vi.mocked(ensureCandles).mock.calls.some(call => call[1] === '1m')).toBe(false);
  });

  it('defers volatility 15m requests until a higher-timeframe entry signal exists', async () => {
    const signalAt = origin + 6 * 3600;
    vi.mocked(ensureCandles).mockImplementation(async (_instrument, interval, from, end) => {
      const step = interval === '15m' ? 900 : 3600;
      const rows: Candle[] = [];
      for (let at = from; at < end; at += step) {
        const parentAt = Math.floor(at / 3600) * 3600;
        const prices = parentAt === signalAt ? [100, 111, 89, 110] : [100, 101, 99, 100];
        rows.push({ openTime: at, closeTime: at + step, open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 10 });
      }
      return rows;
    });
    await executeLocalJob({ strategy: 'VOLATILITY', settings }, () => undefined, new AbortController().signal);
    const lowerCalls = vi.mocked(ensureCandles).mock.calls.filter(call => call[1] === '15m');
    expect(lowerCalls.length).toBeGreaterThan(0);
    expect(lowerCalls.every(call => call[2]! >= signalAt + 3600)).toBe(true);
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

  it.each(['2.10.26', '2.10.28', '2.10.29', '2.10.30'])('separates old volatility checkpoints (%s) but preserves other strategy versions and old results', async version => {
    expect(engineVersionFor('PULLBACK')).toBe('2.10.26');
    expect(engineVersionFor('DISPARITY')).toBe('2.10.26');
    expect(engineVersionFor('VOLATILITY')).toBe('2.10.83');
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
