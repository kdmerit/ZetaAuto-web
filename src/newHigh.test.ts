import { describe, expect, it } from 'vitest';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import { prepareSymbolBlock, runBacktest } from './engine';
import { currentNewHighSettings, newHighBreakoutCandleMaxMultiplier, newHighBreakoutCandleMinMultiplier, newHighExecutionInterval, newHighPeriod, newHighRiskAmount, newHighSlMultiplier, newHighTpMultiplier, newHighTrailingStopMultiplier, newHighWarmup, prepareNewHigh, type PreparedNewHigh } from './newHigh';
import { engineVersionFor, canResumeLocalJob } from './localJobs';
import type { PreparedBar } from './engine';
import type { BacktestSettings, Candle } from './types';

const settings: BacktestSettings = { mode: 'SINGLE', symbol: 'BTC', interval: '1h', startDate: '2026-01-01', startTime: '09:00', endDate: '', endTime: '00:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', side: 'LONG', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100',
  minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  newHighLookback: '20', newHighSlEnabled: true, newHighSlMultiplier: '2', newHighTpEnabled: true, newHighTpMultiplier: '2', newHighSizingMode: 'BET', newHighRiskAmount: '100' };
const origin = Date.UTC(2026, 0, 1) / 1000;
const definition: PreparedNewHigh = { atr: 2, sum4: 300, sum9: 900, sum19: 1900, sum59: 5900, high: 101, low: 99, long: true, short: false };

function bar(i: number, open: number, high: number, low: number, close: number, overrides: Partial<PreparedNewHigh> = {}): PreparedBar {
  return { candle: { openTime: origin + i * 3600, closeTime: origin + (i + 1) * 3600, open, high, low, close, volume: 100 },
    signal: null, ma20: null, ma60Exit: null, newHigh: { ...definition, ...overrides } };
}

function simulate(bars: PreparedBar[], parameters = settings) {
  const state = initialPortfolio(Number(parameters.initialCapitalUsdt));
  replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars }], parameters, origin, bars.at(-1)!.candle.closeTime, 3600);
  return state;
}

function dailyHistory(): Candle[] {
  return Array.from({ length: 40 }, (_, i) => {
    const close = i === 39 ? 120 : i >= 20 && i < 25 ? 80 : 100;
    return { openTime: origin + i * 86400, closeTime: origin + (i + 1) * 86400,
      open: close, high: i === 39 ? 121 : 101, low: i >= 20 && i < 25 ? 79 : 99, close, volume: 100 };
  });
}

