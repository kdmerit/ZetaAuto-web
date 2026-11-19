import { intervalSeconds } from './api';
import { lease, maintainCache, writeValue } from './database';
import { bandFor, currentEnvelopeSettings } from './envelope';
import { envelopeBatchSettings, loadEnvelopeBatchReport } from './envelopeBatch';
import { envelopeCandleDataStart } from './envelopeCandleFilter';
import { replayFixedEnvelope, validateEnvelopeMinuteRanges, yieldAnalysis } from './envelopeReplay';
import { matchesEnvelopeFilters, validateEnvelopeResultOptions } from './envelopeResults';
import { settingsForStatisticsRow, usesCurrentEnvelopeExecution, type EnvelopeStatisticsRow } from './envelopeStatistics';
import { loadEnvelopeStatisticsReport } from './envelopeStatisticsHistory';
import { emptyVerificationSummary, loadEnvelopeVerification, planEnvelopeVerification, recordVerificationMonth, verificationKey, verificationRowKey, type EnvelopeVerificationReport, type VerificationMonth, type VerificationRequest } from './envelopeVerification';
import { envelopeEntryMayTouch, prepareSymbolBlock } from './engine';
import { ensureCandles, isMissingCandleError, refreshMismatchedLowerTimeframes, type Instrument } from './marketData';
import type { BacktestInterval, BacktestSettings, Candle } from './types';

interface Candidate { key: string; row: EnvelopeStatisticsRow }
interface BandGroup { settings: BacktestSettings; candidates: Candidate[] }
interface SymbolGroup { instrument: Instrument; interval: BacktestInterval; bands: BandGroup[] }

function groupCandidates(instrument: Instrument, settings: BacktestSettings, rows: EnvelopeStatisticsRow[]): SymbolGroup[] {
  const intervals = new Map<BacktestInterval, Map<string, BandGroup>>();
  const sorted = [...rows].sort((a, b) => a.deviationPercent - b.deviationPercent || (a.stopLossPercent ?? 0) - (b.stopLossPercent ?? 0));
  for (const row of sorted) {
    const bands = intervals.get(row.interval) ?? new Map<string, BandGroup>();
    const geometry = `${row.side}:${row.maPeriod}:${row.leverage ?? settings.leverage}`;
    const settingsForBand = bands.get(geometry) ?? {
      settings: currentEnvelopeSettings(settingsForStatisticsRow(settings, row)), candidates: [],
    };
    settingsForBand.candidates.push({ key: verificationRowKey(instrument.symbol, row), row });
    bands.set(geometry, settingsForBand);
    intervals.set(row.interval, bands);
  }
  return [...intervals].map(([interval, bands]) => ({ instrument, interval, bands: [...bands.values()] }));
}

async function verificationSource(request: VerificationRequest): Promise<{ settings: BacktestSettings; at: number; groups: SymbolGroup[] }> {
  validateEnvelopeResultOptions(request.resultOptions);
  if (request.source === 'SINGLE_STATS') {
    const source = await loadEnvelopeStatisticsReport(request.sourceId);
    if (!source || !usesCurrentEnvelopeExecution(source.version)) throw new Error('현재 체결 방식으로 완료된 개별통계가 필요합니다.');
    const symbol = `${source.settings.symbol.toUpperCase().replace(/USDT$/, '')}USDT`;
    const instrument = source.instrument ?? { symbol, launchAt: 0 };
    const rows = source.rows.filter(row => matchesEnvelopeFilters(row, request.resultOptions));
    return { settings: source.settings, at: source.updatedAt, groups: groupCandidates(instrument, source.settings, rows) };
  }

  const source = await loadEnvelopeBatchReport(request.sourceId, request.resultOptions);
  if (!source || source.kind !== 'ALL_STATS' || !usesCurrentEnvelopeExecution(source.version)) throw new Error('현재 체결 방식으로 완료된 전체통계가 필요합니다.');
  const groups = source.rows.flatMap(row => groupCandidates(row, source.settings, envelopeBatchSettings(row, source.settings)));
  return { settings: source.settings, at: source.updatedAt, groups };
}

function coversWindow(rows: Candle[], seconds: number, start: number, end: number): boolean {
  return rows.length === (end - start) / seconds && rows.every((row, index) => row.openTime === start + seconds * index && row.closeTime === row.openTime + seconds);
}

