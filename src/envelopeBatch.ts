/** All-symbol optimization and a separate, cash-constrained hourly portfolio revalidation. */
import { deletePrefix, deleteValue, lease, maintainCache, readValue, retentionMs, writeValue } from './database';
import { intervalSeconds } from './api';
import { envelopeOptimizerVersion, isCurrentEnvelopeStatisticsVersion, isFilteredEnvelopeStatisticsVersion, searchEnvelopeInstrument, selectedStatisticsSides, statisticsAnalysisWindow, statisticsProgress, statisticsTotalFor, type DirectionalBests, type EnvelopeStatisticsJob, type EnvelopeStatisticsRow, type StatisticsSide } from './envelopeStatistics';
import { currentEnvelopeSettings } from './envelope';
import { defaultEnvelopeResultOptions, envelopeBests, matchesEnvelopeFilters, retainEnvelopeCandidates, validateEnvelopeResultOptions } from './envelopeResults';
import { analysisWindow, ensureCandles, listInstruments, refreshMismatchedLowerTimeframes, type Instrument } from './marketData';
import { initialPortfolio, portfolioResult, replayPortfolioBlock, type PortfolioState } from './portfolio';
import { fixedEnvelopeSettings, yieldAnalysis } from './envelopeReplay';
import { envelopeEntryMayTouch, prepareSymbolBlock, type PreparedSymbol } from './engine';
import { validateLowerTimeframeCandles } from './intrabar';
import type { BacktestInterval, BacktestResult, BacktestSettings, Candle, ContractRisk, EnvelopeResultOptions } from './types';

export type EnvelopeBatchKind = 'ALL_STATS' | 'VIRTUAL';
export interface OptimizedSymbol {
  symbol: string; launchAt: number; status: 'OK' | 'NO_TRADES' | 'NO_QUALIFYING' | 'UNSUPPORTED';
  best: EnvelopeStatisticsRow | null; bestBySide?: DirectionalBests; risk?: ContractRisk; message?: string;
  tradedSides?: Partial<Record<StatisticsSide, boolean>>;
  candidatesKey?: string;
}
export interface EnvelopeBatchJob {
  id: string; version: string; kind: EnvelopeBatchKind; status: 'RUNNING' | 'PAUSED' | 'COMPLETED';
  settings: BacktestSettings; updatedAt: number; message: string;
  universe: Instrument[]; cursor: number; rows: OptimizedSymbol[]; activeSearch?: EnvelopeStatisticsJob;
  sourceId?: string; state?: PortfolioState; start?: number; end?: number; blockStart?: number; result?: BacktestResult;
  trainingSettings?: BacktestSettings;
}
export interface EnvelopeBatchView extends Omit<EnvelopeBatchJob, 'state' | 'universe' | 'activeSearch' | 'rows'> {
  rows: Omit<OptimizedSymbol, 'risk'>[]; candidateCount: number; completed: number; total: number;
}
interface SavedBatch extends Omit<EnvelopeBatchJob, 'rows' | 'state'> { rowsKey: string; stateKey?: string }
export interface BatchHistoryEntry { id: string; at: number; kind: EnvelopeBatchKind; version?: string; settings: BacktestSettings; symbols: number; optimized: number; longOptimized?: number; shortOptimized?: number; returnPercent?: number; sourceId?: string; trainingSettings?: BacktestSettings }
const key = (kind: EnvelopeBatchKind): string => `ENVELOPE_BATCH:${kind}`;
const archiveKey = (id: string): string => `envelope-batch:${id}`;
const historyKey = 'envelope-batch-history';
const candidatePrefix = (id: string): string => `checkpoint:envelope-candidates:${id}:`;
const selectionKey = (id: string): string => `envelope-result-selection:${id}`;
interface ResultSelection { options: EnvelopeResultOptions; optimized: number; longOptimized: number; shortOptimized: number }

