/** Resumable parameter sweep. Every row uses the same virtual-account replay as ordinary analysis. */
import { intervalSeconds } from './api';
import { lease, maintainCache, readValue, retentionMs, writeValue } from './database';
import { saveEnvelopeStatisticsHistory } from './envelopeStatisticsHistory';
import { envelopeEntryMayTouch, prepareSymbolBlock } from './engine';
import { bandFor, currentEnvelopeSettings, envelopePeriods, legacyEnvelopePeriods } from './envelope';
import { analysisWindow, ensureCandles, instrumentEligibility, listInstruments, refreshMismatchedLowerTimeframes, type EligibleInstrument } from './marketData';
import type { BacktestInterval, BacktestResult, BacktestSettings, Candle, ContractRisk, EnvelopeExitMode } from './types';
import { fixedEnvelopeSettings, replayFixedEnvelope, validateEnvelopeMinuteRanges } from './envelopeReplay';
import { betterFilteredEnvelopeSetting, defaultEnvelopeResultOptions, profitRatio, validateEnvelopeResultOptions } from './envelopeResults';
import { envelopeCandleDataStart } from './envelopeCandleFilter';

export const statisticsIntervals: BacktestInterval[] = ['1h', '4h', '1d'];
export const statisticsCenterPeriods: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const statisticsCenterRange = `${statisticsCenterPeriods[0]}~${statisticsCenterPeriods.at(-1)}`;
export const statisticsPercentSteps = 100;
export const statisticsPercentRange = `0.1~${(statisticsPercentSteps / 10).toFixed(1)}%`;
const jobKey = 'ENVELOPE_STATISTICS';
export const envelopeOptimizerVersion = '2.11.0';
const version = envelopeOptimizerVersion;
const previousFixedEntryVersion = '2.10.46';
const previousHalfFilterVersion = '2.10.88';
const previousSharedStopVersion = '2.10.89';
const previousCandleFilterVersion = '2.10.91';
const previousBodyFilterVersion = '2.10.92';
const previousWickFilterVersion = '2.10.93';
const previousTrailingStopVersion = '2.10.94';
const previousFourHourWickVersion = '2.10.95';
const previousFixedStopVersion = '2.10.97';

export type StatisticsSide = 'LONG' | 'SHORT';
export type DirectionalBests = Partial<Record<StatisticsSide, EnvelopeStatisticsRow | null>>;
export const statisticsSideLabel = (side: StatisticsSide): string => side === 'LONG' ? '롱' : '숏';
export const selectedStatisticsSides = (settings: Pick<BacktestSettings, 'side'>): StatisticsSide[] => settings.side === 'LONG' ? ['LONG'] : settings.side === 'SHORT' ? ['SHORT'] : ['LONG', 'SHORT'];
export const isCurrentEnvelopeStatisticsVersion = (value: string | undefined): boolean => value === version;
export const usesCurrentEnvelopeExecution = (value: string | undefined): boolean => value === previousFixedStopVersion || isCurrentEnvelopeStatisticsVersion(value);
export const isFilteredEnvelopeStatisticsVersion = (value: string | undefined): boolean => ['2.10.44', previousFixedEntryVersion, '2.10.73', previousHalfFilterVersion, previousSharedStopVersion, previousCandleFilterVersion, previousBodyFilterVersion, previousWickFilterVersion, previousTrailingStopVersion, previousFourHourWickVersion].includes(value ?? '') || usesCurrentEnvelopeExecution(value);
export const isReclaimStatisticsVersion = (value: string | undefined): boolean => value === '2.10.43' || isFilteredEnvelopeStatisticsVersion(value);
export const isDirectionalStatisticsVersion = (value: string | undefined): boolean => value === '2.10.42' || isReclaimStatisticsVersion(value);
export const isFixedEnvelopeStatisticsVersion = (value: string | undefined): boolean => ['2.10.40', '2.10.41', '2.10.42', '2.10.43', '2.10.44', previousFixedEntryVersion, '2.10.73', previousHalfFilterVersion, previousSharedStopVersion, previousCandleFilterVersion, previousBodyFilterVersion, previousWickFilterVersion, previousTrailingStopVersion, previousFourHourWickVersion].includes(value ?? '') || usesCurrentEnvelopeExecution(value);
export const usesFiveEnvelopePeriods = (value: string | undefined): boolean => value === previousHalfFilterVersion || value === previousSharedStopVersion || value === previousCandleFilterVersion || value === previousBodyFilterVersion || value === previousWickFilterVersion || value === previousTrailingStopVersion || value === previousFourHourWickVersion || value === previousFixedStopVersion;
export function statisticsPeriods(calculationVersion: string | undefined): readonly number[] {
  if (isCurrentEnvelopeStatisticsVersion(calculationVersion)) return statisticsCenterPeriods;
  return usesFiveEnvelopePeriods(calculationVersion) ? envelopePeriods : legacyEnvelopePeriods;
}

