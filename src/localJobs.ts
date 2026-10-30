/** Persistent local jobs: exact request snapshots, bounded blocks, and recoverable checkpoints. */
import { intervalSeconds } from './api';
import { deletePrefix, deleteValue, lease, maintainCache, readValue, writeValue } from './database';
import { prepareSymbolBlock, type PreparedSymbol, type WaveState } from './engine';
import { analysisWindow, ensureCandles, instrumentEligibility, listInstruments, type EligibleInstrument, type Instrument } from './marketData';
import { initialPortfolio, portfolioResult, replayPortfolioBlock, type PortfolioState } from './portfolio';
import type { BacktestResult, BacktestSettings, Strategy } from './types';

export const localEngineVersion = '2.10.26';
export interface LocalJob {
  id: string;
  version: string;
  strategy: Strategy;
  settings: BacktestSettings;
  status: 'RUNNING' | 'PAUSED' | 'COMPLETED';
  phase: 'UNIVERSE' | 'DATA' | 'REPLAY' | 'DONE';
  start: number;
  end: number;
  blockStart: number;
  cursor: number;
  candidates: Instrument[];
  universe: EligibleInstrument[];
  excludedCount: number;
  updatedAt: number;
  message: string | null;
  state: PortfolioState;
  waveStates: Record<string, WaveState>;
}

export interface LocalJobView extends Omit<LocalJob, 'state' | 'waveStates' | 'candidates' | 'universe'> {
  candidateCount: number;
  universeCount: number;
  result: BacktestResult | null;
  completed: number;
  total: number;
  progressLabel: string;
}

export interface StoredLocalResult { settings: BacktestSettings; result: BacktestResult }
interface SavedJob extends Omit<LocalJob, 'state' | 'waveStates'> { snapshotKey: string }
interface AccountSnapshot { state: PortfolioState; waveStates: Record<string, WaveState> }

async function readJob(strategy: Strategy): Promise<LocalJob | null> {
  const header = await readValue<SavedJob>('jobs', strategy);
  if (!header) return null;
  const snapshot = await readValue<AccountSnapshot>('results', header.snapshotKey);
  if (!snapshot) throw new Error('저장된 분석 진행 상태가 없습니다. 새 분석을 시작해 주세요.');
  const { snapshotKey: _key, ...job } = header;
  return { ...job, ...snapshot };
}

export function jobView(job: LocalJob): LocalJobView {
  const { state, waveStates: _waves, candidates, universe, ...view } = job;
  const bars = (job.end - job.start) / intervalSeconds(job.settings.interval);
  const finishedBars = (job.blockStart - job.start) / intervalSeconds(job.settings.interval);
  const blockBars = Math.min(blockSize(job), bars - finishedBars);
  const current = job.phase === 'UNIVERSE' ? job.cursor : finishedBars * Math.max(1, universe.length) + job.cursor * blockBars;
  const total = job.phase === 'UNIVERSE' ? candidates.length : bars * Math.max(1, universe.length);
  const result = state.observedBars || job.status === 'COMPLETED' ? {
    ...portfolioResult(state, job.settings), localRunId: job.id,
    universeCount: universe.length, excludedCount: job.excludedCount,
  } : null;
  return {
    ...view, candidateCount: candidates.length, universeCount: universe.length, result,
    completed: job.status === 'COMPLETED' ? total : current, total,
    progressLabel: job.phase === 'UNIVERSE' ? '종목·슬리피지 확인'
      : job.phase === 'REPLAY' ? '전체 종목 시간순 계산'
        : job.phase === 'DONE' ? '분석 완료' : `캔들 확인 ${universe[job.cursor]?.symbol ?? ''}`,
  };
}

function blockSize(job: LocalJob): number {
  return Math.max(16, Math.min(128, Math.floor(64_000 / Math.max(1, job.universe.length))));
}

export async function loadLocalJob(strategy: Strategy): Promise<LocalJobView | null> {
  const job = await readJob(strategy);
  if (!job) return null;
  const view = jobView(job);
  if (view.status === 'RUNNING') view.status = 'PAUSED';
  if (view.version !== localEngineVersion && view.status !== 'COMPLETED') view.message = '분석 방식이 변경되었습니다. 새 분석을 시작해 주세요.';
  return view;
}

