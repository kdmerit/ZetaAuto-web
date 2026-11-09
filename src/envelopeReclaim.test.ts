import { describe, expect, it } from 'vitest';
import { currentEnvelopeSettings, envelopePeriods } from './envelope';
import { betterEnvelopeSetting, qualifiesEnvelopeSetting, statisticsTotalFor, type EnvelopeStatisticsRow } from './envelopeStatistics';
import type { BacktestSettings } from './types';

const base = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '4h', side: 'BOTH', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '5', envelopeMaPeriod: '20', envelopeDeviationPercent: '1' } as BacktestSettings);
const candidate: EnvelopeStatisticsRow = { interval: '4h', side: 'LONG', maPeriod: 5, deviationPercent: 1, exitMode: 'MA20', returnPercent: 2,
  entryCount: 2, winRatePercent: 60, profitUsdt: 20, realizedProfitUsdt: 20, feesUsdt: 1, closedTradeCount: 2, winCount: 1, lossCount: 1,
  maxDrawdownPercent: 1, openPositionCount: 0 };

describe('current envelope model settings', () => {
  it('offers only five periods and migrates a removed period and daily trend preference', () => {
    expect(envelopePeriods).toEqual([3, 5, 20, 60, 120]);
    expect(currentEnvelopeSettings({ ...base, envelopeMaPeriod: '10', envelopeDailyTrend: true })).toMatchObject({ envelopeMaPeriod: '20', envelopeEntryMode: 'BAND_TOUCH' });
    expect(currentEnvelopeSettings({ ...base, envelopeDailyTrend: true }).envelopeDailyTrend).toBeUndefined();
  });
  it('preserves the selected 1h/4h/1d trading and statistics periods', () => {
    for (const interval of ['1h', '4h', '1d'] as const) {
      expect(currentEnvelopeSettings({ ...base, interval, envelopeStatisticsInterval: interval })).toMatchObject({ interval, envelopeStatisticsInterval: interval, envelopeExitMode: 'OPPOSITE', envelopeMoveSlOnCenter: false });
    }
    expect(currentEnvelopeSettings({ ...base, interval: '15m', envelopeStatisticsInterval: 'ALL' })).toMatchObject({ interval: '1h', envelopeStatisticsInterval: '1h', envelopeExitMode: 'OPPOSITE' });
  });

  it('keeps the inclusive result filters and one fixed opposite-band exit case', () => {
    expect(qualifiesEnvelopeSetting(candidate)).toBe(true); expect(betterEnvelopeSetting(candidate)).toBe(true);
    expect(qualifiesEnvelopeSetting({ ...candidate, entryCount: 1 })).toBe(false);
    expect(statisticsTotalFor({ ...base, envelopeStatisticsInterval: '1h' })).toBe(2000);
    expect(statisticsTotalFor({ ...base, envelopeStatisticsInterval: '4h' })).toBe(2000);
  });
});
