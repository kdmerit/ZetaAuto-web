import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAnalysisBusy } from './analysisActivity';
import { startLocalBacktest, subscribeLocalBacktest } from './localBacktest';
import { finishEnvelopeStatistics, isEnvelopeStatisticsFinishing, pauseEnvelopeStatistics, startEnvelopeStatistics, subscribeEnvelopeStatistics } from './envelopeStatisticsClient';
import { startEnvelopeVerification, subscribeEnvelopeVerification } from './envelopeVerificationClient';
import { defaultEnvelopeResultOptions } from './envelopeResults';
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
  for (const kind of ['ORDINARY', 'SINGLE_STATS', 'FINISH_STATS', 'VERIFICATION'] as const) {
    it(`clears ${kind} activity before notifying the page so analysis controls re-enable`, () => {
      let activeAtIdle: boolean | undefined;
      const receive = (event: { type: string }): void => { if (event.type === 'IDLE') activeAtIdle = isAnalysisBusy(); };
      const unsubscribe = kind === 'ORDINARY' ? subscribeLocalBacktest('ENVELOPE', receive)
        : kind === 'VERIFICATION' ? subscribeEnvelopeVerification(receive) : subscribeEnvelopeStatistics(receive);
      try {
        expect(isAnalysisBusy()).toBe(false);
        if (kind === 'ORDINARY') startLocalBacktest('ENVELOPE', settings);
        else if (kind === 'SINGLE_STATS') startEnvelopeStatistics(settings);
        else if (kind === 'VERIFICATION') startEnvelopeVerification({ source: 'SINGLE_STATS', sourceId: 'fixture', direction: 'PAST', months: 1, resultOptions: defaultEnvelopeResultOptions });
        else {
          finishEnvelopeStatistics('paused', defaultEnvelopeResultOptions);
          expect(TestWorker.latest!.postMessage).toHaveBeenCalledWith({ type: 'START', request: { finishId: 'paused', resultOptions: defaultEnvelopeResultOptions } });
          expect(isEnvelopeStatisticsFinishing()).toBe(true);
          pauseEnvelopeStatistics();
          expect(TestWorker.latest!.postMessage).toHaveBeenCalledTimes(1);
        }
        expect(isAnalysisBusy()).toBe(true);
        TestWorker.latest!.idle();
        expect(activeAtIdle).toBe(false); expect(isAnalysisBusy()).toBe(false);
        expect(isEnvelopeStatisticsFinishing()).toBe(false);
        expect(TestWorker.latest!.terminate).toHaveBeenCalledTimes(1);
      } finally { unsubscribe(); }
    });
  }
});
