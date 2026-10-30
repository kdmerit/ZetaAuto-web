/** Worker owns data loading and replay even while the strategy screen is unmounted. */
import { executeLocalJob } from './localJobs';
import type { BacktestSettings, Strategy } from './types';

interface RunMessage {
  type: 'START' | 'PAUSE';
  settings?: BacktestSettings;
  strategy: Strategy;
  resumeId?: string;
}

let controller: AbortController | null = null;
self.onmessage = (event: MessageEvent<RunMessage>) => {
  if (event.data.type === 'PAUSE') { controller?.abort(); return; }
  if (controller) return;
  controller = new AbortController();
  void executeLocalJob(event.data, view => self.postMessage({ type: 'UPDATE', view }), controller.signal)
    .catch((error: unknown) => self.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : '브라우저 분석에 실패했습니다.' }))
    .finally(() => { controller = null; self.postMessage({ type: 'IDLE' }); });
};

export {};
