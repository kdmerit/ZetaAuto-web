/** Resumable parameter sweep. Every row uses the same virtual-account replay as ordinary analysis. */
import { intervalSeconds } from './api';
import { lease, maintainCache, readValue, retentionMs, writeValue } from './database';
import { saveEnvelopeStatisticsHistory } from './envelopeStatisticsHistory';
import { prepareSymbolBlock } from './engine';
import { bandFor, currentEnvelopeSettings, envelopeHalfCandleAllowsEntry, envelopePeriods, legacyEnvelopePeriods, envelopeModelVersion } from './envelope';
import { analysisWindow, ensureCandles, instrumentEligibility, listInstruments, refreshMismatchedLowerTimeframes, type EligibleInstrument } from './marketData';
import type { BacktestInterval, BacktestResult, BacktestSettings, ContractRisk, EnvelopeExitMode } from './types';
import { fixedEnvelopeSettings, replayFixedEnvelope } from './envelopeReplay';
import { betterFilteredEnvelopeSetting, defaultEnvelopeResultOptions, profitRatio, validateEnvelopeResultOptions } from './envelopeResults';
import { validateLowerTimeframeCandles } from './intrabar';

export const statisticsIntervals: BacktestInterval[] = ['1h', '4h', '1d'];
const jobKey = 'ENVELOPE_STATISTICS';
export const envelopeOptimizerVersion = envelopeModelVersion;
const version = envelopeOptimizerVersion;
const previousFixedEntryVersion = '2.10.46';
const previousHalfFilterVersion = '2.10.88';

export type StatisticsSide = 'LONG' | 'SHORT';
export type DirectionalBests = Partial<Record<StatisticsSide, EnvelopeStatisticsRow | null>>;
export const statisticsSideLabel = (side: StatisticsSide): string => side === 'LONG' ? '롱' : '숏';
export const selectedStatisticsSides = (settings: Pick<BacktestSettings, 'side'>): StatisticsSide[] => settings.side === 'LONG' ? ['LONG'] : settings.side === 'SHORT' ? ['SHORT'] : ['LONG', 'SHORT'];
export const isCurrentEnvelopeStatisticsVersion = (value: string | undefined): boolean => value === version;
export const isFilteredEnvelopeStatisticsVersion = (value: string | undefined): boolean => ['2.10.44', previousFixedEntryVersion, '2.10.73', previousHalfFilterVersion].includes(value ?? '') || isCurrentEnvelopeStatisticsVersion(value);
export const isReclaimStatisticsVersion = (value: string | undefined): boolean => value === '2.10.43' || isFilteredEnvelopeStatisticsVersion(value);
export const isDirectionalStatisticsVersion = (value: string | undefined): boolean => value === '2.10.42' || isReclaimStatisticsVersion(value);
export const isFixedEnvelopeStatisticsVersion = (value: string | undefined): boolean => ['2.10.40', '2.10.41', '2.10.42', '2.10.43', '2.10.44', previousFixedEntryVersion, '2.10.73', previousHalfFilterVersion, version].includes(value ?? '');
const usesFiveEnvelopePeriods = (value: string | undefined): boolean => value === previousHalfFilterVersion || isCurrentEnvelopeStatisticsVersion(value);
export const optimalSettingCriteria = '진입 2회 이상 · 승률 60% 이상 · 수익률 2% 이상';
export function qualifiesEnvelopeSetting(row: Pick<EnvelopeStatisticsRow, 'entryCount' | 'winRatePercent' | 'returnPercent'>): boolean {
  return row.entryCount >= 2 && row.winRatePercent !== null && Number.isFinite(row.winRatePercent) && row.winRatePercent >= 60
    && Number.isFinite(row.returnPercent) && row.returnPercent >= 2;
}
export function selectedStatisticsIntervals(settings: Pick<BacktestSettings, 'envelopeStatisticsInterval'>): BacktestInterval[] {
  const selected = settings.envelopeStatisticsInterval ?? 'ALL';
  if (selected === 'ALL') return [...statisticsIntervals];
  // Archived jobs may still contain the removed 15m preference.  Keep those
  // reports readable while all new analysis uses the 1h/4h/1d choices.
  if (selected === '15m') return ['1h'];
  if (!statisticsIntervals.includes(selected)) throw new Error('통계 분석 주기는 1h·4h·1d·전체 중에서 선택해 주세요.');
  return [selected];
}
export const statisticsIntervalLabel = (settings: Pick<BacktestSettings, 'envelopeStatisticsInterval'>): string => {
  const selected = selectedStatisticsIntervals(settings);
  return selected.length === 3 ? '전체 주기' : selected[0]!;
};
export function statisticsAnalysisWindow(settings: BacktestSettings): { start: number; end: number } {
  try {
    const interval = selectedStatisticsIntervals(settings)[0] ?? '1h';
    return analysisWindow({ ...settings, interval });
  }
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
  winningProfitUsdt?: number;
  losingLossUsdt?: number;
  profitRatioPercent?: number | null;
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
  tradedSides?: Partial<Record<StatisticsSide, boolean>>;
  keepRows?: boolean;
}