/** A month is committed only after all settings sharing this candle series complete it. */
async function replayVerificationMonth(group: SymbolGroup, month: VerificationMonth, earliest: number, signal: AbortSignal,
  publishProgress: (tested: number) => void): Promise<Map<string, number> | null> {
  const { instrument, interval, bands } = group;
  const seconds = intervalSeconds(interval);
  const start = Math.ceil(month.start / seconds) * seconds;
  const end = Math.floor(month.end / seconds) * seconds;
  if (start >= end || instrument.launchAt > start) return null;

  const warmup = Math.max(...bands.map(({ settings }) => Math.max(Number(settings.envelopeMaPeriod), settings.envelopeMa20Enabled ? 19 : 0)));
  const warmFrom = Math.max(start - seconds * warmup, Math.ceil(earliest / seconds) * seconds);
  const initialCapital = Number(bands[0]!.settings.initialCapitalUsdt);
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error('저장된 통계의 초기자금을 확인해 주세요.');

  const loadParents = async (): Promise<Candle[]> => ensureCandles(instrument, interval, warmFrom, end, end, signal);
  let candles = await loadParents();
  const inMonth = () => candles.filter(candle => candle.openTime >= start);
  if (!coversWindow(inMonth(), seconds, start, end)) return null;

  const prepare = (settings: BacktestSettings, minutes?: Candle[]) => prepareSymbolBlock(
    instrument.symbol, candles, settings, 'ENVELOPE', start, end, undefined, undefined, undefined, undefined, undefined, undefined, minutes,
  );
  const previews = () => bands.map(band => ({
    ...band, firstTouch: prepare(band.settings).bars.find(bar => envelopeEntryMayTouch(bar, band.settings))?.candle.openTime,
  }));
  let planned = previews();
  const earliestTouch = () => Math.min(...planned.map(band => band.firstTouch ?? Infinity));
  const loadMinutes = async (touch: number): Promise<Candle[] | undefined> => {
    if (!Number.isFinite(touch)) return undefined;
    const from = Math.max(envelopeCandleDataStart(bands[0]!.settings, touch), Math.ceil(earliest / 60) * 60);
    return ensureCandles(instrument, '1m', from, end, end, signal);
  };

  let touch = earliestTouch();
  let minutes = await loadMinutes(touch);
  if (minutes && await refreshMismatchedLowerTimeframes(instrument, interval, inMonth(), minutes, signal, '1m')) {
    candles = await loadParents();
    if (!coversWindow(inMonth(), seconds, start, end)) return null;
    planned = previews();
    touch = earliestTouch();
    minutes = await loadMinutes(touch);
  }
  if (minutes && !coversWindow(minutes.filter(candle => candle.openTime >= touch), 60, touch, end)) return null;

  const finals = new Map<string, number>();
  let lastYield = performance.now();
  const shouldYield = (): boolean => {
    const now = performance.now();
    if (now - lastYield < 40) return false;
    lastYield = now;
    return true;
  };

  for (const band of planned) {
    signal.throwIfAborted();
    const document = band.firstTouch === undefined ? undefined : prepare(band.settings, minutes);
    let validatedMinuteOpenRanges: ReturnType<typeof validateEnvelopeMinuteRanges> | undefined;
    if (document) {
      try { validatedMinuteOpenRanges = validateEnvelopeMinuteRanges(document); }
      catch { return null; }
    }
    let deviation = -1;
    let reusableFinal: number | undefined;
    for (const { key, row } of band.candidates) {
      signal.throwIfAborted();
      if (deviation !== row.deviationPercent) {
        deviation = row.deviationPercent;
        reusableFinal = document ? undefined : initialCapital;
        for (const bar of document?.bars ?? []) if (bar.envelope) {
          const next = bandFor(bar.envelope.center, deviation);
          bar.envelope.upper = next.upper;
          bar.envelope.lower = next.lower;
        }
      }
      if (reusableFinal !== undefined) {
        finals.set(key, reusableFinal);
      } else {
        const settings = settingsForStatisticsRow(band.settings, row);
        const result = await replayFixedEnvelope(document!, settings, seconds, signal, async () => publishProgress(finals.size), {
          shouldYield, validatedMinuteOpenRanges,
        });
        finals.set(key, result.finalEquityUsdt);
        // For this band, all following stops are wider. They replay identically once none fired.
        if (!result.exitReasons.SL) reusableFinal = result.finalEquityUsdt;
      }
      if (shouldYield()) { publishProgress(finals.size); await yieldAnalysis(); }
    }
  }
  return finals;
}

