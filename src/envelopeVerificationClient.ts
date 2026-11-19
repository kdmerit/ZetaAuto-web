import { loadEnvelopeVerification, verificationKey, type EnvelopeVerificationReport, type VerificationRequest, type VerificationTarget } from './envelopeVerification';

type WorkerEvent = { type: 'UPDATE'; report: EnvelopeVerificationReport } | { type: 'ERROR'; message: string } | { type: 'IDLE' };
type Event = (WorkerEvent | { type: 'START' }) & { target: VerificationTarget };

let active: { worker: Worker; target: VerificationTarget; latest?: EnvelopeVerificationReport } | null = null;
const listeners = new Set<(event: Event) => void>();

export const isEnvelopeVerificationRunning = (target?: VerificationTarget): boolean =>
  active !== null && (!target || verificationKey(target) === verificationKey(active.target));

export function subscribeEnvelopeVerification(listener: (event: Event) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function restoreEnvelopeVerification(target: VerificationTarget): Promise<EnvelopeVerificationReport | null> {
  return isEnvelopeVerificationRunning(target) ? Promise.resolve(active!.latest ?? null) : loadEnvelopeVerification(target);
}

export function startEnvelopeVerification(request: VerificationRequest): void {
  if (active) throw new Error('월별 검증이 진행 중입니다. 먼저 일시정지해 주세요.');
  const worker = new Worker(new URL('./envelopeVerification.worker.ts', import.meta.url), { type: 'module' });
  const target: VerificationTarget = { source: request.source, sourceId: request.sourceId, direction: request.direction };
  const session = { worker, target, latest: undefined as EnvelopeVerificationReport | undefined };
  active = session;
  const publish = (event: WorkerEvent | { type: 'START' }): void => {
    for (const receive of listeners) receive({ ...event, target });
  };
  const finish = (): void => {
    worker.terminate();
    if (active === session) active = null;
  };
  worker.onmessage = ({ data }: MessageEvent<WorkerEvent>) => {
    if (data.type === 'UPDATE') session.latest = data.report;
    if (data.type === 'IDLE') finish();
    publish(data);
  };
  worker.onerror = () => {
    finish();
    publish({ type: 'ERROR', message: '검증이 중단되었습니다. 저장 지점부터 이어가 주세요.' });
    publish({ type: 'IDLE' });
  };
  worker.postMessage({ type: 'START', request });
  publish({ type: 'START' });
}

export const pauseEnvelopeVerification = (): void => { active?.worker.postMessage({ type: 'PAUSE' }); };
