/** Resumable parameter sweep. Every row uses the same virtual-account replay as ordinary analysis. */
import { intervalSeconds } from './api';
import { deleteValue, lease, maintainCache, readValue, retentionMs, writeValue } from './database';
import { prepareSymbolBlock } from './engine';
import { envelopeExitModes, envelopePeriods } from './envelope';
import { analysisWindow, ensureCandles, instrumentEligibility, listInstruments, type EligibleInstrument } from './marketData';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestInterval, BacktestResult, BacktestSettings, EnvelopeExitMode } from './types';

export const statisticsIntervals: BacktestInterval[] = ['15m', '1h', '4h', '1d'];
const jobKey = 'ENVELOPE_STATISTICS';
const version = '2.10.36';

export interface EnvelopeStatisticsRow {
  interval: BacktestInterval;
  maPeriod: number;
  deviationPercent: number;
  exitMode: EnvelopeExitMode;
  returnPercent: number;
  profitUsdt: number;
  realizedProfitUsdt: number;
  feesUsdt: number;
  entryCount: number;
  closedTradeCount: number;
  winCount: number;
  lossCount: number;
  winRatePercent: number | null;
  maxDrawdownPercent: number;
  openPositionCount: number;
}

export interface EnvelopeStatisticsJob {
  id: string;
  version: string;
  settings: BacktestSettings;
  status: 'RUNNING' | 'PAUSED' | 'COMPLETED';
  intervalIndex: number;
  periodIndex: number;
  step: number;
  exitIndex: number;
  updatedAt: number;
  message: string;
  rows: EnvelopeStatisticsRow[];
  maxSteps: Record<string, number>;
  skippedIntervals: Partial<Record<BacktestInterval, string>>;
  instrument?: EligibleInstrument;
}

export const statisticsTotal = 4 * envelopePeriods.length * 200 * 3;
export const statisticsProgress = (job: EnvelopeStatisticsJob): number => job.status === 'COMPLETED' ? statisticsTotal
  : Math.min(statisticsTotal, (job.intervalIndex * envelopePeriods.length + job.periodIndex) * 600 + (job.step - 1) * 3 + job.exitIndex);

export async function loadEnvelopeStatistics(): Promise<EnvelopeStatisticsJob | null> {
  const job = await readValue<EnvelopeStatisticsJob>('jobs', jobKey);
  if (!job || Date.now() - job.updatedAt > retentionMs || job.version !== version) return null;
  return { ...job, status: job.status === 'RUNNING' ? 'PAUSED' : job.status };
}

function resultRow(result: BacktestResult, interval: BacktestInterval, maPeriod: number, step: number, exitMode: EnvelopeExitMode): EnvelopeStatisticsRow {
  return { interval, maPeriod, deviationPercent: step / 10, exitMode,
    returnPercent: result.returnPercent, profitUsdt: result.finalEquityUsdt - result.initialCapitalUsdt,
    realizedProfitUsdt: result.realizedProfitUsdt, feesUsdt: result.feesUsdt, entryCount: result.entryCount,
    closedTradeCount: result.closedTradeCount, winCount: result.winCount, lossCount: result.lossCount,
    winRatePercent: result.winRatePercent, maxDrawdownPercent: result.maxDrawdownPercent,
    openPositionCount: result.openPositionCount };
}

/** First untouchable offset implies every wider offset is also untouchable; money/position state is irrelevant. */
export function maximumTouchedStep(document: ReturnType<typeof prepareSymbolBlock>): number {
  let maximum = 0;
  for (const bar of document.bars) {
    const band = bar.envelope;
    if (!band) continue;
    if (band.long) maximum = Math.max(maximum, (band.center - bar.candle.low) / band.center * 100);
    if (band.short) maximum = Math.max(maximum, (bar.candle.high - band.center) / band.center * 100);
  }
  return Math.max(0, Math.min(200, Math.floor(maximum * 10 + 1e-8)));
}

const yieldWorker = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