export const statisticsTotal = statisticsIntervals.length * envelopePeriods.length * 200;
export const statisticsTotalFor = (settings: Pick<BacktestSettings, 'envelopeStatisticsInterval' | 'side'>, calculationVersion = version): number => (isFilteredEnvelopeStatisticsVersion(calculationVersion) ? 1 : selectedStatisticsIntervals(settings).length) * (usesFiveEnvelopePeriods(calculationVersion) ? envelopePeriods.length : legacyEnvelopePeriods.length) * 200 * (isReclaimStatisticsVersion(calculationVersion) ? 1 : 3) * (isDirectionalStatisticsVersion(calculationVersion) ? selectedStatisticsSides(settings).length : 1);
export const statisticsProgress = (job: EnvelopeStatisticsJob): number => {
  const total = statisticsTotalFor(job.settings, job.version);
  const sides = isDirectionalStatisticsVersion(job.version) ? selectedStatisticsSides(job.settings).length : 1;
  const exits = isReclaimStatisticsVersion(job.version) ? 1 : 3;
  const periods = usesFiveEnvelopePeriods(job.version) ? envelopePeriods.length : legacyEnvelopePeriods.length;
  return job.status === 'COMPLETED' ? total : Math.min(total, ((job.intervalIndex * periods + job.periodIndex) * sides + (job.sideIndex ?? 0)) * 200 * exits + (job.step - 1) * exits + job.exitIndex);
};

export function canResumeEnvelopeStatistics(job: EnvelopeStatisticsJob): boolean {
  return job.version === version;
}

export async function loadEnvelopeStatistics(): Promise<EnvelopeStatisticsJob | null> {
  const job = await readValue<EnvelopeStatisticsJob>('jobs', jobKey);
  if (!job || Date.now() - job.updatedAt > retentionMs) return null;
  if (job.version !== version && job.status !== 'COMPLETED') return { ...job, status: 'PAUSED',
    message: '매매 조건과 최적 세팅 기준이 변경되었습니다. 새 개별통계를 시작해 주세요. 기존 이력은 보존됩니다.' };
  return { ...job, status: job.status === 'RUNNING' ? 'PAUSED' : job.status };
}

