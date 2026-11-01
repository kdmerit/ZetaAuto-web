/** Resumable parameter sweep. Every row uses the same virtual-account replay as ordinary analysis. */
import { intervalSeconds } from './api';
import { lease, maintainCache, readValue, retentionMs, writeValue } from './database';
import { saveEnvelopeStatisticsHistory } from './envelopeStatisticsHistory';
import { prepareSymbolBlock } from './engine';
import { envelopeExitModes, envelopePeriods } from './envelope';
import { analysisWindow, ensureCandles, instrumentEligibility, listInstruments, type EligibleInstrument } from './marketData';
import type { BacktestInterval, BacktestResult, BacktestSettings, ContractRisk, EnvelopeExitMode } from './types';
import { fixedEnvelopeSettings, replayFixedEnvelope } from './envelopeReplay';

export const statisticsIntervals: BacktestInterval[] = ['15m', '1h', '4h', '1d'];
const jobKey = 'ENVELOPE_STATISTICS';
export const envelopeOptimizerVersion = '2.10.42';
const version = envelopeOptimizerVersion;

export type StatisticsSide = 'LONG' | 'SHORT';
export type DirectionalBests = Partial<Record<StatisticsSide, EnvelopeStatisticsRow | null>>;
export const statisticsSideLabel = (side: StatisticsSide): string => side === 'LONG' ? '롱' : '숏';
export const selectedStatisticsSides = (settings: Pick<BacktestSettings, 'side'>): StatisticsSide[] => settings.side === 'LONG' ? ['LONG'] : settings.side === 'SHORT' ? ['SHORT'] : ['LONG', 'SHORT'];
export const isDirectionalStatisticsVersion = (value: string | undefined): boolean => value === version;
export const isFixedEnvelopeStatisticsVersion = (value: string | undefined): boolean => ['2.10.40', '2.10.41', version].includes(value ?? '');
export function selectedStatisticsIntervals(settings: Pick<BacktestSettings, 'envelopeStatisticsInterval'>): BacktestInterval[] {
  const selected = settings.envelopeStatisticsInterval ?? 'ALL';
  if (selected === 'ALL') return [...statisticsIntervals];
  if (!statisticsIntervals.includes(selected)) throw new Error('통계 분석 주기는 15m·1h·4h·1d·전체 중에서 선택해 주세요.');
  return [selected];
}
export const statisticsIntervalLabel = (settings: Pick<BacktestSettings, 'envelopeStatisticsInterval'>): string => {
  const selected = selectedStatisticsIntervals(settings);
  return selected.length === 4 ? '전체 주기' : selected[0]!;
};
export function statisticsAnalysisWindow(settings: BacktestSettings): { start: number; end: number } {
  try { return analysisWindow({ ...settings, interval: selectedStatisticsIntervals(settings)[0]! }); }
  catch (failure) { throw new Error(`${statisticsIntervalLabel(settings)} 통계: ${failure instanceof Error ? failure.message : '기간을 확인해 주세요.'}`); }
}

export interface EnvelopeStatisticsRow {
  side?: StatisticsSide;
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
  leverage?: number;
}
export function settingsForStatisticsRow(settings: BacktestSettings, row: EnvelopeStatisticsRow, risk?: ContractRisk): BacktestSettings {
  return { ...settings, mode: 'SINGLE', side: row.side ?? settings.side, interval: row.interval,
    envelopeMaPeriod: String(row.maPeriod), envelopeDeviationPercent: row.deviationPercent.toFixed(1), envelopeExitMode: row.exitMode,
    leverage: String(row.leverage ?? settings.leverage), envelopeRisk: risk };
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
  sideIndex?: number;
  updatedAt: number;
  message: string;
  rows: EnvelopeStatisticsRow[];
  maxSteps: Record<string, number>;
  skippedIntervals: Partial<Record<BacktestInterval, string>>;
  instrument?: EligibleInstrument;
  risk?: ContractRisk;
  best?: EnvelopeStatisticsRow | null;
  bestBySide?: DirectionalBests;
  keepRows?: boolean;
}

export const statisticsTotal = 4 * envelopePeriods.length * 200 * 3;
export const statisticsTotalFor = (settings: Pick<BacktestSettings, 'envelopeStatisticsInterval' | 'side'>, calculationVersion = version): number => selectedStatisticsIntervals(settings).length * envelopePeriods.length * 200 * 3 * (isDirectionalStatisticsVersion(calculationVersion) ? selectedStatisticsSides(settings).length : 1);
export const statisticsProgress = (job: EnvelopeStatisticsJob): number => {
  const total = statisticsTotalFor(job.settings, job.version);
  const sides = isDirectionalStatisticsVersion(job.version) ? selectedStatisticsSides(job.settings).length : 1;
  return job.status === 'COMPLETED' ? total : Math.min(total, ((job.intervalIndex * envelopePeriods.length + job.periodIndex) * sides + (job.sideIndex ?? 0)) * 600 + (job.step - 1) * 3 + job.exitIndex);
};

