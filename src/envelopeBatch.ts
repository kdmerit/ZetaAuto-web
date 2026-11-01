/** All-symbol optimization and a separate, cash-constrained 15-minute portfolio revalidation. */
import { intervalSeconds } from './api';
import { deleteValue, lease, maintainCache, readValue, retentionMs, writeValue } from './database';
import { envelopeOptimizerVersion, searchEnvelopeInstrument, statisticsProgress, statisticsTotal, type EnvelopeStatisticsJob, type EnvelopeStatisticsRow } from './envelopeStatistics';
import { projectEnvelopeBands } from './envelope';
import { analysisWindow, ensureCandles, listInstruments, type Instrument } from './marketData';
import { initialPortfolio, portfolioResult, replayPortfolioBlock, type PortfolioState } from './portfolio';
import { fixedEnvelopeSettings, yieldAnalysis } from './envelopeReplay';
import type { PreparedSymbol } from './engine';
import type { BacktestResult, BacktestSettings, ContractRisk } from './types';

export type EnvelopeBatchKind = 'ALL_STATS' | 'VIRTUAL';
export interface OptimizedSymbol {
  symbol: string; launchAt: number; status: 'OK' | 'NO_TRADES' | 'UNSUPPORTED';
  best: EnvelopeStatisticsRow | null; risk?: ContractRisk; message?: string;
}
export interface EnvelopeBatchJob {
  id: string; version: string; kind: EnvelopeBatchKind; status: 'RUNNING' | 'PAUSED' | 'COMPLETED';
  settings: BacktestSettings; updatedAt: number; message: string;
  universe: Instrument[]; cursor: number; rows: OptimizedSymbol[]; activeSearch?: EnvelopeStatisticsJob;
  sourceId?: string; state?: PortfolioState; start?: number; end?: number; blockStart?: number; result?: BacktestResult;
}
export interface EnvelopeBatchView extends Omit<EnvelopeBatchJob, 'state' | 'universe' | 'activeSearch' | 'rows'> {
  rows: Omit<OptimizedSymbol, 'risk'>[]; candidateCount: number; completed: number; total: number;
}
interface SavedBatch extends Omit<EnvelopeBatchJob, 'rows' | 'state'> { rowsKey: string; stateKey?: string }
export interface BatchHistoryEntry { id: string; at: number; kind: EnvelopeBatchKind; version?: string; settings: BacktestSettings; symbols: number; optimized: number; returnPercent?: number; sourceId?: string }
const key = (kind: EnvelopeBatchKind): string => `ENVELOPE_BATCH:${kind}`;
const archiveKey = (id: string): string => `envelope-batch:${id}`;
const historyKey = 'envelope-batch-history';

