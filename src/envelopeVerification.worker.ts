import type { VerificationRequest } from './envelopeVerification';
import { executeEnvelopeVerification } from './envelopeVerificationJob';

let controller: AbortController | null = null;
self.onmessage = (event: MessageEvent<{ type: 'START'; request: VerificationRequest } | { type: 'PAUSE' }>) => {
  if (event.data.type === 'PAUSE') { controller?.abort(); return; }
  if (controller) return;
  const { request } = event.data;
  controller = new AbortController();
  void executeEnvelopeVerification(request, report => self.postMessage({ type: 'UPDATE', report }), controller.signal)
    .catch((error: unknown) => self.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : '월별 검증에 실패했습니다.' }))
    .finally(() => { controller = null; self.postMessage({ type: 'IDLE' }); });
};

export {};
