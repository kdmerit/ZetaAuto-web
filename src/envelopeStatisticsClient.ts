import { loadEnvelopeStatistics, type EnvelopeStatisticsJob } from './envelopeStatistics';
import type { BacktestSettings } from './types';

type Event = { type: 'UPDATE'; job: EnvelopeStatisticsJob } | { type: 'ERROR'; message: string } | { type: 'IDLE' };
let worker: Worker | null = null;
let latest: EnvelopeStatisticsJob | null = null;
const listeners = new Set<(event: Event) => void>();
const notify = (event: Event): void => { for (const receive of listeners) receive(event); };
export const isEnvelopeStatisticsRunning = (): boolean => worker !== null;
export const subscribeEnvelopeStatistics = (receive: (event: Event) => void): (() => void) => { listeners.add(receive); return () => { listeners.delete(receive); }; };
export const restoreEnvelopeStatistics = async (): Promise<EnvelopeStatisticsJob | null> => worker && latest ? latest : loadEnvelopeStatistics();

export function startEnvelopeStatistics(settings: BacktestSettings, resumeId?: string): void {
  if (worker) throw new Error('통계분석이 진행 중입니다.');
  if (settings.mode !== 'SINGLE') throw new Error('통계분석은 개별종목에서만 가능합니다.');
  worker = new Worker(new URL('./envelopeStatistics.worker.ts', import.meta.url), { type: 'module' });
  const instance = worker;
  instance.onmessage = (event: MessageEvent<Event>) => {
    if (event.data.type === 'UPDATE') latest = event.data.job;
    if (event.data.type === 'IDLE') { instance.terminate(); if (worker === instance) worker = null; }
    notify(event.data);
  };
  instance.onerror = () => {
    instance.terminate(); if (worker === instance) worker = null;
    if (latest) latest = { ...latest, status: 'PAUSED' };
    notify({ type: 'ERROR', message: '통계분석이 중단되었습니다. 저장한 조건부터 이어가 주세요.' });
    notify({ type: 'IDLE' });
  };
  instance.postMessage({ type: 'START', settings, resumeId });
}

export const pauseEnvelopeStatistics = (): void => worker?.postMessage({ type: 'PAUSE' });
