import { loadEnvelopeBatch, type EnvelopeBatchKind, type EnvelopeBatchView } from './envelopeBatch';
import type { BacktestSettings } from './types';
type Event = { type: 'UPDATE'; view: EnvelopeBatchView } | { type: 'ERROR'; message: string } | { type: 'IDLE' };
let worker: Worker | null = null; let active: EnvelopeBatchKind | null = null;
const views = new Map<EnvelopeBatchKind, EnvelopeBatchView>(); const listeners = new Map<EnvelopeBatchKind, Set<(event: Event) => void>>();
export const isEnvelopeBatchRunning = (kind?: EnvelopeBatchKind): boolean => worker !== null && (!kind || active === kind);
export function subscribeEnvelopeBatch(kind: EnvelopeBatchKind, listener: (event: Event) => void): () => void {
  if (!listeners.has(kind)) listeners.set(kind, new Set()); listeners.get(kind)!.add(listener); return () => { listeners.get(kind)?.delete(listener); };
}
export const restoreEnvelopeBatch = async (kind: EnvelopeBatchKind): Promise<EnvelopeBatchView | null> => isEnvelopeBatchRunning(kind) ? views.get(kind) ?? loadEnvelopeBatch(kind) : loadEnvelopeBatch(kind);
function saveLocal(view: EnvelopeBatchView): void {
  try {
    if (view.kind === 'ALL_STATS') localStorage.setItem('zetaauto.web.envelope.allStatistics.latest', JSON.stringify({ id: view.id, version: view.version, settings: view.settings, updatedAt: view.updatedAt, rows: view.rows }));
    const storageKey = `zetaauto.web.envelope.${view.kind}.history`;
    const previous = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as { id: string; at: number }[];
    localStorage.setItem(storageKey, JSON.stringify([{ id: view.id, at: view.updatedAt, version: view.version, settings: view.settings, sourceId: view.sourceId, returnPercent: view.result?.returnPercent }, ...previous.filter(item => item.id !== view.id && Date.now() - item.at <= 30 * 86400000)].slice(0, 20)));
  } catch { /* Full reports also remain in IndexedDB. */ }
}
export function startEnvelopeBatch(kind: EnvelopeBatchKind, settings?: BacktestSettings, resumeId?: string, sourceId?: string): void {
  if (worker) throw new Error('전체통계 또는 가상매매가 진행 중입니다. 먼저 일시정지해 주세요.');
  active = kind; worker = new Worker(new URL('./envelopeBatch.worker.ts', import.meta.url), { type: 'module' }); const instance = worker;
  const notify = (event: Event): void => { for (const listener of listeners.get(kind) ?? []) listener(event); };
  instance.onmessage = (event: MessageEvent<Event>) => {
    const message = event.data;
    if (message.type === 'UPDATE') { views.set(kind, message.view); if (message.view.status === 'COMPLETED') saveLocal(message.view); }
    if (message.type === 'IDLE') { instance.terminate(); if (worker === instance) { worker = null; active = null; } }
    notify(message);
  };
  instance.onerror = () => { instance.terminate(); if (worker === instance) { worker = null; active = null; } notify({ type: 'ERROR', message: '분석이 중단되었습니다. 저장 지점부터 이어가 주세요.' }); notify({ type: 'IDLE' }); };
  instance.postMessage({ type: 'START', kind, settings, resumeId, sourceId });
}
export const pauseEnvelopeBatch = (): void => worker?.postMessage({ type: 'PAUSE' });