async function execute(
  options: { settings?: BacktestSettings; resumeId?: string },
  publish: (job: EnvelopeStatisticsJob) => void,
  signal: AbortSignal,
  useLease: boolean,
): Promise<void> {
  const owner = crypto.randomUUID();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  let job: EnvelopeStatisticsJob | null = null;
  let savedAt = 0;
  let publishedAt = 0;
  if (useLease && !await lease(owner)) throw new Error('다른 탭에서 분석 중입니다. 먼저 일시정지해 주세요.');
  const checkpoint = async (force = false): Promise<void> => {
    if (!job) return;
    if (leaseLost) throw new Error('다른 탭에서 분석을 시작했습니다. 다시 이어가 주세요.');
    job.updatedAt = Date.now();
    if (force || job.updatedAt - savedAt >= 1000) {
      await writeValue('jobs', jobKey, job);
      savedAt = job.updatedAt;
    }
    if (force || job.updatedAt - publishedAt >= 250) { publish(job); publishedAt = job.updatedAt; }
  };
  try {
    if (useLease) heartbeat = setInterval(() => { void lease(owner).then(held => { leaseLost ||= !held; }).catch(() => { leaseLost = true; }); }, 10_000);
    await maintainCache();
    if (options.resumeId) {
      job = await loadEnvelopeStatistics();
      if (!job || job.id !== options.resumeId || job.status === 'COMPLETED') throw new Error('이어갈 통계분석이 없습니다.');
      job.status = 'RUNNING';
    } else {
      if (!options.settings || options.settings.mode !== 'SINGLE') throw new Error('통계분석은 개별종목에서만 가능합니다.');
      // Freeze "now" once, so every case uses the same requested end time.
      const settings = structuredClone(options.settings);
      if (!settings.endDate) {
        const end = new Date(Date.now() + 9 * 3600_000).toISOString();
        settings.endDate = end.slice(0, 10); settings.endTime = end.slice(11, 16);
      }
      analysisWindow({ ...settings, interval: '15m' });
      job = { id: crypto.randomUUID(), version, settings, status: 'RUNNING', intervalIndex: 0, periodIndex: 0, step: 1,
        exitIndex: 0, updatedAt: Date.now(), message: '통계분석 준비', rows: [], maxSteps: {}, skippedIntervals: {} };
    }
    job.message = '통계분석 준비';
    await checkpoint(true);
    // Even an immediate pause leaves a resumable job instead of a startup AbortError.
    signal.throwIfAborted();
    if (!job.instrument) {
      const symbol = `${job.settings.symbol.replace(/USDT$/i, '').toUpperCase()}USDT`;
      const instrument = (await listInstruments(symbol, signal))[0];
      if (!instrument) throw new Error('분석할 종목을 찾지 못했습니다.');
      job.instrument = await instrumentEligibility(instrument, signal);
      if (job.settings.side === 'LONG' ? !job.instrument.LONG : job.settings.side === 'SHORT' ? !job.instrument.SHORT : !job.instrument.LONG && !job.instrument.SHORT) {
        throw new Error('현재 슬리피지 조건을 통과하지 못한 종목입니다.');
      }
      await checkpoint(true);
    }
    while (job.intervalIndex < statisticsIntervals.length) {
      signal.throwIfAborted();
      const interval = statisticsIntervals[job.intervalIndex]!;
      const settings = { ...job.settings, interval };
      let window: { start: number; end: number };
      try { window = analysisWindow(settings); } catch (error) {
        // The shared input period was validated above; a coarser interval may simply have <10 bars.
        job.skippedIntervals[interval] = error instanceof Error ? error.message : '분석 기간이 부족합니다.';
        job.intervalIndex += 1; job.periodIndex = 0; job.step = 1; job.exitIndex = 0; await checkpoint(true); continue;
      }
      const { start, end } = window;
      const seconds = intervalSeconds(interval);
      job.message = `${interval} 캔들 확인`;
      await checkpoint(true);
      const candles = await ensureCandles(job.instrument, interval, start - 200 * seconds, end, end, signal);
      while (job.periodIndex < envelopePeriods.length) {
        const maPeriod = envelopePeriods[job.periodIndex]!;
        const document = prepareSymbolBlock(job.instrument.symbol, candles, { ...settings, envelopeMaPeriod: String(maPeriod), envelopeDeviationPercent: '0.1' }, 'ENVELOPE', start, end);
        for (const bar of document.bars) if (bar.envelope) {
          bar.envelope.long &&= job.instrument.LONG; bar.envelope.short &&= job.instrument.SHORT;
        }
        const key = `${interval}:${maPeriod}`;
        const maximum = job.maxSteps[key] ?? maximumTouchedStep(document);
        job.maxSteps[key] = maximum;
        while (job.step <= maximum) {
          for (const bar of document.bars) if (bar.envelope) {
            bar.envelope.upper = bar.envelope.center * (1 + job.step / 1000);
            bar.envelope.lower = bar.envelope.center * (1 - job.step / 1000);
          }
          for (; job.exitIndex < envelopeExitModes.length; job.exitIndex += 1) {
            signal.throwIfAborted();
            const exit = envelopeExitModes[job.exitIndex]!;
            const parameters = { ...settings, envelopeMaPeriod: String(maPeriod), envelopeDeviationPercent: (job.step / 10).toFixed(1), envelopeExitMode: exit };
            const state = initialPortfolio(Number(settings.initialCapitalUsdt));
            const label = `${interval} · SMA${maPeriod} · 이격 ${(job.step / 10).toFixed(1)}% · ${job.exitIndex + 1}/3 청산 방식`;
            job.message = label;
            // Keep account state across bounded blocks and allow pause messages between them.
            for (let cursor = 0; cursor < document.bars.length; cursor += 512) {
              signal.throwIfAborted();
              const bars = document.bars.slice(cursor, cursor + 512);
              replayPortfolioBlock(state, [{ symbol: document.symbol, bars }], parameters, bars[0]!.candle.openTime, bars.at(-1)!.candle.closeTime, seconds);
              job.message = `${label} · ${Math.min(cursor + 512, document.bars.length).toLocaleString()}/${document.bars.length.toLocaleString()}봉`;
              await checkpoint();
              await yieldWorker();
            }
            job.rows.push(resultRow(portfolioResult(state, parameters), interval, maPeriod, job.step, exit));
          }
          job.exitIndex = 0;
          // Cursor already identifies the next case before any durable save.
          job.step += 1;
          await checkpoint();
        }
        job.periodIndex += 1; job.step = 1; job.exitIndex = 0;
        await checkpoint(true);
      }
      job.intervalIndex += 1; job.periodIndex = 0;
      await checkpoint(true);
    }
    job.status = 'COMPLETED';
    job.message = `통계분석 완료 · ${job.rows.length.toLocaleString()}개 조건 비교`;
    await checkpoint(true);
    // Last report plus bounded 30-day archives; candle cache follows its own policy.
    const index = await readValue<{ id: string; at: number }[]>('publicData', 'envelope-statistics-index') ?? [];
    const keep = [{ id: job.id, at: job.updatedAt }, ...index.filter(item => item.id !== job!.id)].filter(item => Date.now() - item.at <= retentionMs).slice(0, 20);
    await writeValue('results', `envelope-statistics:${job.id}`, job);
    await writeValue('publicData', 'envelope-statistics-index', keep);
    for (const item of index) if (!keep.some(value => value.id === item.id)) await deleteValue('results', `envelope-statistics:${item.id}`);
  } catch (error) {
    if (!job) throw error;
    job.status = 'PAUSED';
    job.message = signal.aborted ? '통계분석을 일시정지했습니다. 완료한 조건 다음부터 이어갈 수 있습니다.'
      : error instanceof Error ? error.message : '통계분석에 실패했습니다.';
    await checkpoint(true);
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (useLease) await lease(owner, true);
  }
}

export async function executeEnvelopeStatistics(
  options: { settings?: BacktestSettings; resumeId?: string },
  publish: (job: EnvelopeStatisticsJob) => void,
  signal: AbortSignal,
): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('zetaauto-local-analysis', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('다른 탭에서 분석 중입니다. 먼저 일시정지해 주세요.');
      await execute(options, publish, signal, false);
    });
  }
  return execute(options, publish, signal, true);
}
