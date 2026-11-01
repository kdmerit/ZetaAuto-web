import { executeEnvelopeStatistics } from './envelopeStatistics';
import type { BacktestSettings } from './types';

let controller: AbortController | null = null;
self.onmessage = (event: MessageEvent<{ type: 'START' | 'PAUSE'; settings?: BacktestSettings; resumeId?: string }>) => {
  if (event.data.type === 'PAUSE') { controller?.abort(); return; }
  if (controller) return;
  controller = new AbortController();
  void executeEnvelopeStatistics(event.data, job => self.postMessage({ type: 'UPDATE', job }), controller.signal)
    .catch((error: unknown) => self.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : '통계분석에 실패했습니다.' }))
    .finally(() => { controller = null; self.postMessage({ type: 'IDLE' }); });
};

export {};