export function fixedEnvelopeStatisticsSettings(settings: BacktestSettings): BacktestSettings {
  const { envelopeMaPeriod: _period, envelopeDeviationPercent: _deviation, envelopeStopLossPercent: _stop, ...fixed } = currentEnvelopeSettings(settings);
  return fixedEnvelopeSettings(fixed);
}
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
  stopLossPercent?: number;
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
    ...(row.stopLossPercent === undefined ? {} : { envelopeStopLossPercent: row.stopLossPercent.toFixed(1) }),
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
  stopStep?: number;
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
}

function statisticsGrid(settings: Pick<BacktestSettings, 'envelopeStatisticsInterval' | 'side'>, calculationVersion: string) {
  const intervals = isFilteredEnvelopeStatisticsVersion(calculationVersion) ? 1 : selectedStatisticsIntervals(settings).length;
  const periods = statisticsPeriods(calculationVersion).length;
  const sides = isDirectionalStatisticsVersion(calculationVersion) ? selectedStatisticsSides(settings).length : 1;
  const searchesStopLoss = isCurrentEnvelopeStatisticsVersion(calculationVersion);
  const deviations = searchesStopLoss ? statisticsPercentSteps : 200;
  const variants = searchesStopLoss ? statisticsPercentSteps : isReclaimStatisticsVersion(calculationVersion) ? 1 : 3;
  return { periods, sides, deviations, variants, total: intervals * periods * sides * deviations * variants };
}

export function statisticsTotalFor(settings: Pick<BacktestSettings, 'envelopeStatisticsInterval' | 'side'>, calculationVersion = version): number {
  return statisticsGrid(settings, calculationVersion).total;
}

export function statisticsProgress(job: EnvelopeStatisticsJob): number {
  const { total, periods, sides, deviations, variants } = statisticsGrid(job.settings, job.version);
  if (job.status === 'COMPLETED') return total;
  const completedGroups = (job.intervalIndex * periods + job.periodIndex) * sides + (job.sideIndex ?? 0);
  const variantIndex = isCurrentEnvelopeStatisticsVersion(job.version) ? (job.stopStep ?? 1) - 1 : job.exitIndex;
  return Math.min(total, (completedGroups * deviations + job.step - 1) * variants + variantIndex);
}

export function canResumeEnvelopeStatistics(job: EnvelopeStatisticsJob): boolean {
  return job.version === version;
}

export async function loadEnvelopeStatistics(): Promise<EnvelopeStatisticsJob | null> {
  const job = await readValue<EnvelopeStatisticsJob>('jobs', jobKey);
  if (!job || Date.now() - job.updatedAt > retentionMs) return null;
  if (job.version !== version && job.status !== 'COMPLETED') return { ...job, status: 'PAUSED',
    message: '자동 탐색 범위가 변경되었습니다. 새 개별통계를 시작해 주세요. 완료한 이력은 그대로 볼 수 있습니다.' };
  return { ...job, status: job.status === 'RUNNING' ? 'PAUSED' : job.status };
}

function resultRow(result: BacktestResult, interval: BacktestInterval, maPeriod: number, step: number): EnvelopeStatisticsRow {
  return { interval, maPeriod, deviationPercent: step / 10, exitMode: 'OPPOSITE',
    returnPercent: result.returnPercent, profitUsdt: result.finalEquityUsdt - result.initialCapitalUsdt,
    realizedProfitUsdt: result.realizedProfitUsdt, feesUsdt: result.feesUsdt, entryCount: result.entryCount,
    closedTradeCount: result.closedTradeCount, winCount: result.winCount, lossCount: result.lossCount,
    winRatePercent: result.winRatePercent, maxDrawdownPercent: result.maxDrawdownPercent,
    openPositionCount: result.openPositionCount, winningProfitUsdt: result.winningProfitUsdt ?? 0, losingLossUsdt: result.losingLossUsdt ?? 0,
    profitRatioPercent: profitRatio(result.winningProfitUsdt ?? 0, result.losingLossUsdt ?? 0) };
}