export function canResumeEnvelopeStatistics(job: EnvelopeStatisticsJob): boolean {
  return job.version === version || isFixedEnvelopeStatisticsVersion(job.version) && job.settings.side !== 'BOTH'
    || ['2.10.36', '2.10.38', '2.10.40', '2.10.41'].includes(job.version) && !job.rows.length && !job.best;
}

/** Never relabel combined-direction returns as independently optimized long/short returns. */
export function upgradeEnvelopeStatistics(job: EnvelopeStatisticsJob, input?: BacktestSettings): EnvelopeStatisticsJob {
  if (job.version === version) return job;
  const fixed = isFixedEnvelopeStatisticsVersion(job.version);
  const settings = fixedEnvelopeSettings({ ...job.settings,
    leverage: fixed ? job.settings.leverage : input?.leverage ?? job.settings.leverage,
    envelopeStatisticsInterval: fixed ? job.settings.envelopeStatisticsInterval ?? 'ALL' : input?.envelopeStatisticsInterval ?? 'ALL' });
  if (fixed && settings.side !== 'BOTH') {
    const side = settings.side;
    const rows = job.rows.map(row => ({ ...row, side }));
    const best = job.best ? { ...job.best, side } : rows.reduce<EnvelopeStatisticsRow | null>((best, row) => betterEnvelopeSetting(row, best) ? row : best, null);
    return { ...job, version, settings, rows, best, bestBySide: { [side]: best }, sideIndex: 0,
      maxSteps: Object.fromEntries(Object.entries(job.maxSteps).map(([key, value]) => [`${key}:${side}`, value])), risk: undefined };
  }
  return { ...job, version, settings, intervalIndex: 0, periodIndex: 0, sideIndex: 0, step: 1, exitIndex: 0,
    rows: [], best: null, bestBySide: {}, maxSteps: {}, skippedIntervals: {}, risk: undefined };
}

