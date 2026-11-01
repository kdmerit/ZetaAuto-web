/** Worker owns data loading and replay even while the strategy screen is unmounted. */
import { executeLocalJob } from './localJobs';
import type { BacktestSettings, Strategy } from './types';
import type { WeeklyUniverseSnapshot } from './universeCache';

interface RunMessage {
  type: 'START' | 'PAUSE';
  settings?: BacktestSettings;
  strategy: Strategy;
  resumeId?: string;
  universeSnapshot?: WeeklyUniverseSnapshot | null;
}

let controller: AbortController | null = null;
self.onmessage = (event: MessageEvent<RunMessage>) => {
  if (event.data.type === 'PAUSE') { controller?.abort(); return; }
  if (controller) return;
  controller = new AbortController();
  void executeLocalJob(event.data, view => self.postMessage({ type: 'UPDATE', view }), controller.signal,
    snapshot => self.postMessage({ type: 'UNIVERSE_CACHE', snapshot }))
    .catch((error: unknown) => self.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : '브라우저 분석에 실패했습니다.' }))
    .finally(() => { controller = null; self.postMessage({ type: 'IDLE' }); });
};

export {};