async function selectBatchResults(job: EnvelopeBatchJob, options?: EnvelopeResultOptions): Promise<EnvelopeBatchJob> {
  if (job.kind !== 'ALL_STATS' || !isFilteredEnvelopeStatisticsVersion(job.version)) return job;
  const saved = options ? null : await readValue<ResultSelection>('publicData', selectionKey(job.id));
  const selected = options ?? saved?.options ?? job.settings.envelopeResultOptions ?? defaultEnvelopeResultOptions;
  validateEnvelopeResultOptions(selected);
  const rows: OptimizedSymbol[] = [];
  for (const row of job.rows) {
    const candidates = row.candidatesKey ? await readValue<EnvelopeStatisticsRow[]>('results', row.candidatesKey) : null;
    if (row.candidatesKey && !candidates) throw new Error(`${row.symbol}의 저장된 필터 후보가 없습니다. 새 전체통계를 실행해 주세요.`);
    const { best, bestBySide } = envelopeBests(candidates ?? Object.values(row.bestBySide ?? {}).filter((value): value is EnvelopeStatisticsRow => !!value), selected);
    rows.push({ ...row, best, bestBySide, status: best ? 'OK' : Object.values(row.tradedSides ?? {}).some(Boolean) ? 'NO_QUALIFYING' : 'NO_TRADES' });
  }
  return { ...job, settings: { ...job.settings, envelopeResultOptions: structuredClone(selected) }, rows };
}

/** Persist selection preferences, never rewrite the immutable parameter sweep or its raw candidate archive. */
export async function saveEnvelopeBatchSelection(id: string, options: EnvelopeResultOptions): Promise<EnvelopeBatchJob> {
  const raw = await readValue<EnvelopeBatchJob>('results', archiveKey(id));
  if (!raw || raw.status !== 'COMPLETED' || raw.kind !== 'ALL_STATS' || !isCurrentEnvelopeStatisticsVersion(raw.version)) throw new Error('새 조건으로 완료한 전체통계에서 필터를 적용해 주세요.');
  const selected = await selectBatchResults(raw, options);
  await writeValue('publicData', selectionKey(id), { options: structuredClone(options), optimized: selected.rows.filter(row => row.best).length,
    longOptimized: selected.rows.filter(row => row.bestBySide?.LONG).length, shortOptimized: selected.rows.filter(row => row.bestBySide?.SHORT).length } satisfies ResultSelection);
  return selected;
}

