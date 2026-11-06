import { describe, expect, it } from 'vitest';
import { prepareSymbolBlock } from './engine';
import { currentEnvelopeSettings } from './envelope';
import { betterEnvelopeSetting, qualifiesEnvelopeSetting, statisticsTotalFor, type EnvelopeStatisticsRow } from './envelopeStatistics';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const base: BacktestSettings = currentEnvelopeSettings({
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'LONG', startDate: '2026-02-01', startTime: '09:00', endDate: '2026-02-13', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '5', partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1',
  ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true,
  volatilityNextCloseEnabled: false, envelopeMaPeriod: '5', envelopeDeviationPercent: '1', envelopeDailyTrend: false,
});
const candle = (index: number, values: number[]): Candle => ({ openTime: start + index * 3600, closeTime: start + (index + 1) * 3600,
  open: values[0]!, high: values[1]!, low: values[2]!, close: values[3]!, volume: 10 });
function rows(short = false): Candle[] {
  const tail = [[100, 101.5, 99.5, 100], [99.5, 100.4, 99.5, 99.8], [100, 101.2, 99.8, 101]];
  return [...Array.from({ length: 5 }, (_, index) => candle(index, [100, 100, 100, 100])), ...tail.map((values, index) => {
    const p = short ? [200 - values[0]!, 200 - values[2]!, 200 - values[1]!, 200 - values[3]!] : values;
    return candle(index + 5, p);
  })];
}

describe('fixed envelope centre-touch model', () => {
  it.each([false, true])('uses the previous opposite-band touch for %s positions and ignores the legacy trend toggle', short => {
    const parameters = { ...base, side: short ? 'SHORT' as const : 'LONG' as const, envelopeDailyTrend: true };
    const all = rows(short); const document = prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', all[5]!.openTime, all.at(-1)!.closeTime);
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], parameters, all[5]!.openTime, all.at(-1)!.closeTime, 3600);
    const result = portfolioResult(state, parameters); const trade = result.recentTrades[0]!;
    expect(result.entryCount).toBe(1); expect(trade.reason).toBe('ENVELOPE_OPPOSITE');
    expect(trade.signal.stop).toBe(short ? 101 : 99); expect(trade.signal.target).toBe(short ? 99 : 101);
  });
  it('forces the new fixed exit metadata while retaining the old input fields', () => {
    expect(currentEnvelopeSettings({ ...base, envelopeExitMode: 'HALF', envelopeMoveSlOnCenter: true })).toMatchObject({
      envelopeExitMode: 'OPPOSITE', envelopeMoveSlOnCenter: false, envelopeEntryMode: 'RECLAIM',
    });
  });
});

describe('envelope statistics selection', () => {
  const candidate: EnvelopeStatisticsRow = { interval: '1h', side: 'LONG', maPeriod: 5, deviationPercent: 1, exitMode: 'OPPOSITE', returnPercent: 2,
    entryCount: 2, winRatePercent: 60, profitUsdt: 20, realizedProfitUsdt: 20, feesUsdt: 1, closedTradeCount: 2, winCount: 1, lossCount: 1,
    maxDrawdownPercent: 1, openPositionCount: 0 };
  it('keeps the inclusive optimal-setting filters', () => {
    expect(qualifiesEnvelopeSetting(candidate)).toBe(true); expect(betterEnvelopeSetting(candidate)).toBe(true);
    expect(qualifiesEnvelopeSetting({ ...candidate, entryCount: 1 })).toBe(false);
    expect(qualifiesEnvelopeSetting({ ...candidate, winRatePercent: 59.99 })).toBe(false);
    expect(qualifiesEnvelopeSetting({ ...candidate, returnPercent: 1.99 })).toBe(false);
  });
  it('compares one fixed opposite-band exit across both directions', () => {
    const both = { ...base, side: 'BOTH' as const, envelopeStatisticsInterval: '1h' as const };
    expect(statisticsTotalFor(both)).toBe(3200); expect(statisticsTotalFor({ ...both, envelopeStatisticsInterval: 'ALL' })).toBe(3200);
    expect(currentEnvelopeSettings({ ...base, envelopeExitMode: 'CENTER' })).toMatchObject({ envelopeExitMode: 'OPPOSITE' });
  });
});
