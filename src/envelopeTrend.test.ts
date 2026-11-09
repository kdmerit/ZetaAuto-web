import { describe, expect, it } from 'vitest';
import { currentEnvelopeSettings, dailyTrendAllows, projectDailyTrend } from './envelope';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
function day(index: number, price: number): Candle {
  return { openTime: start + (index - 25) * 86400, closeTime: start + (index - 24) * 86400, open: price, high: price + 1, low: price - 1, close: price, volume: 1 };
}
const settings = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '4h', side: 'LONG', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', envelopeMaPeriod: '5', envelopeDeviationPercent: '1' } as BacktestSettings);

describe('envelope timeframe and legacy trend helpers', () => {
  it('allows the new 1h/4h/1d trading periods and normalizes removed 15m data', () => {
    expect(currentEnvelopeSettings({ ...settings, interval: '1h', envelopeStatisticsInterval: '1h' })).toMatchObject({ interval: '1h', envelopeStatisticsInterval: '1h', envelopeExitMode: 'OPPOSITE' });
    expect(currentEnvelopeSettings({ ...settings, interval: '4h', envelopeStatisticsInterval: '4h' })).toMatchObject({ interval: '4h', envelopeStatisticsInterval: '4h', envelopeExitMode: 'OPPOSITE' });
    expect(currentEnvelopeSettings({ ...settings, interval: '1d', envelopeStatisticsInterval: '1d' })).toMatchObject({ interval: '1d', envelopeStatisticsInterval: '1d', envelopeExitMode: 'OPPOSITE' });
    expect(currentEnvelopeSettings({ ...settings, interval: '15m', envelopeStatisticsInterval: '15m' })).toMatchObject({ interval: '1h', envelopeStatisticsInterval: '1h' });
  });

  it('keeps the causal daily helper available although the current strategy ignores it', () => {
    const days = Array.from({ length: 25 }, (_, index) => day(index, 100 + index));
    const targets = [day(25, 100), { ...day(25, 100), openTime: start - 1 }].sort((a, b) => a.openTime - b.openTime);
    expect(projectDailyTrend(days, targets).get(start - 1)).toBeNull();
    expect(projectDailyTrend(days, targets).get(start)).toBeCloseTo((114.5 / 109.5 - 1) * 100, 10);
    expect(dailyTrendAllows(.5, 'LONG')).toBe(true); expect(dailyTrendAllows(-.5, 'SHORT')).toBe(true);
  });
});
