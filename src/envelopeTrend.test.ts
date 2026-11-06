import { describe, expect, it } from 'vitest';
import { currentEnvelopeSettings, dailyTrendAllows, projectDailyTrend } from './envelope';
import { prepareSymbolBlock } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const settings = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '4h', side: 'LONG', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', envelopeMaPeriod: '5', envelopeDeviationPercent: '1' } as BacktestSettings);
function day(index: number, price: number): Candle {
  return { openTime: start + (index - 25) * 86400, closeTime: start + (index - 24) * 86400, open: price, high: price + 1, low: price - 1, close: price, volume: 1 };
}
function setup(trend: number | null): Candle[] {
  const values = [[100, 101.5, 99.5, 100], [99.5, 100.4, 99.5, 99.8], [100, 101.2, 99.8, 101]];
  return [...Array.from({ length: 5 }, (_, index) => ({ ...day(25, 100), openTime: start + index * 3600, closeTime: start + (index + 1) * 3600 })), ...values.map((value, index) => ({ openTime: start + (index + 5) * 3600, closeTime: start + (index + 6) * 3600, open: value[0]!, high: value[1]!, low: value[2]!, close: value[3]!, volume: 1, ...(index === 1 ? { trend } : {}) }))];
}

describe('envelope legacy trend input', () => {
  it('normalizes all old timeframe preferences to the fixed hourly model and uses the new exit metadata', () => {
    for (const interval of ['15m', '1h', '4h', '1d'] as const) expect(currentEnvelopeSettings({ ...settings, interval, envelopeStatisticsInterval: 'ALL', envelopeMaPeriod: '120' }))
      .toMatchObject({ interval: '1h', envelopeStatisticsInterval: '1h', envelopeMaPeriod: '120', envelopeExitMode: 'OPPOSITE' });
  });
  it('keeps the causal daily trend helper available for archived settings', () => {
    const days = Array.from({ length: 25 }, (_, index) => day(index, 100 + index));
    const targets = [day(25, 100), { ...day(25, 100), openTime: start - 1 }].sort((a, b) => a.openTime - b.openTime);
    expect(projectDailyTrend(days, targets).get(start - 1)).toBeNull();
    expect(projectDailyTrend(days, targets).get(start)).toBeCloseTo((114.5 / 109.5 - 1) * 100, 10);
    expect(dailyTrendAllows(.5, 'LONG')).toBe(true); expect(dailyTrendAllows(-.5, 'SHORT')).toBe(true);
  });
  it('does not apply the old daily trend filter to the new centre-touch entry', () => {
    for (const trend of [null, -100]) {
      const parameters = { ...settings, envelopeDailyTrend: true };
      const candles = setup(trend); const document = prepareSymbolBlock('BTCUSDT', candles, parameters, 'ENVELOPE', candles[5]!.openTime, candles.at(-1)!.closeTime);
      const state = initialPortfolio(1000); replayPortfolioBlock(state, [document], parameters, candles[5]!.openTime, candles.at(-1)!.closeTime, 3600);
      expect(portfolioResult(state, parameters).entryCount).toBe(1);
    }
  });
});
