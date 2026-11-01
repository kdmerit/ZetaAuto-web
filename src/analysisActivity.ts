import { useEffect, useState } from 'react';
import { isAnyLocalBacktestRunning, subscribeLocalBacktest } from './localBacktest';
import { isEnvelopeStatisticsRunning, subscribeEnvelopeStatistics } from './envelopeStatisticsClient';
import { isEnvelopeBatchRunning, subscribeEnvelopeBatch } from './envelopeBatchClient';
export const isAnalysisBusy = (): boolean => isAnyLocalBacktestRunning() || isEnvelopeStatisticsRunning() || isEnvelopeBatchRunning();
export function useAnalysisBusy(): boolean {
  const [busy, setBusy] = useState(isAnalysisBusy);
  useEffect(() => {
    const refresh = () => setBusy(isAnalysisBusy());
    const unsubscribes = [subscribeEnvelopeStatistics(refresh), subscribeEnvelopeBatch('ALL_STATS', refresh), subscribeEnvelopeBatch('VIRTUAL', refresh),
      ...(['PULLBACK', 'DISPARITY', 'VOLATILITY', 'ENVELOPE'] as const).map(strategy => subscribeLocalBacktest(strategy, refresh))];
    refresh(); return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  }, []);
  return busy;
}