function resultRow(result: BacktestResult, interval: BacktestInterval, maPeriod: number, step: number, exitMode: EnvelopeExitMode): EnvelopeStatisticsRow {
  return { interval, maPeriod, deviationPercent: step / 10, exitMode,
    returnPercent: result.returnPercent, profitUsdt: result.finalEquityUsdt - result.initialCapitalUsdt,
    realizedProfitUsdt: result.realizedProfitUsdt, feesUsdt: result.feesUsdt, entryCount: result.entryCount,
    closedTradeCount: result.closedTradeCount, winCount: result.winCount, lossCount: result.lossCount,
    winRatePercent: result.winRatePercent, maxDrawdownPercent: result.maxDrawdownPercent,
    openPositionCount: result.openPositionCount, winningProfitUsdt: result.winningProfitUsdt ?? 0, losingLossUsdt: result.losingLossUsdt ?? 0,
    profitRatioPercent: profitRatio(result.winningProfitUsdt ?? 0, result.losingLossUsdt ?? 0) };
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
  return qualifiesEnvelopeSetting(row) && (!previous || row.returnPercent > previous.returnPercent + 1e-9
    || Math.abs(row.returnPercent - previous.returnPercent) <= 1e-9 && row.maxDrawdownPercent < previous.maxDrawdownPercent);
}