export function envelopeBatchView(job: EnvelopeBatchJob): EnvelopeBatchView {
  const { state: _state, universe, activeSearch, rows, ...view } = job;
  const perSymbolTotal = statisticsTotalFor(job.settings, job.version);
  const seconds = intervalSeconds(job.settings.interval);
  const total = job.kind === 'ALL_STATS' ? Math.max(1, universe.length) * perSymbolTotal : Math.max(1, ((job.end ?? 0) - (job.start ?? 0)) / seconds);
  const completed = job.status === 'COMPLETED' ? total : job.kind === 'ALL_STATS'
    ? job.cursor * perSymbolTotal + (activeSearch ? statisticsProgress(activeSearch) : 0) : Math.max(0, ((job.blockStart ?? 0) - (job.start ?? 0)) / seconds);
  return { ...view, rows: rows.map(({ risk: _risk, ...row }) => row), candidateCount: universe.length, completed, total };
}
async function readJob(kind: EnvelopeBatchKind): Promise<EnvelopeBatchJob | null> {
  const header = await readValue<SavedBatch>('jobs', key(kind));
  if (!header || Date.now() - header.updatedAt > retentionMs) return null;
  const rows = await readValue<OptimizedSymbol[]>('results', header.rowsKey);
  const state = header.stateKey ? await readValue<PortfolioState>('results', header.stateKey) : null;
  if (!rows || header.stateKey && !state) throw new Error('저장된 분석 체크포인트가 없습니다. 새 분석을 시작해 주세요.');
  const { rowsKey: _rows, stateKey: _state, ...job } = header; return { ...job, rows, ...(state ? { state } : {}) };
}
export async function loadEnvelopeBatch(kind: EnvelopeBatchKind): Promise<EnvelopeBatchView | null> {
  const job = await readJob(kind);
  if (!job) return null;
  if (job.version !== envelopeOptimizerVersion && job.status !== 'COMPLETED') job.message = '매매 조건과 검증 방식이 변경되었습니다. 새 분석을 시작해 주세요. 기존 이력은 보존됩니다.';
  return envelopeBatchView(await selectBatchResults({ ...job, status: job.status === 'RUNNING' ? 'PAUSED' : job.status }));
}
export function canResumeEnvelopeBatch(job: Pick<EnvelopeBatchJob, 'version' | 'kind' | 'cursor' | 'rows' | 'settings'> & { activeSearch?: EnvelopeStatisticsJob; completed?: number }): boolean {
  return job.version === envelopeOptimizerVersion;
}
export async function loadEnvelopeBatchReport(id: string): Promise<EnvelopeBatchJob | null> {
  const value = await readValue<EnvelopeBatchJob>('results', archiveKey(id));
  return value && value.status === 'COMPLETED' && Date.now() - value.updatedAt <= retentionMs ? selectBatchResults(value) : null;
}
export async function loadEnvelopeBatchHistory(kind: EnvelopeBatchKind): Promise<BatchHistoryEntry[]> {
  const entries = await readValue<BatchHistoryEntry[]>('publicData', historyKey) ?? [];
  const recent = entries.filter(item => item.kind === kind && Date.now() - item.at <= retentionMs).sort((a, b) => b.at - a.at);
  return Promise.all(recent.map(async item => {
    const selection = item.kind === 'ALL_STATS' ? await readValue<ResultSelection>('publicData', selectionKey(item.id)) : null;
    return selection ? { ...item, ...selection, settings: { ...item.settings, envelopeResultOptions: selection.options } } : item;
  }));
}
async function saveReport(job: EnvelopeBatchJob): Promise<void> {
  const previous = await readValue<BatchHistoryEntry[]>('publicData', historyKey) ?? [];
  const entry: BatchHistoryEntry = { id: job.id, at: job.updatedAt, kind: job.kind, version: job.version, settings: job.settings, symbols: job.universe.length,
    optimized: job.rows.filter(row => row.status === 'OK').length,
    ...(job.rows.some(row => row.bestBySide) ? { longOptimized: job.rows.filter(row => row.bestBySide?.LONG).length, shortOptimized: job.rows.filter(row => row.bestBySide?.SHORT).length } : {}),
    ...(job.result ? { returnPercent: job.result.returnPercent } : {}), ...(job.sourceId ? { sourceId: job.sourceId } : {}),
    ...(job.trainingSettings ? { trainingSettings: job.trainingSettings } : {}) };
  const recent = [entry, ...previous.filter(item => item.id !== job.id)].filter(item => Date.now() - item.at <= retentionMs);
  const keep = recent.filter((item, index) => recent.slice(0, index).filter(other => other.kind === item.kind).length < 20);
  await writeValue('results', archiveKey(job.id), job); await writeValue('publicData', historyKey, keep);
  for (const item of previous) if (!keep.some(value => value.id === item.id)) {
    await deleteValue('results', archiveKey(item.id)); await deletePrefix('results', candidatePrefix(item.id)); await deleteValue('publicData', selectionKey(item.id));
  }
}
function frozenSettings(settings: BacktestSettings): BacktestSettings {
  const copy = { ...currentEnvelopeSettings(fixedEnvelopeSettings(settings)), mode: 'ALL' as const,
    envelopeResultOptions: structuredClone(settings.envelopeResultOptions ?? defaultEnvelopeResultOptions) };
  validateEnvelopeResultOptions(copy.envelopeResultOptions);
  if (!copy.endDate) { const text = new Date(Date.now() + 9 * 3600_000).toISOString(); copy.endDate = text.slice(0, 10); copy.endTime = text.slice(11, 16); }
  return copy;
}

export function validateVirtualSettings(settings: BacktestSettings): void {
  fixedEnvelopeSettings(settings);
  if (!/^\d+(\.\d{1,2})?$/.test(settings.initialCapitalUsdt) || !Number.isFinite(Number(settings.initialCapitalUsdt)) || Number(settings.initialCapitalUsdt) < 10) throw new Error('가상 초기자금을 확인해 주세요.');
  if (!/^\d+(\.\d{1,2})?$/.test(settings.betAmountUsdt) || !Number.isFinite(Number(settings.betAmountUsdt)) || Number(settings.betAmountUsdt) < 1 || Number(settings.betAmountUsdt) > Number(settings.initialCapitalUsdt)) throw new Error('고정 베팅액을 확인해 주세요.');
  analysisWindow(settings);
}
export function virtualPeriodRelation(evaluation: BacktestSettings, training: BacktestSettings): 'AFTER' | 'OVERLAP' | 'BEFORE' | null {
  try {
    const test = analysisWindow(evaluation); const fit = statisticsAnalysisWindow(training);
    return test.start >= fit.end ? 'AFTER' : test.end <= fit.start ? 'BEFORE' : 'OVERLAP';
  } catch { return null; }
}

