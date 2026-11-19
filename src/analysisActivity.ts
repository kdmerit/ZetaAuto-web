import { useEffect, useState } from 'react';
import { isAnyLocalBacktestRunning, subscribeLocalBacktest } from './localBacktest';
import { isEnvelopeStatisticsRunning, subscribeEnvelopeStatistics } from './envelopeStatisticsClient';
import { isEnvelopeBatchRunning, subscribeEnvelopeBatch } from './envelopeBatchClient';
import { isEnvelopeVerificationRunning, subscribeEnvelopeVerification } from './envelopeVerificationClient';
export const isAnalysisBusy = (): boolean => isAnyLocalBacktestRunning() || isEnvelopeStatisticsRunning() || isEnvelopeBatchRunning() || isEnvelopeVerificationRunning();
export function useAnalysisBusy(): boolean {
  const [busy, setBusy] = useState(isAnalysisBusy);
  useEffect(() => {
    const refresh = () => setBusy(isAnalysisBusy());
    const unsubscribes = [subscribeEnvelopeStatistics(refresh), subscribeEnvelopeBatch('ALL_STATS', refresh), subscribeEnvelopeBatch('VIRTUAL', refresh), subscribeEnvelopeVerification(refresh),
      ...(['PULLBACK', 'DISPARITY', 'VOLATILITY', 'ENVELOPE', 'ATR_ENVELOPE', 'NEW_HIGH', 'REFERENCE', 'CANDLE_BREAKOUT'] as const).map(strategy => subscribeLocalBacktest(strategy, refresh))];
    refresh(); return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  }, []);
  return busy;
}