async function runVerification(request: VerificationRequest, publish: (report: EnvelopeVerificationReport) => void, signal: AbortSignal, useLease: boolean): Promise<void> {
  const owner = crypto.randomUUID();
  if (useLease && !await lease(owner)) throw new Error('다른 분석이 진행 중입니다. 먼저 일시정지해 주세요.');
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  let report: EnvelopeVerificationReport | null = null;
  let lastPublished = 0;
  const notify = (force = false): void => {
    if (!report || !force && Date.now() - lastPublished < 300) return;
    lastPublished = Date.now();
    publish(report.status === 'RUNNING' ? { ...report, summaries: {} } : report);
  };
  const checkpoint = async (): Promise<void> => {
    if (!report) return;
    if (leaseLost) throw new Error('분석 잠금을 잃었습니다. 저장 지점부터 이어가 주세요.');
    report.updatedAt = Date.now();
    await writeValue('results', verificationKey(report.request), report);
    notify(true);
  };

  try {
    if (useLease) heartbeat = setInterval(() => {
      void lease(owner).then(held => { leaseLost ||= !held; }).catch(() => { leaseLost = true; });
    }, 10_000);
    await maintainCache();
    const saved = request.resumeId ? await loadEnvelopeVerification(request) : null;
    if (request.resumeId && (!saved || saved.id !== request.resumeId || saved.status === 'COMPLETED')) throw new Error('이어갈 검증 결과가 없습니다.');
    const inputs = saved?.request ?? { ...request, resumeId: undefined };
    const source = await verificationSource(inputs);
    if (!source.groups.length) throw new Error('현재 통계 필터를 통과한 검증 대상이 없습니다.');
    const initialCapital = Number(source.settings.initialCapitalUsdt);
    if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error('저장된 통계의 초기자금을 확인해 주세요.');
    const plan = saved?.plan ?? planEnvelopeVerification(source.settings, inputs.direction, inputs.months, Date.now() / 1000, source.at / 1000);
    const summaries = saved?.summaries ?? Object.fromEntries(source.groups.flatMap(group => group.bands.flatMap(band => band.candidates.map(({ key }) => [key, emptyVerificationSummary]))));

    report = saved ?? {
      id: crypto.randomUUID(), request: inputs, status: 'RUNNING', updatedAt: Date.now(), plan,
      nextGroup: 0, nextMonth: 0, dataStops: 0, completed: 0, total: source.groups.length * plan.windows.length,
      targetCount: Object.keys(summaries).length, message: '검증 준비', summaries,
    };
    report.status = 'RUNNING';
    await checkpoint();
    signal.throwIfAborted();

    while (plan.windows.length && report.nextGroup < source.groups.length) {
      signal.throwIfAborted();
      const group = source.groups[report.nextGroup]!;
      const monthLabel = `${group.instrument.symbol} · ${report.nextMonth + 1}/${plan.windows.length}개월`;
      report.message = `${monthLabel} · 캔들 확인`;
      notify(true);
      let results: Map<string, number> | null;
      try {
        results = await replayVerificationMonth(group, plan.windows[report.nextMonth]!, plan.earliest, signal, tested => {
          report!.message = `${monthLabel} · ${tested.toLocaleString()}개 설정 검증`;
          notify();
        });
      } catch (error) {
        if (!isMissingCandleError(error)) throw error;
        results = null;
      }
      signal.throwIfAborted();
      if (results) {
        for (const [key, final] of results) {
          report.summaries[key] = recordVerificationMonth(report.summaries[key]!, initialCapital, final);
        }
        report.completed += 1;
        report.nextMonth += 1;
      } else {
        report.dataStops += 1;
        report.completed += plan.windows.length - report.nextMonth;
        report.nextMonth = plan.windows.length;
      }
      if (report.nextMonth === plan.windows.length) { report.nextGroup += 1; report.nextMonth = 0; }
      await checkpoint();
    }
    report.status = 'COMPLETED';
    report.message = plan.windows.length ? '월별 검증 완료' : '검증 가능한 완전한 한 달이 없습니다.';
    await checkpoint();
  } catch (error) {
    if (!report || leaseLost) throw error;
    report.status = 'PAUSED';
    report.message = signal.aborted ? '검증을 일시정지했습니다. 마지막으로 완료된 달 다음부터 이어갈 수 있습니다.'
      : error instanceof Error ? error.message : '월별 검증에 실패했습니다.';
    await checkpoint();
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (useLease) await lease(owner, true);
  }
}

export async function executeEnvelopeVerification(request: VerificationRequest, publish: (report: EnvelopeVerificationReport) => void, signal: AbortSignal): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('zetaauto-local-analysis', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('다른 분석이 진행 중입니다. 먼저 일시정지해 주세요.');
      await runVerification(request, publish, signal, false);
    });
  }
  return runVerification(request, publish, signal, true);
}
