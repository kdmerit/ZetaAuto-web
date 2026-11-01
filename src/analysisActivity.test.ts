import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAnalysisBusy } from './analysisActivity';
import { startLocalBacktest, subscribeLocalBacktest } from './localBacktest';
import { startEnvelopeStatistics, subscribeEnvelopeStatistics } from './envelopeStatisticsClient';
import { startEnvelopeBatch, subscribeEnvelopeBatch } from './envelopeBatchClient';
import type { BacktestSettings } from './types';

class TestWorker {
  static latest: TestWorker | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { TestWorker.latest = this; }
  idle(): void { this.onmessage?.({ data: { type: 'IDLE' } } as MessageEvent); }
}
// Only controller transport is exercised; no calculation reads these settings.
const settings = { mode: 'SINGLE' } as BacktestSettings;
beforeEach(() => {
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('navigator', { storage: { persist: async () => false } });
});
afterEach(() => { TestWorker.latest?.idle(); TestWorker.latest = undefined; vi.unstubAllGlobals(); });

describe('shared analysis activity notifications', () => {
  for (const kind of ['ORDINARY', 'SINGLE_STATS', 'ALL_STATS', 'VIRTUAL'] as const) {
    it(`clears ${kind} activity before notifying the page so analysis controls re-enable`, () => {
      let activeAtIdle: boolean | undefined;
      const receive = (event: { type: string }): void => { if (event.type === 'IDLE') activeAtIdle = isAnalysisBusy(); };
      const unsubscribe = kind === 'ORDINARY' ? subscribeLocalBacktest('ENVELOPE', receive)
        : kind === 'SINGLE_STATS' ? subscribeEnvelopeStatistics(receive) : subscribeEnvelopeBatch(kind, receive);
      try {
        expect(isAnalysisBusy()).toBe(false);
        if (kind === 'ORDINARY') startLocalBacktest('ENVELOPE', settings);
        else if (kind === 'SINGLE_STATS') startEnvelopeStatistics(settings);
        else startEnvelopeBatch(kind, settings);
        expect(isAnalysisBusy()).toBe(true);
        TestWorker.latest!.idle();
        expect(activeAtIdle).toBe(false); expect(isAnalysisBusy()).toBe(false);
        expect(TestWorker.latest!.terminate).toHaveBeenCalledTimes(1);
      } finally { unsubscribe(); }
    });
  }
});