export function envelopeBatchView(job: EnvelopeBatchJob): EnvelopeBatchView {
  const { state: _state, universe, activeSearch, rows, ...view } = job;
  const total = job.kind === 'ALL_STATS' ? Math.max(1, universe.length) * statisticsTotal : Math.max(1, ((job.end ?? 0) - (job.start ?? 0)) / 900);
  const completed = job.status === 'COMPLETED' ? total : job.kind === 'ALL_STATS'
    ? job.cursor * statisticsTotal + (activeSearch ? statisticsProgress(activeSearch) : 0) : Math.max(0, ((job.blockStart ?? 0) - (job.start ?? 0)) / 900);
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
  if (job.version !== envelopeOptimizerVersion && job.status !== 'COMPLETED') job.message = canResumeEnvelopeBatch(job)
    ? '입력한 레버리지로 이어가면 고정 배율 전체통계로 전환합니다.'
    : '고정 레버리지 방식으로 변경되었습니다. 새 분석을 시작해 주세요. 기존 이력은 보존됩니다.';
  return envelopeBatchView({ ...job, status: job.status === 'RUNNING' ? 'PAUSED' : job.status });
}
export function canResumeEnvelopeBatch(job: Pick<EnvelopeBatchJob, 'version' | 'kind' | 'cursor' | 'rows'>): boolean {
  return job.version === envelopeOptimizerVersion || job.kind === 'ALL_STATS' && job.version === '2.10.38' && !job.cursor && !job.rows.length;
}
export async function loadEnvelopeBatchReport(id: string): Promise<EnvelopeBatchJob | null> {
  const value = await readValue<EnvelopeBatchJob>('results', archiveKey(id));
  return value && value.status === 'COMPLETED' && Date.now() - value.updatedAt <= retentionMs ? value : null;
}
export async function loadEnvelopeBatchHistory(kind: EnvelopeBatchKind): Promise<BatchHistoryEntry[]> {
  const entries = await readValue<BatchHistoryEntry[]>('publicData', historyKey) ?? [];
  return entries.filter(item => item.kind === kind && Date.now() - item.at <= retentionMs).sort((a, b) => b.at - a.at);
}
async function saveReport(job: EnvelopeBatchJob): Promise<void> {
  const previous = await readValue<BatchHistoryEntry[]>('publicData', historyKey) ?? [];
  const entry: BatchHistoryEntry = { id: job.id, at: job.updatedAt, kind: job.kind, version: job.version, settings: job.settings, symbols: job.universe.length,
    optimized: job.rows.filter(row => row.status === 'OK').length, ...(job.result ? { returnPercent: job.result.returnPercent } : {}), ...(job.sourceId ? { sourceId: job.sourceId } : {}) };
  const recent = [entry, ...previous.filter(item => item.id !== job.id)].filter(item => Date.now() - item.at <= retentionMs);
  const keep = recent.filter((item, index) => recent.slice(0, index).filter(other => other.kind === item.kind).length < 20);
  await writeValue('results', archiveKey(job.id), job); await writeValue('publicData', historyKey, keep);
  for (const item of previous) if (!keep.some(value => value.id === item.id)) await deleteValue('results', archiveKey(item.id));
}
function frozenSettings(settings: BacktestSettings): BacktestSettings {
  const copy = { ...fixedEnvelopeSettings(settings), mode: 'ALL' as const };
  if (!copy.endDate) { const text = new Date(Date.now() + 9 * 3600_000).toISOString(); copy.endDate = text.slice(0, 10); copy.endTime = text.slice(11, 16); }
  return copy;
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
      if (job.version !== envelopeOptimizerVersion) {
        job.version = envelopeOptimizerVersion;
        job.settings = fixedEnvelopeSettings({ ...job.settings, leverage: options.settings?.leverage ?? job.settings.leverage });
        delete job.activeSearch;
      }
      job.status = 'RUNNING';
    } else if (options.kind === 'ALL_STATS') {
      if (!options.settings) throw new Error('분석 설정이 없습니다.');
      const settings = frozenSettings(options.settings); analysisWindow({ ...settings, interval: '15m' });
      job = { id: crypto.randomUUID(), version: envelopeOptimizerVersion, kind: options.kind, status: 'RUNNING', settings, updatedAt: Date.now(), message: 'USDT 전체 종목 확인 · 슬리피지 필터 미사용', universe: [], cursor: 0, rows: [] };
    } else {
      const source = options.sourceId ? await loadEnvelopeBatchReport(options.sourceId) : null;
      if (!source || source.kind !== 'ALL_STATS' || source.version !== envelopeOptimizerVersion) throw new Error('완료된 고정 레버리지 전체통계 결과를 먼저 선택해 주세요.');
      const rows = source.rows.filter(row => row.status === 'OK' && row.best);
      if (!rows.length) throw new Error('선택한 전체통계에 가상매매 가능한 최적 세팅이 없습니다.');
      const settings = { ...fixedEnvelopeSettings(source.settings), interval: '15m' as const }; const window = analysisWindow(settings);
      job = { id: crypto.randomUUID(), version: envelopeOptimizerVersion, kind: options.kind, status: 'RUNNING', settings, updatedAt: Date.now(), message: '15분봉 공유 계좌 재검증 준비',
        sourceId: source.id, rows, universe: rows.map(row => ({ symbol: row.symbol, launchAt: row.launchAt })), cursor: 0, state: initialPortfolio(Number(settings.initialCapitalUsdt)), start: window.start, end: window.end, blockStart: window.start };
    }
    await checkpoint(true); signal.throwIfAborted();
    if (job.kind === 'ALL_STATS') {
      if (!job.universe.length) { job.universe = await listInstruments(undefined, signal); if (!job.universe.length || job.universe.length > 3000) throw new Error('USDT 종목 목록을 확인하지 못했습니다.'); await checkpoint(true); }
      while (job.cursor < job.universe.length) {
        signal.throwIfAborted(); const instrument = job.universe[job.cursor]!;
        job.activeSearch ??= { id: `${job.id}:${instrument.symbol}`, version: envelopeOptimizerVersion, settings: { ...job.settings, mode: 'SINGLE', symbol: instrument.symbol.replace(/USDT$/, '') },
          status: 'RUNNING', intervalIndex: 0, periodIndex: 0, step: 1, exitIndex: 0, updatedAt: Date.now(), message: '', rows: [], maxSteps: {}, skippedIntervals: {}, keepRows: false,
          instrument: { ...instrument, LONG: true, SHORT: true } };
        await searchEnvelopeInstrument(job.activeSearch, async force => { job!.message = `${job!.cursor + 1}/${job!.universe.length} · ${instrument.symbol} · ${job!.activeSearch!.message}`; await checkpoint(force); }, signal);
        const search = job.activeSearch;
        job.rows = [...job.rows, { ...instrument, status: search.best ? 'OK' : 'NO_TRADES', best: search.best ?? null }];
        job.cursor += 1; delete job.activeSearch; await checkpoint(true); await yieldAnalysis();
      }
    } else {
      const parameters: Record<string, BacktestSettings> = {};
      for (const row of job.rows) parameters[row.symbol] = { ...fixedEnvelopeSettings(job.settings), interval: row.best!.interval, symbol: row.symbol.replace(/USDT$/, ''), envelopeMaPeriod: String(row.best!.maPeriod), envelopeDeviationPercent: String(row.best!.deviationPercent), envelopeExitMode: row.best!.exitMode };
      const size = Math.max(1, Math.min(128, Math.floor(64000 / job.rows.length)));
      while (job.blockStart! < job.end!) {
        signal.throwIfAborted(); const start = job.blockStart!; const end = Math.min(job.end!, start + size * 900); const documents: PreparedSymbol[] = [];
        for (const row of job.rows) {
          signal.throwIfAborted(); const p = parameters[row.symbol]!; const seconds = intervalSeconds(p.interval); const period = row.best!.maPeriod;
          const candles = await ensureCandles(row, '15m', start, end, job.end, signal);
          const parentStart = Math.floor(start / seconds) * seconds - period * seconds;
          const parentEnd = Math.floor((end - 900) / seconds) * seconds;
          const parents = await ensureCandles(row, p.interval, parentStart, parentEnd, parentEnd, signal);
          const projected = projectEnvelopeBands(parents, candles, { interval: p.interval, period, deviationPercent: row.best!.deviationPercent });
          const bands = new Map(projected.bands.map(band => [band.openTime, band]));
          documents.push({ symbol: row.symbol, bars: candles.map(candle => {
            const band = bands.get(candle.openTime);
            return { candle, signal: null, ma20: null, ma60Exit: null, ...(band ? { envelope: { ...band, long: p.side !== 'SHORT', short: p.side !== 'LONG', parentOpenTime: Math.floor(candle.openTime / seconds) * seconds, sourceInterval: p.interval } } : {}) };
          }) });
          job.message = `가상매매 캔들 확인 ${row.symbol} · ${new Date(start * 1000).toLocaleDateString('ko-KR')}`; await checkpoint();
        }
        const next = structuredClone(job.state!);
        replayPortfolioBlock(next, documents, job.settings, start, end, 900, { settingsForSymbol: parameters });
        job.state = next; job.blockStart = end; job.result = { ...portfolioResult(next, job.settings), universeCount: job.rows.length };
        job.message = `공유 계좌 가상매매 · ${new Date(end * 1000).toLocaleString('ko-KR')}`; await checkpoint(true); await yieldAnalysis();
      }
    }
    job.status = 'COMPLETED'; job.message = job.kind === 'ALL_STATS' ? `전체통계 완료 · ${job.rows.length}종목 중 ${job.rows.filter(row => row.status === 'OK').length}개 최적 세팅` : '가상매매 완료 · 동일 기간 사후 최적화 기반';
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