export async function loadLocalResult(id: string): Promise<StoredLocalResult | null> {
  return readValue('results', id);
}

async function executeWithLease(
  options: { strategy: Strategy; settings?: BacktestSettings; resumeId?: string },
  publish: (view: LocalJobView) => void,
  signal: AbortSignal,
  useLease: boolean,
): Promise<void> {
  const owner = crypto.randomUUID();
  let job: LocalJob | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  let savedState: PortfolioState | null = null;
  let savedSnapshotKey: string | null = null;
  let previousJob: SavedJob | null = null;
  let lastPublishedAt = 0;
  let lastPublishedPhase = '';
  if (useLease && !await lease(owner)) throw new Error('다른 탭에서 분석 중입니다. 해당 탭의 분석을 일시정지한 뒤 다시 시도해 주세요.');
  const checkpoint = async () => {
    if (!job) return;
    if (useLease && (leaseLost || !await lease(owner))) throw new Error('다른 탭에서 분석을 시작했습니다. 다시 이어가 주세요.');
    job.updatedAt = Date.now();
    const snapshotKey = `checkpoint:${job.id}:${job.blockStart}`;
    if (savedState !== job.state) await writeValue('results', snapshotKey, { state: job.state, waveStates: job.waveStates } satisfies AccountSnapshot);
    const { state, waveStates: _waves, ...header } = job;
    // Header switches to a fully committed snapshot; the previous snapshot survives a crash before this write.
    await writeValue('jobs', job.strategy, { ...header, snapshotKey } satisfies SavedJob);
    if (savedSnapshotKey && savedSnapshotKey !== snapshotKey) await deleteValue('results', savedSnapshotKey);
    savedState = state;
    savedSnapshotKey = snapshotKey;
    const signature = `${job.blockStart}:${job.phase}:${job.status}`;
    if (signature !== lastPublishedPhase || Date.now() - lastPublishedAt >= 250) {
      publish(jobView(job));
      lastPublishedAt = Date.now();
      lastPublishedPhase = signature;
    }
  };
  try {
    if (useLease) heartbeat = setInterval(() => { void lease(owner).then(held => { leaseLost ||= !held; }).catch(() => { leaseLost = true; }); }, 10_000);
    await maintainCache();
    signal.throwIfAborted();
    if (options.resumeId) {
      const saved = await readJob(options.strategy);
      if (!saved || saved.id !== options.resumeId || saved.status === 'COMPLETED') throw new Error('이어갈 분석을 찾지 못했습니다.');
      if (saved.version !== localEngineVersion) throw new Error('분석 방식이 변경되었습니다. 새 분석을 시작해 주세요.');
      job = saved;
      job.status = 'RUNNING';
      job.message = null;
      savedState = job.state;
      savedSnapshotKey = `checkpoint:${job.id}:${job.blockStart}`;
    } else {
      if (!options.settings) throw new Error('분석 설정이 없습니다.');
      const settings = structuredClone(options.settings);
      const { start, end } = analysisWindow(settings);
      previousJob = await readValue<SavedJob>('jobs', options.strategy);
      job = {
        id: crypto.randomUUID(), version: localEngineVersion, strategy: options.strategy, settings,
        status: 'RUNNING', phase: 'UNIVERSE', start, end, blockStart: start, cursor: 0,
        candidates: [], universe: [], excludedCount: 0, updatedAt: Date.now(), message: null,
        state: initialPortfolio(Number(settings.initialCapitalUsdt)), waveStates: {},
      };
    }
    await checkpoint();
    if (previousJob) { await deletePrefix('prepared', `${previousJob.id}:`); await deleteValue('results', previousJob.snapshotKey); }
    if (job.phase === 'UNIVERSE') {
      if (!job.candidates.length) {
        job.candidates = await listInstruments(job.settings.mode === 'SINGLE' ? `${job.settings.symbol.replace(/USDT$/i, '').toUpperCase()}USDT` : undefined, signal);
        if (!job.candidates.length || job.candidates.length > 3000) throw new Error('분석할 USDT 종목을 확인하지 못했습니다.');
        await checkpoint();
      }
      while (job.cursor < job.candidates.length) {
        signal.throwIfAborted();
        const selected = job.candidates.slice(job.cursor, job.cursor + 4);
        const checked = await Promise.all(selected.map(instrument => instrumentEligibility(instrument, signal)));
        for (const instrument of checked) {
          const eligible = job.settings.side === 'BOTH' ? instrument.LONG || instrument.SHORT : instrument[job.settings.side];
          if (eligible) job.universe.push(instrument);
          else job.excludedCount += 1;
        }
        job.cursor += selected.length;
        await checkpoint();
      }
      if (!job.universe.length) throw new Error('현재 슬리피지 조건을 통과한 종목이 없습니다. 새 분석을 시작해 주세요.');
      job.universe.sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
      job.cursor = 0;
      job.phase = 'DATA';
      await checkpoint();
    }
    const seconds = intervalSeconds(job.settings.interval);
    while (job.blockStart < job.end) {
      signal.throwIfAborted();
      const blockEnd = Math.min(job.end, job.blockStart + blockSize(job) * seconds);
      const prefix = `${job.id}:${job.blockStart}:`;
      while (job.cursor < job.universe.length) {
        signal.throwIfAborted();
        const instrument = job.universe[job.cursor]!;
        const candles = await ensureCandles(instrument, job.settings.interval, job.blockStart - 200 * seconds, blockEnd, job.end, signal);
        const prepared = prepareSymbolBlock(instrument.symbol, candles, job.settings, job.strategy, job.blockStart, blockEnd, job.waveStates[instrument.symbol]);
        for (const bar of prepared.bars) if (bar.signal && !instrument[bar.signal.side]) bar.signal = null;
        await writeValue('prepared', prefix + instrument.symbol, prepared);
        job.cursor += 1;
        if (job.cursor % 4 === 0 || job.cursor === job.universe.length) await checkpoint();
      }
      signal.throwIfAborted();
      job.phase = 'REPLAY';
      publish(jobView(job));
      const documents: PreparedSymbol[] = [];
      for (const instrument of job.universe) {
        const document = await readValue<PreparedSymbol>('prepared', prefix + instrument.symbol);
        if (!document) throw new Error('저장된 중간 데이터가 없습니다. 새 분석을 시작해 주세요.');
        documents.push(document);
      }
      signal.throwIfAborted();
      const next = structuredClone(job.state);
      replayPortfolioBlock(next, documents, job.settings, job.blockStart, blockEnd, seconds);
      job.state = next;
      for (const document of documents) if (document.waveState) job.waveStates[document.symbol] = document.waveState;
      job.blockStart = blockEnd;
      job.cursor = 0;
      job.phase = 'DATA';
      await checkpoint();
      await deletePrefix('prepared', prefix);
      await maintainCache();
    }
    job.status = 'COMPLETED';
    job.phase = 'DONE';
    job.message = '분석이 완료되었습니다.';
    const result = jobView(job).result ?? { ...portfolioResult(job.state, job.settings), localRunId: job.id, universeCount: job.universe.length, excludedCount: job.excludedCount };
    await writeValue('results', job.id, { settings: job.settings, result } satisfies StoredLocalResult);
    await checkpoint();
  } catch (error) {
    if (!job) throw error;
    job.status = 'PAUSED';
    job.phase = job.phase === 'REPLAY' ? 'DATA' : job.phase;
    job.message = signal.aborted ? '분석을 일시정지했습니다. 저장된 지점부터 이어갈 수 있습니다.'
      : error instanceof Error ? error.message : '분석을 중단했습니다. 다시 이어가 주세요.';
    await checkpoint();
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (useLease) await lease(owner, true);
  }
}

/** Chrome releases a Web Lock immediately when its worker/tab ends; leases cover older browsers. */
export async function executeLocalJob(
  options: { strategy: Strategy; settings?: BacktestSettings; resumeId?: string },
  publish: (view: LocalJobView) => void,
  signal: AbortSignal,
): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('zetaauto-local-analysis', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('다른 탭에서 분석 중입니다. 해당 탭의 분석을 일시정지해 주세요.');
      await executeWithLease(options, publish, signal, false);
    });
  }
  return executeWithLease(options, publish, signal, true);
}
