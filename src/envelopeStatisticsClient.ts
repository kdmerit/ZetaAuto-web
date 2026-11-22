import { loadEnvelopeStatistics, type EnvelopeStatisticsJob, type EnvelopeStatisticsRequest } from './envelopeStatistics';
import type { BacktestSettings, EnvelopeResultOptions } from './types';

type Event = { type: 'UPDATE'; job: EnvelopeStatisticsJob } | { type: 'ERROR'; message: string } | { type: 'START' | 'IDLE' };
let worker: Worker | null = null;
let latest: EnvelopeStatisticsJob | null = null;
let finishing = false;
const listeners = new Set<(event: Event) => void>();
const notify = (event: Event): void => { for (const receive of listeners) receive(event); };
export const isEnvelopeStatisticsRunning = (): boolean => worker !== null;
export const isEnvelopeStatisticsFinishing = (): boolean => finishing;
export const subscribeEnvelopeStatistics = (receive: (event: Event) => void): (() => void) => { listeners.add(receive); return () => { listeners.delete(receive); }; };
export const restoreEnvelopeStatistics = async (): Promise<EnvelopeStatisticsJob | null> => worker && latest ? latest : loadEnvelopeStatistics();

function runEnvelopeStatistics(request: EnvelopeStatisticsRequest): void {
  if (worker) throw new Error('통계분석이 진행 중입니다.');
  worker = new Worker(new URL('./envelopeStatistics.worker.ts', import.meta.url), { type: 'module' });
  const instance = worker;
  finishing = 'finishId' in request;
  const dispose = (): void => {
    instance.terminate();
    if (worker === instance) { worker = null; finishing = false; }
  };
  instance.onmessage = (event: MessageEvent<Event>) => {
    if (event.data.type === 'UPDATE') latest = event.data.job;
    if (event.data.type === 'IDLE') dispose();
    notify(event.data);
  };
  instance.onerror = () => {
    dispose();
    if (latest?.status === 'RUNNING') latest = { ...latest, status: 'PAUSED' };
    notify({ type: 'ERROR', message: '통계분석이 중단되었습니다. 저장한 조건부터 이어가 주세요.' });
    notify({ type: 'IDLE' });
  };
  try { instance.postMessage({ type: 'START', request }); }
  catch (error) { dispose(); throw error; }
  notify({ type: 'START' });
}

export function startEnvelopeStatistics(settings: BacktestSettings, resumeId?: string): void {
  if (settings.mode !== 'SINGLE') throw new Error('통계분석은 개별종목에서만 가능합니다.');
  runEnvelopeStatistics(resumeId ? { resumeId } : { settings });
}

export function finishEnvelopeStatistics(finishId: string, resultOptions: EnvelopeResultOptions): void {
  runEnvelopeStatistics({ finishId, resultOptions });
}

export const pauseEnvelopeStatistics = (): void => { if (!finishing) worker?.postMessage({ type: 'PAUSE' }); };