describe('new high/low close-breakout strategy', () => {
  it('validates N, SL, TP and the supported execution settings', () => {
    expect(newHighPeriod(settings)).toBe(20);
    expect(newHighPeriod({ ...settings, newHighLookback: '1' })).toBe(1);
    expect(newHighBreakoutCandleMinMultiplier(settings)).toBe(1);
    expect(newHighBreakoutCandleMaxMultiplier(settings)).toBe(2);
    expect(newHighSlMultiplier(settings)).toBe(2);
    expect(newHighTpMultiplier(settings)).toBe(2);
    expect(newHighTrailingStopMultiplier(settings)).toBe(3);
    expect(newHighRiskAmount(settings)).toBe(100);
    for (const value of ['', '0', '0.05', '10.1', '1.234', 'NaN']) expect(() => newHighSlMultiplier({ ...settings, newHighSlMultiplier: value })).toThrow('SL 배수');
    for (const value of ['', '0', '0.05', '10.1', '1.234', 'NaN']) expect(() => newHighTpMultiplier({ ...settings, newHighTpMultiplier: value })).toThrow('TP 배수');
    for (const value of ['', '0', '0.05', '10.1', '1.234', 'NaN']) expect(() => newHighTrailingStopMultiplier({ ...settings, newHighTrailingStopMultiplier: value })).toThrow('트레일링');
    for (const value of ['', '0', '0.05', '10.1', '1.234', 'NaN']) expect(() => newHighBreakoutCandleMinMultiplier({ ...settings, newHighBreakoutCandleMinAtr: value })).toThrow('최소크기');
    for (const value of ['', '0', '0.05', '10.1', '1.234', 'NaN']) expect(() => newHighBreakoutCandleMaxMultiplier({ ...settings, newHighBreakoutCandleMaxAtr: value })).toThrow('최대크기');
    for (const value of ['', '0', '1001', '-5', '20.5', 'NaN']) expect(() => newHighPeriod({ ...settings, newHighLookback: value })).toThrow('봉수');
    for (const value of ['', '0', '-1', 'NaN']) expect(() => newHighRiskAmount({ ...settings, newHighRiskAmount: value })).toThrow('고정 손실액');
    expect(() => newHighPeriod({ ...settings, interval: '15m' })).toThrow('1h');
    expect(currentNewHighSettings({ ...settings, interval: '15m', partialTpEnabled: true })).toMatchObject({ interval: '1h', partialTpEnabled: false, newHighBreakoutCandleMinEnabled: false, newHighBreakoutCandleMinAtr: '1', newHighBreakoutCandleMaxEnabled: false, newHighBreakoutCandleMaxAtr: '2', newHighSlEnabled: true, newHighTpEnabled: true, newHighTpMultiplier: '2', newHighTrailingStopEnabled: false, newHighTrailingStopMultiplier: '3' });
    expect(currentNewHighSettings({ ...settings, newHighSlEnabled: false, newHighSizingMode: 'RISK' })).toMatchObject({ newHighSlEnabled: false, newHighSizingMode: 'BET' });
    expect(newHighExecutionInterval('1h')).toBe('15m'); expect(newHighExecutionInterval('4h')).toBe('15m'); expect(newHighExecutionInterval('1d')).toBe('15m');
    expect(newHighWarmup(settings)).toBe(20 * 86400 + 3600);
    expect(newHighWarmup({ ...settings, interval: '4h' })).toBe(20 * 86400 + 14400);
    expect(newHighWarmup({ ...settings, interval: '1d' })).toBe(40 * 86400);
    expect(engineVersionFor('NEW_HIGH')).toBe('2.10.93'); expect(engineVersionFor('ENVELOPE')).toBe('2.10.97');
    expect(canResumeLocalJob({ version: '2.10.93', strategy: 'NEW_HIGH', settings })).toBe(true);
    expect(canResumeLocalJob({ version: '2.10.92', strategy: 'NEW_HIGH', settings })).toBe(false);
  });

  it('uses the first completed close beyond the previous N-bar extreme and the requested MA reversal zone', () => {
    const data = dailyHistory();
    const prepared = prepareNewHigh(data, { ...settings, interval: '1d' });
    expect(prepared[39]?.long).toBe(true);
    expect(prepared[39]?.high).toBe(101);
    const secondBreak = [...data, { ...data[39]!, openTime: data[39]!.closeTime, closeTime: data[39]!.closeTime + 86400, open: 121, high: 122, low: 120, close: 121 }];
    expect(prepareNewHigh(secondBreak, { ...settings, interval: '1d' })[40]?.long).toBe(false);
    const wickOnly = [...data.slice(0, 39), { ...data[39]!, high: 121, close: 100 }];
    expect(prepareNewHigh(wickOnly, { ...settings, interval: '1d' })[39]?.long).toBe(false);
    const mirrored = data.map(row => ({ ...row, open: 200 - row.open, high: 200 - row.low, low: 200 - row.high, close: 200 - row.close }));
    expect(prepareNewHigh(mirrored, { ...settings, interval: '1d', side: 'SHORT' })[39]?.short).toBe(true);
  });

  it('filters the breakout candle range by the completed ATR with inclusive bounds', () => {
    const data = dailyHistory();
    const base = prepareNewHigh(data, { ...settings, interval: '1d' })[39]!;
    const atr = base.atr!;
    const withRange = (range: number): Candle[] => [...data.slice(0, 39), {
      ...data[39]!, open: 120, high: 120 + range / 2, low: 120 - range / 2, close: 120,
    }];
    const filtered = { ...settings, interval: '1d' as const, newHighBreakoutCandleMinEnabled: true, newHighBreakoutCandleMinAtr: '1', newHighBreakoutCandleMaxEnabled: true, newHighBreakoutCandleMaxAtr: '2' };
    expect(prepareNewHigh(withRange(atr * 0.99), filtered)[39]?.long).toBe(false);
    expect(prepareNewHigh(withRange(atr), filtered)[39]?.long).toBe(true);
    expect(prepareNewHigh(withRange(atr * 2), filtered)[39]?.long).toBe(true);
    expect(prepareNewHigh(withRange(atr * 2.01), filtered)[39]?.long).toBe(false);
    expect(() => prepareNewHigh(data, { ...filtered, newHighBreakoutCandleMinAtr: '3', newHighBreakoutCandleMaxAtr: '2' })).toThrow('최소크기');
  });

  it('does not let future candles change a completed signal', () => {
    const data = dailyHistory();
    const expected = prepareNewHigh(data, { ...settings, interval: '1d' })[39];
    data.push({ ...data[39]!, openTime: data[39]!.closeTime, closeTime: data[39]!.closeTime + 86400, open: 1000, high: 1100, low: 900, close: 950 });
    expect(prepareNewHigh(data, { ...settings, interval: '1d' })[39]).toEqual(expected);
  });

  it('enters only at the completed parent close and applies the configured SL and TP from the actual fill', () => {
    const state = simulate([bar(0, 100, 105, 95, 102)], { ...settings, newHighSlMultiplier: '1.5', newHighTpMultiplier: '3' });
    const holding = state.positions.BTCUSDT!;
    expect(state.entries).toBe(1); expect(state.closed).toBe(0);
    expect(holding.executions[0]!.timing).toBe('BAR_CLOSE');
    expect(holding.opened).toBe(origin + 3600);
    expect(holding.first).toBeCloseTo(102 * 1.0002);
    expect(holding.stop).toBeCloseTo(holding.first - 3);
    expect(holding.target).toBeCloseTo(holding.first + 6);
    expect(holding.newHighTrailStep).toBeUndefined();
  });

  it.each(['LONG', 'SHORT'] as const)('does not use the entry candle extreme for %s SL or TP', side => {
    const entry = side === 'LONG'
      ? bar(0, 100, 110, 90, 102)
      : bar(0, 100, 110, 90, 98, { long: false, short: true });
    const state = simulate([entry], { ...settings, side });
    expect(state.entries).toBe(1); expect(state.closed).toBe(0); expect(state.positions.BTCUSDT).toBeDefined();
  });

  it('closes a long at the fixed TP when a later 15m candle reaches it', () => {
    const next = bar(1, 102, 109, 101, 108);
    next.newHighIntrabarCandles = [
      { openTime: origin + 3600, closeTime: origin + 4500, open: 102, high: 103, low: 101, close: 102, volume: 10 },
      { openTime: origin + 4500, closeTime: origin + 5400, open: 102, high: 109, low: 105, close: 108, volume: 10 },
    ];
    const state = simulate([bar(0, 100, 105, 95, 102), next]);
    expect(state.closed).toBe(1); expect(state.trades[0]!.reason).toBe('NEW_HIGH_TP');
    expect(state.trades[0]!.exitPrice).toBeCloseTo(state.trades[0]!.entryPrice + 4);
    expect(state.trades[0]!.executions.at(-1)!.candleOpenAt).toBe(origin + 4500);
  });

  it('closes a long at the fixed SL when a later 15m candle reaches it', () => {
    const state = simulate([bar(0, 100, 105, 95, 102), bar(1, 102, 103, 97, 99)]);
    expect(state.closed).toBe(1); expect(state.trades[0]!.reason).toBe('SL');
    expect(state.trades[0]!.exitPrice).toBeLessThan(state.trades[0]!.entryPrice - 3.9);
    expect(state.trades[0]!.newHighTrailStep).toBeUndefined();
  });

  it('uses the mirrored fixed SL and TP for shorts', () => {
    const parameters = { ...settings, side: 'SHORT' as const, newHighSlMultiplier: '1.5', newHighTpMultiplier: '3' };
    const entry = bar(0, 100, 105, 95, 98, { long: false, short: true });
    const first = simulate([entry], parameters).positions.BTCUSDT!;
    expect(first.first).toBeCloseTo(98 * 0.9998);
    expect(first.stop).toBeCloseTo(first.first + 3); expect(first.target).toBeCloseTo(first.first - 6);
    const state = simulate([entry, bar(1, 98, 99, 91, 93, { long: false, short: true })], parameters);
    expect(state.closed).toBe(1); expect(state.trades[0]!.reason).toBe('NEW_HIGH_TP');
  });

  it('does not retain the removed trailing or next-entry-candle exits', () => {
    const state = simulate([bar(0, 100, 105, 95, 102), bar(1, 102, 104, 100, 103)]);
    expect(state.closed).toBe(0); expect(state.positions.BTCUSDT).toBeDefined();
    expect(state.positions.BTCUSDT!.newHighTrailStep).toBeUndefined();
    expect(state.exitReasons.NEW_HIGH_TRAILING).toBeUndefined();
    expect(state.exitReasons.NEW_HIGH_NEXT_CANDLE_BREAK).toBeUndefined();
  });

  it('applies fixed SL and TP only when their checkboxes are enabled', () => {
    const noSl = simulate([bar(0, 100, 105, 95, 102), bar(1, 102, 103, 90, 100)], {
      ...settings, newHighSlEnabled: false, newHighTpMultiplier: '10',
    });
    expect(noSl.closed).toBe(0); expect(noSl.positions.BTCUSDT).toBeDefined();

    const noTp = simulate([bar(0, 100, 105, 95, 102), bar(1, 102, 110, 101, 109)], {
      ...settings, newHighSlMultiplier: '1', newHighTpEnabled: false,
    });
    expect(noTp.closed).toBe(0); expect(noTp.positions.BTCUSDT).toBeDefined();

    const noExits = simulate([bar(0, 100, 105, 95, 102), bar(1, 102, 110, 90, 100)], {
      ...settings, newHighSlEnabled: false, newHighTpEnabled: false,
    });
    expect(noExits.closed).toBe(0); expect(noExits.positions.BTCUSDT).toBeDefined();
  });

  it('optionally follows the most favorable price by the configured ATR distance', () => {
    const parameters = { ...settings, newHighTpMultiplier: '10', newHighTrailingStopEnabled: true, newHighTrailingStopMultiplier: '1' };
    const first = simulate([bar(0, 100, 105, 95, 102)], parameters).positions.BTCUSDT!;
    expect(first.newHighTrailingDistance).toBeCloseTo(2);
    expect(first.stop).toBeCloseTo(first.first - 2);
    const state = simulate([bar(0, 100, 105, 95, 102), bar(1, 102, 104, 102.5, 103.5), bar(2, 103.5, 103.5, 101.5, 102)], parameters);
    expect(state.closed).toBe(1); expect(state.trades[0]!.reason).toBe('NEW_HIGH_TRAILING');
    expect(state.trades[0]!.priceLines?.some(line => line.kind === 'TRAILING_SL')).toBe(true);
  });

  it('keeps fixed-loss sizing based on the new initial SL distance', () => {
    const parameters = { ...settings, newHighSizingMode: 'RISK' as const, newHighRiskAmount: '10', betAmountUsdt: '100' };
    const state = simulate([bar(0, 100, 105, 95, 102), bar(1, 102, 103, 97, 100)], parameters);
    expect(state.closed).toBe(1); expect(Math.abs(state.trades[0]!.netProfitUsdt)).toBeLessThanOrEqual(10.01);
  });

  it('resumes JSON portfolio state exactly across a TP', () => {
    const bars = [bar(0, 100, 105, 95, 102), bar(1, 102, 109, 101, 108)];
    const whole = simulate(bars); let resumed = JSON.parse(JSON.stringify(simulate(bars.slice(0, 1))));
    replayPortfolioBlock(resumed, [{ symbol: 'BTCUSDT', bars: bars.slice(1) }], settings, bars[1]!.candle.openTime, bars[1]!.candle.closeTime, 3600);
    expect(resumed).toEqual(whole);
  });

  it('uses the same close-entry and fixed-exit model through the public run path', () => {
    const data = dailyHistory();
    const runSettings = { ...settings, interval: '1d' as const };
    const prepared = prepareSymbolBlock('BTCUSDT', data, runSettings, 'NEW_HIGH', data[0]!.openTime, data.at(-1)!.closeTime);
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [prepared], runSettings, data[0]!.openTime, data.at(-1)!.closeTime, 86400);
    const result = runBacktest(data, runSettings, 'NEW_HIGH');
    expect(result.entryCount).toBe(state.entries); expect(result.finalEquityUsdt).toBeCloseTo(portfolioResult(state, runSettings).finalEquityUsdt);
  });
});