/** First untouchable offset implies every wider offset is also untouchable; money/position state is irrelevant. */
export function maximumTouchedStep(document: ReturnType<typeof prepareSymbolBlock>, closeOnly = false): number {
  let maximum = 0;
  for (const bar of document.bars) {
    const band = bar.envelope;
    if (!band) continue;
    if (band.long) maximum = Math.max(maximum, (band.center - (closeOnly ? bar.candle.close : bar.candle.low)) / band.center * 100);
    if (band.short) maximum = Math.max(maximum, ((closeOnly ? bar.candle.close : bar.candle.high) - band.center) / band.center * 100);
  }
  return Math.max(0, Math.min(statisticsPercentSteps, Math.floor(maximum * 10 + 1e-8)));
}

export function betterEnvelopeSetting(row: EnvelopeStatisticsRow, previous?: EnvelopeStatisticsRow | null): boolean {
  return qualifiesEnvelopeSetting(row) && (!previous || row.returnPercent > previous.returnPercent + 1e-9
    || Math.abs(row.returnPercent - previous.returnPercent) <= 1e-9 && row.maxDrawdownPercent < previous.maxDrawdownPercent);
}

/** Both statistics modes use the same single-symbol parameter sweep. */
export async function searchEnvelopeInstrument(job: EnvelopeStatisticsJob, checkpoint: (force?: boolean) => Promise<void>, signal: AbortSignal): Promise<void> {
  const instrument = job.instrument;
  if (!instrument) throw new Error('통계 종목 정보가 없습니다.');
  job.settings = fixedEnvelopeStatisticsSettings(job.settings);
  const resultOptions = job.settings.envelopeResultOptions ?? defaultEnvelopeResultOptions;
  validateEnvelopeResultOptions(resultOptions);
  delete job.risk;
  const intervals = selectedStatisticsIntervals(job.settings);
  const sides = selectedStatisticsSides(job.settings);
  job.sideIndex ??= 0; job.bestBySide ??= {};
  job.stopStep ??= 1;
  job.tradedSides ??= {};
  let lastYield = performance.now();
  const shouldYield = (): boolean => {
    const now = performance.now();
    if (now - lastYield < 35) return false;
    lastYield = now;
    return true;
  };
  for (const side of sides) job.bestBySide[side] ??= null;
  while (job.intervalIndex < intervals.length) {
    signal.throwIfAborted();
    const interval = intervals[job.intervalIndex]!;
    const settings = { ...job.settings, interval };
    let window: { start: number; end: number };
    try { window = analysisWindow(settings); } catch (error) {
      job.skippedIntervals[interval] = error instanceof Error ? error.message : '분석 기간이 부족합니다.';
      job.intervalIndex += 1; job.periodIndex = 0; job.sideIndex = 0; job.step = 1; job.stopStep = 1; await checkpoint(true); continue;
    }
    const { start, end } = window; const seconds = intervalSeconds(interval);
    job.message = `${interval} 캔들 확인`; await checkpoint(true);
    let candles = await ensureCandles(instrument, interval, start - 200 * seconds, end, end, signal);
    let minuteHistory: { from: number; candles: Candle[] } | undefined;
    const loadMinutes = async (from: number): Promise<Candle[]> => {
      if (!minuteHistory || minuteHistory.from > from) {
        minuteHistory = { from, candles: await ensureCandles(instrument, '1m', from, end, end, signal) };
      }
      if (minuteHistory.from === from) return minuteHistory.candles;
      const offset = minuteHistory.candles.findIndex(candle => candle.openTime >= from);
      return offset < 0 ? [] : minuteHistory.candles.slice(offset);
    };
    while (job.periodIndex < statisticsCenterPeriods.length) {
      const maPeriod = statisticsCenterPeriods[job.periodIndex]!;
      while (job.sideIndex < sides.length) {
        const side: StatisticsSide = sides[job.sideIndex]!;
        const directional = { ...settings, side };
        const baseParameters = { ...directional, envelopeMaPeriod: String(maPeriod), envelopeDeviationPercent: '0.1', envelopeStopLossPercent: '0.1' };
        const prepare = (minutes?: Candle[]) => {
          const prepared = prepareSymbolBlock(instrument.symbol, candles, baseParameters, 'ENVELOPE', start, end, undefined, undefined, undefined, undefined, undefined, undefined, minutes);
          for (const bar of prepared.bars) if (bar.envelope) { bar.envelope.long &&= instrument.LONG; bar.envelope.short &&= instrument.SHORT; }
          return prepared;
        };
        let document = prepare();
        const firstEntryTouch = document.bars.find(bar => envelopeEntryMayTouch(bar, baseParameters));
        if (firstEntryTouch) {
          const lowerFrom = envelopeCandleDataStart(directional, firstEntryTouch.candle.openTime);
          const lowerCandles = await loadMinutes(lowerFrom);
          document = prepare(lowerCandles);
          const parents = document.bars.flatMap(bar => bar.envelopeIntrabarCandles ? [bar.candle] : []);
          if (await refreshMismatchedLowerTimeframes(instrument, interval, parents, lowerCandles, signal, '1m')) {
            candles = await ensureCandles(instrument, interval, start - 200 * seconds, end, end, signal);
            minuteHistory = undefined;
            document = prepare(await loadMinutes(lowerFrom));
          }
        }
        const key = `${interval}:${maPeriod}:${side}`;
        const maximum = job.maxSteps[key] ?? maximumTouchedStep(document, baseParameters.envelopeCloseOnlyEntryEnabled); job.maxSteps[key] = maximum;
        const replayOptions = { shouldYield, validatedMinuteOpenRanges: validateEnvelopeMinuteRanges(document) };
        while (job.step <= maximum) {
          const deviationPercent = job.step / 10;
          for (const bar of document.bars) if (bar.envelope) {
            const band = bandFor(bar.envelope.center, deviationPercent);
            bar.envelope.upper = band.upper;
            bar.envelope.lower = band.lower;
          }
          const deviation = deviationPercent.toFixed(1);
          const bandParameters = { ...baseParameters, envelopeDeviationPercent: deviation };
          while (job.stopStep <= statisticsPercentSteps) {
            signal.throwIfAborted();
            const stopLoss = (job.stopStep / 10).toFixed(1);
            const parameters = { ...bandParameters, envelopeStopLossPercent: stopLoss };
            const label = `${statisticsSideLabel(side)} · ${interval} · SMA${maPeriod} · 이격 ${deviation}% · SL ${stopLoss}%`;
            job.message = label;
            const result = await replayFixedEnvelope(document, parameters, seconds, signal, async phase => {
              job.message = `${label} · ${phase}`;
              await checkpoint();
            }, replayOptions);
            const metrics = { ...resultRow(result, interval, maPeriod, job.step), side, leverage: Number(parameters.leverage) };
            // If the fixed stop never fired, widening it cannot change any entry or exit.
            const lastEquivalentStep = result.exitReasons.SL ? job.stopStep : statisticsPercentSteps;
            for (; job.stopStep <= lastEquivalentStep; job.stopStep += 1) {
              const row = { ...metrics, stopLossPercent: job.stopStep / 10 };
              job.rows.push(row);
              if (betterFilteredEnvelopeSetting(row, job.best, resultOptions)) job.best = row;
              if (betterFilteredEnvelopeSetting(row, job.bestBySide[side], resultOptions)) job.bestBySide[side] = row;
            }
            if (metrics.entryCount > 0) job.tradedSides[side] = true;
            await checkpoint();
          }
          job.stopStep = 1;
          job.step += 1;
        }
        job.sideIndex += 1; job.step = 1; job.stopStep = 1;
        await checkpoint();
      }
      job.sideIndex = 0;
      job.periodIndex += 1;
    }
    job.intervalIndex += 1; job.periodIndex = 0;
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
      const settings = fixedEnvelopeStatisticsSettings(structuredClone(options.settings));
      settings.envelopeResultOptions ??= { ...defaultEnvelopeResultOptions };
      if (!settings.endDate) {
        const end = new Date(Date.now() + 9 * 3600_000).toISOString();
        settings.endDate = end.slice(0, 10); settings.endTime = end.slice(11, 16);
      }
      statisticsAnalysisWindow(settings);
      validateEnvelopeResultOptions(settings.envelopeResultOptions ?? defaultEnvelopeResultOptions);
      job = { id: crypto.randomUUID(), version, settings, status: 'RUNNING', intervalIndex: 0, periodIndex: 0, step: 1, stopStep: 1,
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
