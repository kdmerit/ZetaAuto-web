import { executeEnvelopeBatch, type EnvelopeBatchKind } from './envelopeBatch';
import type { BacktestSettings } from './types';
let controller: AbortController | null = null;
self.onmessage = (event: MessageEvent<{ type: 'START' | 'PAUSE'; kind: EnvelopeBatchKind; settings?: BacktestSettings; resumeId?: string; sourceId?: string }>) => {
  if (event.data.type === 'PAUSE') { controller?.abort(); return; }
  if (controller) return; controller = new AbortController();
  void executeEnvelopeBatch(event.data, view => self.postMessage({ type: 'UPDATE', view }), controller.signal)
    .catch((error: unknown) => self.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : '분석에 실패했습니다.' }))
    .finally(() => { controller = null; self.postMessage({ type: 'IDLE' }); });
};
export {};