/** Shared search for one symbol; ALL callers keep only best, not every parameter row. */
export async function searchEnvelopeInstrument(job: EnvelopeStatisticsJob, checkpoint: (force?: boolean) => Promise<void>, signal: AbortSignal): Promise<void> {
  if (!job.instrument) throw new Error('통계 종목 정보가 없습니다.');
  job.settings = currentEnvelopeSettings(fixedEnvelopeSettings(job.settings));
  validateEnvelopeResultOptions(job.settings.envelopeResultOptions ?? defaultEnvelopeResultOptions);
  delete job.risk;
  const intervals = selectedStatisticsIntervals(job.settings);
  const sides = selectedStatisticsSides(job.settings);
  job.sideIndex ??= 0; job.bestBySide ??= {};
  job.tradedSides ??= {};
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
    let candles = await ensureCandles(job.instrument, interval, start - 200 * seconds, end, end, signal);
    while (job.periodIndex < envelopePeriods.length) {
      const maPeriod = envelopePeriods[job.periodIndex]!;
      while (job.sideIndex < sides.length) {
        const side: StatisticsSide = sides[job.sideIndex]!;
        const directional = { ...settings, side };
        const baseParameters = { ...directional, envelopeMaPeriod: String(maPeriod), envelopeDeviationPercent: '0.1' };
        let document = prepareSymbolBlock(job.instrument.symbol, candles, baseParameters, 'ENVELOPE', start, end);
        for (const bar of document.bars) if (bar.envelope) { bar.envelope.long &&= job.instrument.LONG; bar.envelope.short &&= job.instrument.SHORT; }
        const firstEntryTouch = document.bars.find(bar => {
          const band = bar.envelope;
          if (!band) return false;
          if (directional.side === 'LONG' && !band.long || directional.side === 'SHORT' && !band.short) return false;
          if (directional.envelopeMa20Enabled === true && (bar.ma20 == null || !Number.isFinite(bar.ma20)
            || !(directional.side === 'LONG' ? bar.candle.low > bar.ma20 : bar.candle.high < bar.ma20))) return false;
          if (directional.envelopeMa20BelowEnabled === true && (bar.ma20 == null || !Number.isFinite(bar.ma20)
            || !(directional.side === 'LONG' ? bar.candle.high < bar.ma20 : bar.candle.low > bar.ma20))) return false;
          // A narrow band may fail the half-range filter while a wider one passes.
          // Fetch from the earliest candidate that can pass any tested width;
          // replay applies the actual width's filter separately to every case.
          if (!envelopeHalfCandleAllowsEntry(bar.candle, bandFor(band.center, 20), directional.side, directional.interval)) return false;
          return directional.side === 'LONG' ? bar.candle.low <= band.lower : bar.candle.high >= band.upper;
        });
        if (firstEntryTouch) {
          let lowerCandles = await ensureCandles(job.instrument, '15m', firstEntryTouch.candle.openTime, end, end, signal);
          document = prepareSymbolBlock(job.instrument.symbol, candles, baseParameters, 'ENVELOPE', start, end, undefined, undefined, undefined, undefined, undefined, undefined, lowerCandles);
          for (const bar of document.bars) {
            if (bar.envelope) { bar.envelope.long &&= job.instrument.LONG; bar.envelope.short &&= job.instrument.SHORT; }
          }
          const parents = document.bars.flatMap(bar => bar.envelopeIntrabarCandles ? [bar.candle] : []);
          if (await refreshMismatchedLowerTimeframes(job.instrument, interval, parents, lowerCandles, signal)) {
            candles = await ensureCandles(job.instrument, interval, start - 200 * seconds, end, end, signal);
            lowerCandles = await ensureCandles(job.instrument, '15m', firstEntryTouch.candle.openTime, end, end, signal);
            document = prepareSymbolBlock(job.instrument.symbol, candles, baseParameters, 'ENVELOPE', start, end, undefined, undefined, undefined, undefined, undefined, undefined, lowerCandles);
            for (const bar of document.bars) {
              if (bar.envelope) { bar.envelope.long &&= job.instrument.LONG; bar.envelope.short &&= job.instrument.SHORT; }
            }
          }
          for (const bar of document.bars) {
            if (bar.envelopeIntrabarCandles) validateLowerTimeframeCandles(bar.candle, bar.envelopeIntrabarCandles, 900, '15분봉');
          }
        }
        const key = `${interval}:${maPeriod}:${side}`;
        const maximum = job.maxSteps[key] ?? maximumTouchedStep(document); job.maxSteps[key] = maximum;
        while (job.step <= maximum) {
          for (const bar of document.bars) if (bar.envelope) {
            bar.envelope.upper = bar.envelope.center * (1 + job.step / 1000);
            bar.envelope.lower = bar.envelope.center * (1 - job.step / 1000);
          }
          const exits = ['OPPOSITE'] as const;
          for (; job.exitIndex < exits.length; job.exitIndex += 1) {
            signal.throwIfAborted();
            const exit = exits[job.exitIndex]!;
            const parameters = { ...directional, envelopeMaPeriod: String(maPeriod), envelopeDeviationPercent: (job.step / 10).toFixed(1), envelopeExitMode: exit };
            const label = `${statisticsSideLabel(side)} · ${interval} · SMA${maPeriod} · ${(job.step / 10).toFixed(1)}% · 반대 밴드 청산`;
            const result = await replayFixedEnvelope(document, parameters, seconds, signal, async phase => { job.message = `${label} · ${phase}`; await checkpoint(); });
            const row = { ...resultRow(result, interval, maPeriod, job.step, exit), side, leverage: Number(parameters.leverage) };
            if (job.keepRows !== false) job.rows.push(row);
            if (row.entryCount > 0) job.tradedSides[side] = true;
            if (betterFilteredEnvelopeSetting(row, job.best, job.settings.envelopeResultOptions)) job.best = row;
            if (betterFilteredEnvelopeSetting(row, job.bestBySide[side], job.settings.envelopeResultOptions)) job.bestBySide[side] = row;
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
      job.status = 'RUNNING';
    } else {
      if (!options.settings || options.settings.mode !== 'SINGLE') throw new Error('개별통계는 개별종목에서만 가능합니다.');
      // Freeze "now" once, so every case uses the same requested end time.
      const settings = currentEnvelopeSettings(fixedEnvelopeSettings(structuredClone(options.settings)));
      settings.envelopeResultOptions ??= { ...defaultEnvelopeResultOptions };
      if (!settings.endDate) {
        const end = new Date(Date.now() + 9 * 3600_000).toISOString();
        settings.endDate = end.slice(0, 10); settings.endTime = end.slice(11, 16);
      }
      statisticsAnalysisWindow(settings);
      validateEnvelopeResultOptions(settings.envelopeResultOptions ?? defaultEnvelopeResultOptions);
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