async function run(options: { kind: EnvelopeBatchKind; settings?: BacktestSettings; resumeId?: string; sourceId?: string }, publish: (view: EnvelopeBatchView) => void, signal: AbortSignal, useLease: boolean): Promise<void> {
  const owner = crypto.randomUUID(); let heartbeat: ReturnType<typeof setInterval> | undefined; let lost = false;
  let job: EnvelopeBatchJob | null = null; let savedRows: OptimizedSymbol[] | null = null; let savedState: PortfolioState | undefined;
  let oldRowsKey: string | null = null; let oldStateKey: string | undefined; let lastSaved = 0; let lastPublished = 0;
  if (useLease && !await lease(owner)) throw new Error('다른 분석이 진행 중입니다. 먼저 일시정지해 주세요.');
  const checkpoint = async (force = false): Promise<void> => {
    if (!job) return; if (lost) throw new Error('분석 잠금을 잃었습니다. 다시 이어가 주세요.');
    job.updatedAt = Date.now();
    if (force || job.updatedAt - lastSaved >= 1000) {
      const rowsKey = savedRows === job.rows && oldRowsKey ? oldRowsKey : `${job.id}:rows:${job.cursor}`;
      const stateKey = job.state ? savedState === job.state && oldStateKey ? oldStateKey : `${job.id}:account:${job.blockStart}` : undefined;
      if (savedRows !== job.rows) await writeValue('results', rowsKey, job.rows);
      if (job.state && savedState !== job.state) await writeValue('results', stateKey!, job.state);
      const { rows: _rows, state: _state, ...header } = job;
      await writeValue('jobs', key(job.kind), { ...header, rowsKey, ...(stateKey ? { stateKey } : {}) } satisfies SavedBatch);
      if (oldRowsKey && oldRowsKey !== rowsKey) await deleteValue('results', oldRowsKey);
      if (oldStateKey && oldStateKey !== stateKey) await deleteValue('results', oldStateKey);
      oldRowsKey = rowsKey; oldStateKey = stateKey; savedRows = job.rows; savedState = job.state; lastSaved = job.updatedAt;
    }
    if (force || job.updatedAt - lastPublished >= 250) { publish(envelopeBatchView(job)); lastPublished = job.updatedAt; }
  };
  try {
    if (useLease) heartbeat = setInterval(() => { void lease(owner).then(value => { lost ||= !value; }).catch(() => { lost = true; }); }, 10000);
    await maintainCache();
    if (options.resumeId) {
      job = await readJob(options.kind);
      if (!job || job.id !== options.resumeId || !canResumeEnvelopeBatch(job) || job.status === 'COMPLETED') throw new Error('이어갈 분석이 없습니다. 새 분석을 시작해 주세요.');
      const header = await readValue<SavedBatch>('jobs', key(options.kind)); oldRowsKey = header!.rowsKey; oldStateKey = header!.stateKey; savedRows = job.rows; savedState = job.state;
      job.status = 'RUNNING';
    } else if (options.kind === 'ALL_STATS') {
      if (!options.settings) throw new Error('분석 설정이 없습니다.');
      const settings = frozenSettings(options.settings); statisticsAnalysisWindow(settings);
      job = { id: crypto.randomUUID(), version: envelopeOptimizerVersion, kind: options.kind, status: 'RUNNING', settings, updatedAt: Date.now(), message: 'USDT 전체 종목 확인 · 슬리피지 필터 미사용', universe: [], cursor: 0, rows: [] };
    } else {
      const source = options.sourceId ? await loadEnvelopeBatchReport(options.sourceId) : null;
      if (!source || source.kind !== 'ALL_STATS' || !isCurrentEnvelopeStatisticsVersion(source.version)) throw new Error('새 매매 조건으로 완료한 전체통계 결과를 먼저 선택해 주세요.');
      if (!options.settings) throw new Error('가상매매 기간·초기자금·베팅액·레버리지를 입력해 주세요.');
      const requestedSides = selectedStatisticsSides(options.settings);
      const rows = source.rows.flatMap(row => {
        const bestBySide: DirectionalBests = {};
        for (const side of requestedSides) {
          const best = row.bestBySide?.[side] ?? (row.best?.side === side ? row.best : undefined);
          if (best && best.side === side && matchesEnvelopeFilters(best, source.settings.envelopeResultOptions)) bestBySide[side] = structuredClone(best);
        }
        const best = Object.values(bestBySide).filter((value): value is EnvelopeStatisticsRow => !!value).sort((a, b) => b.returnPercent - a.returnPercent)[0];
        return best ? [{ ...row, bestBySide, best, status: 'OK' as const }] : [];
      });
      if (!rows.length) throw new Error('선택한 전체통계에 가상매매 가능한 최적 세팅이 없습니다.');
      const sourceIntervals = new Set(rows.flatMap(row => [row.best?.interval, ...Object.values(row.bestBySide ?? {}).map(best => best?.interval)]).filter((value): value is BacktestInterval => !!value));
      if (sourceIntervals.size !== 1) throw new Error('전체통계 결과의 캔들 주기가 섞여 있습니다. 한 주기로 다시 통계를 실행해 주세요.');
      const sourceInterval = [...sourceIntervals][0]!;
      const settings = { ...frozenSettings(options.settings), side: options.settings.side, interval: sourceInterval };
      validateVirtualSettings(settings); const window = analysisWindow(settings);
      job = { id: crypto.randomUUID(), version: envelopeOptimizerVersion, kind: options.kind, status: 'RUNNING', settings, updatedAt: Date.now(), message: `${sourceInterval} 공유 계좌 재검증 준비`,
        sourceId: source.id, trainingSettings: structuredClone(source.settings), rows, universe: rows.map(row => ({ symbol: row.symbol, launchAt: row.launchAt })), cursor: 0, state: initialPortfolio(Number(settings.initialCapitalUsdt)), start: window.start, end: window.end, blockStart: window.start };
    }
    await checkpoint(true); signal.throwIfAborted();
    if (job.kind === 'ALL_STATS') {
      if (!job.universe.length) { job.universe = await listInstruments(undefined, signal); if (!job.universe.length || job.universe.length > 3000) throw new Error('USDT 종목 목록을 확인하지 못했습니다.'); await checkpoint(true); }
      while (job.cursor < job.universe.length) {
        signal.throwIfAborted(); const instrument = job.universe[job.cursor]!;
        job.activeSearch ??= { id: `${job.id}:${instrument.symbol}`, version: envelopeOptimizerVersion, settings: { ...job.settings, mode: 'SINGLE', symbol: instrument.symbol.replace(/USDT$/, '') },
          status: 'RUNNING', intervalIndex: 0, periodIndex: 0, step: 1, exitIndex: 0, updatedAt: Date.now(), message: '', rows: [], maxSteps: {}, skippedIntervals: {},
          instrument: { ...instrument, LONG: true, SHORT: true } };
        await searchEnvelopeInstrument(job.activeSearch, async force => { job!.message = `${job!.cursor + 1}/${job!.universe.length} · ${instrument.symbol} · ${job!.activeSearch!.message}`; await checkpoint(force); }, signal);
        const search = job.activeSearch;
        const candidatesKey = candidatePrefix(job.id) + instrument.symbol;
        await writeValue('results', candidatesKey, retainEnvelopeCandidates(search.rows));
        job.rows = [...job.rows, { ...instrument, candidatesKey, status: search.best ? 'OK' : Object.values(search.tradedSides ?? {}).some(Boolean) ? 'NO_QUALIFYING' : 'NO_TRADES', best: search.best ?? null, bestBySide: search.bestBySide, tradedSides: search.tradedSides }];
        job.cursor += 1; delete job.activeSearch; await checkpoint(true); await yieldAnalysis();
      }
    } else {
      const parameters: Record<string, BacktestSettings> = {};
      const parametersBySide: Record<string, Partial<Record<StatisticsSide, BacktestSettings>>> = {};
      const settingFor = (row: OptimizedSymbol, best: EnvelopeStatisticsRow, side = job!.settings.side): BacktestSettings => currentEnvelopeSettings({ ...fixedEnvelopeSettings(job!.settings), side,
        interval: best.interval, symbol: row.symbol.replace(/USDT$/, ''), envelopeMaPeriod: String(best.maPeriod), envelopeDeviationPercent: String(best.deviationPercent) });
      for (const row of job.rows) {
        parameters[row.symbol] = settingFor(row, row.best!);
        if (row.bestBySide) {
          const directional: Partial<Record<StatisticsSide, BacktestSettings>> = {};
          for (const side of selectedStatisticsSides(job!.settings)) if (row.bestBySide[side]) directional[side] = settingFor(row, row.bestBySide[side]!, side);
          parametersBySide[row.symbol] = directional;
        }
      }
      const seconds = intervalSeconds(job.settings.interval);
      const size = Math.max(1, Math.min(128, Math.floor(64000 / (job.rows.length * 2))));
      while (job.blockStart! < job.end!) {
        signal.throwIfAborted(); const start = job.blockStart!; const end = Math.min(job.end!, start + size * seconds); const documents: PreparedSymbol[] = [];
        for (const row of job.rows) {
          signal.throwIfAborted();
          let candles = await ensureCandles(row, job.settings.interval, start - 200 * seconds, end, job.end, signal);
          const prepareDirectional = (envelopeIntrabarCandles?: Candle[]) => (['LONG', 'SHORT'] as const).flatMap(side => {
            const p = parametersBySide[row.symbol]?.[side];
            if (!p) return [];
            return [{ side, document: prepareSymbolBlock(row.symbol, candles, p, 'ENVELOPE', start, end, undefined, undefined, undefined, undefined, undefined, undefined, envelopeIntrabarCandles) }];
          });
          let directional = prepareDirectional();
          const firstEntryTouch = directional.flatMap(({ side, document }) => {
            const parameters = parametersBySide[row.symbol]?.[side];
            if (!parameters) return [];
            return document.bars.filter(bar => envelopeEntryMayTouch(bar, parameters));
          }).sort((a, b) => a.candle.openTime - b.candle.openTime)[0];
          const lowerFrom = job.state!.positions[row.symbol] ? start : firstEntryTouch?.candle.openTime;
          if (lowerFrom !== undefined && lowerFrom < end) {
            let envelopeIntrabarCandles = await ensureCandles(row, '15m', lowerFrom, end, end, signal);
            directional = prepareDirectional(envelopeIntrabarCandles);
            const parents = directional[0]?.document.bars.flatMap(bar => bar.envelopeIntrabarCandles ? [bar.candle] : []) ?? [];
            if (await refreshMismatchedLowerTimeframes(row, job.settings.interval, parents, envelopeIntrabarCandles, signal)) {
              candles = await ensureCandles(row, job.settings.interval, start - 200 * seconds, end, job.end, signal);
              envelopeIntrabarCandles = await ensureCandles(row, '15m', lowerFrom, end, end, signal);
              directional = prepareDirectional(envelopeIntrabarCandles);
            }
            for (const { document } of directional) for (const bar of document.bars) {
              if (bar.envelopeIntrabarCandles) validateLowerTimeframeCandles(bar.candle, bar.envelopeIntrabarCandles, 900, '15분봉');
            }
          }
          const base = directional[0]?.document;
          if (!base) throw new Error(`${row.symbol}의 방향별 최적 세팅이 없습니다.`);
          documents.push({ symbol: row.symbol, bars: base.bars.map((bar, index) => ({ ...bar, envelope: undefined,
            envelopeBySide: Object.fromEntries(directional.flatMap(({ side, document }) => {
              const band = document.bars[index]?.envelope;
              return band ? [[side, { ...band, sourceInterval: job!.settings.interval, parentOpenTime: bar.candle.openTime }]] : [];
            })) })) });
          job.message = `가상매매 캔들 확인 ${row.symbol} · ${new Date(start * 1000).toLocaleDateString('ko-KR')}`; await checkpoint();
        }
        const next = structuredClone(job.state!);
        replayPortfolioBlock(next, documents, job.settings, start, end, seconds, { settingsForSymbol: parameters, settingsForSymbolSide: parametersBySide });
        job.state = next; job.blockStart = end; job.result = { ...portfolioResult(next, job.settings), universeCount: job.rows.length };
        job.message = `${job.settings.interval} 공유 계좌 가상매매 · ${new Date(end * 1000).toLocaleString('ko-KR')}`; await checkpoint(true); await yieldAnalysis();
      }
    }
    job.status = 'COMPLETED'; job.message = job.kind === 'ALL_STATS' ? `전체통계 완료 · ${job.rows.length}종목 중 ${job.rows.filter(row => row.status === 'OK').length}개 기준 충족 종목` : '가상매매 완료 · 저장 세팅 고정 · 별도 입력 기간 검증';
    job.updatedAt = Date.now(); await saveReport(job); await checkpoint(true);
  } catch (error) {
    if (!job) throw error;
    job.status = 'PAUSED'; job.message = signal.aborted ? '분석을 일시정지했습니다. 저장한 지점부터 이어갈 수 있습니다.' : error instanceof Error ? error.message : '분석에 실패했습니다.';
    await checkpoint(true);
  } finally { if (heartbeat !== undefined) clearInterval(heartbeat); if (useLease) await lease(owner, true); }
}

export async function executeEnvelopeBatch(options: { kind: EnvelopeBatchKind; settings?: BacktestSettings; resumeId?: string; sourceId?: string }, publish: (view: EnvelopeBatchView) => void, signal: AbortSignal): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('zetaauto-local-analysis', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('다른 분석이 진행 중입니다. 먼저 일시정지해 주세요.'); await run(options, publish, signal, false);
  });
  return run(options, publish, signal, true);
}
