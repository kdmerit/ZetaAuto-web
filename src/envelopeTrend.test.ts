import { describe, expect, it } from 'vitest';
import { currentEnvelopeSettings, dailyTrendAllows, projectDailyTrend } from './envelope';
import { prepareSymbolBlock, type PreparedSymbol } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import { profitRatio } from './envelopeResults';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const settings = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '4h', side: 'LONG', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
  envelopeMaPeriod: '5', envelopeDeviationPercent: '1' } as BacktestSettings);
function day(index: number, price: number): Candle {
  return { openTime: start + (index - 25) * 86400, closeTime: start + (index - 24) * 86400, open: price, high: price + 1, low: price - 1, close: price, volume: 1 };
}
function document(trends: (number | null | undefined)[], side: 'LONG' | 'SHORT' = 'LONG'): PreparedSymbol {
  const prices = [[100, 100.2, 98.6, 98.8], [98.8, 99.5, 98.7, 99.4], [99.4, 101.2, 99.3, 101]];
  return { symbol: 'BTCUSDT', bars: trends.map((trend, i) => {
    const p = prices[i % 3]!; const q = side === 'LONG' ? p : [200 - p[0]!, 200 - p[2]!, 200 - p[1]!, 200 - p[3]!];
    return { candle: { openTime: start + i * 3600, closeTime: start + (i + 1) * 3600, open: q[0]!, high: q[1]!, low: q[2]!, close: q[3]!, volume: 1 },
      signal: null, ma20: null, ma60Exit: null, envelope: { center: 100, lower: 99, upper: 101, long: side === 'LONG', short: side === 'SHORT', dailyTrendChangePercent: trend } };
  }) };
}
function run(doc: PreparedSymbol, side: 'LONG' | 'SHORT') {
  const p = { ...settings, side }; const state = initialPortfolio(1000);
  replayPortfolioBlock(state, [doc], p, start, doc.bars.at(-1)!.candle.closeTime, 3600);
  return portfolioResult(state, p);
}

describe('hourly envelope with causal daily MA20 trend', () => {
  it('normalizes every former timeframe and statistic selection to hourly without changing SMA length', () => {
    for (const interval of ['15m', '1h', '4h', '1d'] as const) expect(currentEnvelopeSettings({ ...settings, interval, envelopeStatisticsInterval: 'ALL', envelopeMaPeriod: '120' }))
      .toMatchObject({ interval: '1h', envelopeStatisticsInterval: '1h', envelopeDailyTrend: true, envelopeMaPeriod: '120' });
    expect(currentEnvelopeSettings({ ...settings, envelopeDailyTrend: false }).envelopeDailyTrend).toBe(false);
  });
  it('compares the latest closed 20-day average against five daily candles earlier, requiring 25 closes', () => {
    const days = Array.from({ length: 25 }, (_, i) => day(i, 100 + i));
    const targets = [day(25, 100), { ...day(25, 100), openTime: start - 1 }];
    const trend = projectDailyTrend(days, targets.sort((a, b) => a.openTime - b.openTime));
    expect(trend.get(start - 1)).toBeNull(); expect(trend.get(start)).toBeCloseTo((114.5 / 109.5 - 1) * 100, 10);
  });
  it('ignores live/future daily closes and only updates at the next daily close boundary', () => {
    const days = Array.from({ length: 25 }, (_, i) => day(i, 100 + i)); const future = day(25, 10000);
    const targets = [start, start + 12 * 3600, start + 86400].map(at => ({ ...future, openTime: at }));
    const changes = projectDailyTrend([...days, future], targets);
    expect(changes.get(start)).toBe(changes.get(start + 12 * 3600)); expect(changes.get(start + 86400)).toBeGreaterThan(100);
    expect(projectDailyTrend([...days, { ...future, close: 1 }], targets).get(start)).toBe(changes.get(start));
  });
  it('accepts inclusive positive/negative 0.5% boundaries and fails closed on missing, flat or invalid trends', () => {
    expect(dailyTrendAllows(.5, 'LONG')).toBe(true); expect(dailyTrendAllows(-.5, 'SHORT')).toBe(true);
    for (const value of [null, undefined, NaN, Infinity, 0, .49999]) expect(dailyTrendAllows(value, 'LONG')).toBe(false);
    for (const value of [null, undefined, NaN, -Infinity, 0, -.49999]) expect(dailyTrendAllows(value, 'SHORT')).toBe(false);
  });
  it('projects daily data independently of the hourly center calculation and does not fabricate missing history', () => {
    const candles = Array.from({ length: 8 }, (_, i) => ({ ...day(25, 100), openTime: start + i * 3600, closeTime: start + (i + 1) * 3600 }));
    const days = Array.from({ length: 25 }, (_, i) => day(i, 100 + i));
    const valid = prepareSymbolBlock('BTCUSDT', candles, settings, 'ENVELOPE', start, start + 8 * 3600, undefined, undefined, days);
    const missing = prepareSymbolBlock('BTCUSDT', candles, settings, 'ENVELOPE', start, start + 8 * 3600);
    expect(valid.bars.at(-1)!.envelope).toMatchObject({ center: 100, lower: 99, upper: 101 });
    expect(valid.bars.at(-1)!.envelope!.dailyTrendChangePercent).toBeGreaterThan(.5);
    expect(missing.bars.at(-1)!.envelope!.dailyTrendChangePercent).toBeNull();
  });
  it.each(['LONG', 'SHORT'] as const)('requires the %s entry trend, not the breach candle trend, and keeps exits active after a trend reversal', side => {
    const direction = side === 'LONG' ? 1 : -1;
    expect(run(document([0, direction * .5, -direction], side), side).entryCount).toBe(1);
    const result = run(document([0, direction * .5, -direction], side), side);
    expect(result.closedTradeCount).toBe(1); expect(result.recentTrades[0]!.reason).toBe('ENVELOPE_CENTER');
    for (const invalid of [null, undefined, direction * .49, -direction]) expect(run(document([direction, invalid, invalid], side), side).entryCount).toBe(0);
  });
  it('allows the ordinary reclaim entry without any daily history when the checkbox is off', () => {
    const doc = document([null, null, null]); const state = initialPortfolio(1000); const p = { ...settings, envelopeDailyTrend: false };
    replayPortfolioBlock(state, [doc], p, start, start + 3 * 3600, 3600);
    expect(portfolioResult(state, p).entryCount).toBe(1);
  });
  it('keeps complete realized profit/loss aggregates beyond the 100-trade display limit and through checkpoints', () => {
    const doc = document(Array.from({ length: 450 }, () => 1)); const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [doc], settings, start, start + 225 * 3600, 3600);
    const restored = structuredClone(state);
    replayPortfolioBlock(restored, [doc], settings, start + 225 * 3600, start + 450 * 3600, 3600);
    const result = portfolioResult(restored, settings);
    expect(result.closedTradeCount).toBe(150); expect(result.recentTrades).toHaveLength(100);
    expect(result.winningProfitUsdt! - result.losingLossUsdt!).toBeCloseTo(result.realizedProfitUsdt, 8);
    expect(profitRatio(result.winningProfitUsdt!, result.losingLossUsdt!)).toBe(100);
    expect(result).toEqual(run(doc, 'LONG'));
  });
});
