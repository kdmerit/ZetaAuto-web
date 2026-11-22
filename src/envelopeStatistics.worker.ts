import { executeEnvelopeStatistics, type EnvelopeStatisticsRequest } from './envelopeStatistics';

let controller: AbortController | null = null;
self.onmessage = (event: MessageEvent<{ type: 'START'; request: EnvelopeStatisticsRequest } | { type: 'PAUSE' }>) => {
  if (event.data.type === 'PAUSE') { controller?.abort(); return; }
  if (controller) return;
  controller = new AbortController();
  void executeEnvelopeStatistics(event.data.request, job => self.postMessage({ type: 'UPDATE', job }), controller.signal)
    .catch((error: unknown) => self.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : '통계분석에 실패했습니다.' }))
    .finally(() => { controller = null; self.postMessage({ type: 'IDLE' }); });
};

export {};