export async function loadEnvelopeStatistics(): Promise<EnvelopeStatisticsJob | null> {
  const job = await readValue<EnvelopeStatisticsJob>('jobs', jobKey);
  if (!job || Date.now() - job.updatedAt > retentionMs) return null;
  if (job.version !== version && job.status !== 'COMPLETED') return { ...job, status: 'PAUSED', message: canResumeEnvelopeStatistics(job)
    ? '저장한 설정으로 롱·숏 분리 통계를 이어갑니다. 기존 이력은 보존됩니다.'
    : '롱·숏 분리 전 작업입니다. 새 개별통계를 시작해 주세요. 기존 이력은 보존됩니다.' };
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

export function betterEnvelopeSetting(row: EnvelopeStatisticsRow, previous?: EnvelopeStatisticsRow | null): boolean {
  return row.entryCount > 0 && (!previous || row.returnPercent > previous.returnPercent + 1e-9
    || Math.abs(row.returnPercent - previous.returnPercent) <= 1e-9 && row.maxDrawdownPercent < previous.maxDrawdownPercent);
}

/** Shared search for one symbol; ALL callers keep only best, not every parameter row. */
export async function searchEnvelopeInstrument(job: EnvelopeStatisticsJob, checkpoint: (force?: boolean) => Promise<void>, signal: AbortSignal): Promise<void> {
  if (!job.instrument) throw new Error('통계 종목 정보가 없습니다.');
  job.settings = fixedEnvelopeSettings(job.settings);
  delete job.risk;
  const intervals = selectedStatisticsIntervals(job.settings);
  const sides = selectedStatisticsSides(job.settings);
  job.sideIndex ??= 0; job.bestBySide ??= {};
  for (const side of sides) job.bestBySide[side] ??= null;
  while (job.intervalIndex < intervals.length) {
    signal.throwIfAborted();
    const interval = intervals[job.intervalIndex]!;
    const settings = { ...job.settings, interval };
    let window: { start: number; end: number };
    try { window = analysisWindow(settings); } catch (error) {
      job.skippedIntervals[interval] = error instanceof Error ? error.message : '분석 기간이 부족합니다.';
      job.intervalIndex += 1; job.periodIndex = 0; job.sideIndex = 0; job.step = 1; job.exitIndex = 0; await checkpoint(true); continue;
    }
    const { start, end } = window; const seconds = intervalSeconds(interval);
    job.message = `${interval} 캔들 확인`; await checkpoint(true);
    const candles = await ensureCandles(job.instrument, interval, start - 200 * seconds, end, end, signal);
    while (job.periodIndex < envelopePeriods.length) {
      const maPeriod = envelopePeriods[job.periodIndex]!;
      while (job.sideIndex < sides.length) {
        const side: StatisticsSide = sides[job.sideIndex]!;
        const directional = { ...settings, side };
        const document = prepareSymbolBlock(job.instrument.symbol, candles, { ...directional, envelopeMaPeriod: String(maPeriod), envelopeDeviationPercent: '0.1' }, 'ENVELOPE', start, end);
        for (const bar of document.bars) if (bar.envelope) { bar.envelope.long &&= job.instrument.LONG; bar.envelope.short &&= job.instrument.SHORT; }
        const key = `${interval}:${maPeriod}:${side}`;
        const maximum = job.maxSteps[key] ?? maximumTouchedStep(document); job.maxSteps[key] = maximum;
        while (job.step <= maximum) {
          for (const bar of document.bars) if (bar.envelope) { bar.envelope.upper = bar.envelope.center * (1 + job.step / 1000); bar.envelope.lower = bar.envelope.center * (1 - job.step / 1000); }
          for (; job.exitIndex < envelopeExitModes.length; job.exitIndex += 1) {
            signal.throwIfAborted();
            const exit = envelopeExitModes[job.exitIndex]!;
            const parameters = { ...directional, envelopeMaPeriod: String(maPeriod), envelopeDeviationPercent: (job.step / 10).toFixed(1), envelopeExitMode: exit };
            const label = `${statisticsSideLabel(side)} · ${interval} · SMA${maPeriod} · ${(job.step / 10).toFixed(1)}% · ${job.exitIndex + 1}/3 청산`;
            const result = await replayFixedEnvelope(document, parameters, seconds, signal, async phase => { job.message = `${label} · ${phase}`; await checkpoint(); });
            const row = { ...resultRow(result, interval, maPeriod, job.step, exit), side, leverage: Number(parameters.leverage) };
            if (job.keepRows !== false) job.rows.push(row);
            if (betterEnvelopeSetting(row, job.best)) job.best = row;
            if (betterEnvelopeSetting(row, job.bestBySide[side])) job.bestBySide[side] = row;
          }
          job.exitIndex = 0; job.step += 1; await checkpoint();
        }
        job.sideIndex += 1; job.step = 1; job.exitIndex = 0; await checkpoint(true);
      }
      job.sideIndex = 0;
      job.periodIndex += 1; job.step = 1; job.exitIndex = 0; await checkpoint(true);
    }
    job.intervalIndex += 1; job.periodIndex = 0; await checkpoint(true);
  }
}

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
      if (!job || job.id !== options.resumeId || job.status === 'COMPLETED' || !canResumeEnvelopeStatistics(job)) throw new Error('이어갈 개별통계가 없습니다. 이전 방식은 새 개별통계를 시작해 주세요.');
      job = upgradeEnvelopeStatistics(job, options.settings);
      job.status = 'RUNNING';
    } else {
      if (!options.settings || options.settings.mode !== 'SINGLE') throw new Error('개별통계는 개별종목에서만 가능합니다.');
      // Freeze "now" once, so every case uses the same requested end time.
      const settings = { ...fixedEnvelopeSettings(structuredClone(options.settings)), envelopeStatisticsInterval: options.settings.envelopeStatisticsInterval ?? 'ALL' as const };
      if (!settings.endDate) {
        const end = new Date(Date.now() + 9 * 3600_000).toISOString();
        settings.endDate = end.slice(0, 10); settings.endTime = end.slice(11, 16);
      }
      statisticsAnalysisWindow(settings);
      job = { id: crypto.randomUUID(), version, settings, status: 'RUNNING', intervalIndex: 0, periodIndex: 0, step: 1,
        exitIndex: 0, updatedAt: Date.now(), message: '개별통계 준비', rows: [], maxSteps: {}, skippedIntervals: {} };
    }
    job.message = '개별통계 준비';
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
    await searchEnvelopeInstrument(job, checkpoint, signal);
    job.status = 'COMPLETED';
    job.message = `개별통계 완료 · ${job.rows.length.toLocaleString()}개 조건 비교`;
    await saveEnvelopeStatisticsHistory(job);
    await checkpoint(true);
  } catch (error) {
    if (!job) throw error;
    job.status = 'PAUSED';
    job.message = signal.aborted ? '개별통계를 일시정지했습니다. 완료한 조건 다음부터 이어갈 수 있습니다.'
      : error instanceof Error ? error.message : '개별통계에 실패했습니다.';
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
