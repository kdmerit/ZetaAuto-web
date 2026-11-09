import { describe, expect, it } from 'vitest';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import { prepareSymbolBlock, runBacktest } from './engine';
import { currentNewHighSettings, newHighExecutionInterval, newHighPeriod, newHighRiskAmount, newHighSlMultiplier, newHighWarmup, prepareNewHigh, type PreparedNewHigh } from './newHigh';
import { engineVersionFor, canResumeLocalJob } from './localJobs';
import type { PreparedBar, PreparedSymbol } from './engine';
import type { BacktestSettings, Candle } from './types';

const settings: BacktestSettings = { mode: 'SINGLE', symbol: 'BTC', interval: '1h', startDate: '2026-01-01', startTime: '09:00', endDate: '', endTime: '00:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', side: 'LONG', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100',
  minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false, newHighLookback: '20', newHighSizingMode: 'BET', newHighRiskAmount: '100' };
const origin = Date.UTC(2026, 0, 1) / 1000;
const definition: PreparedNewHigh = { atr: 2, sum4: 300, sum9: 900, sum19: 1900, sum59: 5900, high: 101, low: 99, long: true, short: false };
function bar(i: number, open: number, high: number, low: number, close: number, overrides: Partial<PreparedNewHigh> = {}): PreparedBar {
  return { candle: { openTime: origin + i * 3600, closeTime: origin + (i + 1) * 3600, open, high, low, close, volume: 100 },
    signal: null, ma20: null, ma60Exit: null, newHigh: { ...definition, ...overrides } };
}
function simulate(bars: PreparedBar[], parameters = settings, extra: PreparedSymbol[] = []) {
  const state = initialPortfolio(Number(parameters.initialCapitalUsdt));
  replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars }, ...extra], parameters, origin, bars.at(-1)!.candle.closeTime, 3600);
  return state;
}
function history(): Candle[] {
  return Array.from({ length: 601 }, (_, i) => {
    const close = i < 580 ? 100 : i < 590 ? 90 + (i - 580) * .5 : i < 600 ? 102 + (i - 590) * .7 : 113;
    const open = i === 600 ? 110 : close;
    return { openTime: origin + (i - 600) * 3600, closeTime: origin + (i - 599) * 3600, open, close,
      high: i === 600 ? 113.5 : i === 590 ? 111 : close + .5, low: i === 600 ? 109.5 : close - .5, volume: 100 };
  });
}
describe('new high/low causal strategy', () => {
  it('validates configurable N and accepts only supported new-high intervals without changing other engines', () => {
    expect(newHighPeriod(settings)).toBe(20); expect(newHighPeriod({ ...settings, newHighLookback: '1000' })).toBe(1000);
    expect(newHighSlMultiplier(settings)).toBe(2); expect(newHighSlMultiplier({ ...settings, newHighSlMultiplier: '1.5' })).toBe(1.5);
    expect(newHighRiskAmount(settings)).toBe(100); expect(newHighRiskAmount({ ...settings, newHighRiskAmount: '25' })).toBe(25);
    for (const value of ['', '0', '0.05', '10.1', '1.234', 'NaN']) expect(() => newHighSlMultiplier({ ...settings, newHighSlMultiplier: value })).toThrow('SL 배수');
    for (const value of ['', '0', '-1', 'NaN']) expect(() => newHighRiskAmount({ ...settings, newHighRiskAmount: value })).toThrow('고정 손실액');
    for (const value of ['', '1', '5', '1001', '-5', '20.5', 'NaN']) expect(() => newHighPeriod({ ...settings, newHighLookback: value })).toThrow('봉수');
    expect(() => newHighPeriod({ ...settings, interval: '15m' })).toThrow('1h');
    expect(currentNewHighSettings({ ...settings, interval: '15m', partialTpEnabled: true })).toMatchObject({ interval: '1h', partialTpEnabled: false });
    expect(newHighPeriod({ ...settings, interval: '1d' })).toBe(20);
    expect(currentNewHighSettings({ ...settings, interval: '1d' }).interval).toBe('1d');
    expect(newHighExecutionInterval('1h')).toBe('15m'); expect(newHighExecutionInterval('4h')).toBe('15m'); expect(newHighExecutionInterval('1d')).toBe('15m');
    expect(newHighWarmup(settings)).toBe(20 * 86400 + 3600);
    expect(newHighWarmup({ ...settings, interval: '4h' })).toBe(20 * 86400 + 14400);
    expect(newHighWarmup({ ...settings, interval: '1d' })).toBe(60 * 86400);
    expect(engineVersionFor('NEW_HIGH')).toBe('2.10.68'); expect(engineVersionFor('ENVELOPE')).toBe('2.10.86'); expect(engineVersionFor('VOLATILITY')).toBe('2.10.83');
    expect(canResumeLocalJob({ version: '2.10.68', strategy: 'NEW_HIGH', settings })).toBe(true);
  });
  it('changes the breakout window with N while keeping the reversal window fixed and excluding recent five extremes', () => {
    const data = history(); data[585]!.high = 120; data[585]!.low = 50;
    const twenty = prepareNewHigh(data, settings).at(-1)!;
    const ten = prepareNewHigh(data, { ...settings, newHighLookback: '10' }).at(-1)!;
    expect(twenty.high).toBe(120); expect(ten.high).toBe(111);
    expect(ten.long).toBe(true); expect(ten.short).toBe(twenty.short);
  });
  it('does not use final/current/future prices in prepared breakout, SL, ATR or previous MA checks', () => {
    const data = history(); const expected = prepareNewHigh(data, settings).at(-1);
    data[600] = { ...data[600]!, high: 1000, low: 1, close: 5 };
    data.push({ ...data[600]!, openTime: data[600]!.closeTime, closeTime: data[600]!.closeTime + 3600 });
    expect(prepareNewHigh(data, settings)[600]).toEqual(expected);
    expect(prepareNewHigh(data.slice(480), settings).at(-2)!.atr).toBeNull();
  });
  it('requires a previous reverse MA zone and sufficient twenty-day ATR history', () => {
    for (const overrides of [{ long: false }, { atr: null }, { atr: 0 }]) {
      expect(simulate([bar(0, 100.5, 106, 100.4, 105, overrides)]).entries).toBe(0);
    }
    const rising = history().map((candle, i) => ({ ...candle, open: 100 + i / 10, close: 100 + i / 10, high: 100.2 + i / 10, low: 99.8 + i / 10 }));
    expect(prepareNewHigh(rising, settings).at(-1)!.long).toBe(false);
  });
  it('rejects an extreme anywhere in the most recent five completed candles, including ties, but permits six candles ago', () => {
    const data = history(); expect(prepareNewHigh(data, settings).at(-1)!.long).toBe(true);
    data[595]!.high = 120; expect(prepareNewHigh(data, settings).at(-1)!.long).toBe(false);
    data[595]!.high = 108; data[594]!.high = 120; expect(prepareNewHigh(data, settings).at(-1)!.long).toBe(true);
    data[599]!.high = 120; expect(prepareNewHigh(data, settings).at(-1)!.long).toBe(false);
    const mirrored = history().map(row => ({ ...row, open: 200 - row.open, close: 200 - row.close, high: 200 - row.low, low: 200 - row.high }));
    const short = { ...settings, side: 'SHORT' as const }; expect(prepareNewHigh(mirrored, short).at(-1)!.short).toBe(true);
    mirrored[599]!.low = mirrored[590]!.low; expect(prepareNewHigh(mirrored, short).at(-1)!.short).toBe(false);
  });
  it('requires a strict new high and MA10 > MA20, then enters when the intrabar threshold is reached', () => {
    expect(simulate([bar(0, 100, 101, 100, 100.5)]).entries).toBe(0);
    expect(simulate([bar(0, 100.5, 103, 100.2, 102, { sum19: 2000 })]).entries).toBe(0);
    const confirmed = simulate([bar(0, 101.5, 102.3, 101.4, 102)]);
    expect(confirmed.entries).toBe(1); expect(confirmed.closed).toBe(0); expect(confirmed.positions.BTCUSDT!.executions[0]!.timing).toBe('INTRABAR');
    expect(confirmed.positions.BTCUSDT!.opened).toBe(origin);
    expect(confirmed.positions.BTCUSDT!.target).toBeCloseTo(confirmed.positions.BTCUSDT!.first + 4);
  });
  it('fills at the intrabar threshold and places the initial SL at the configured ATR multiple', () => {
    const state = simulate([bar(0, 101.5, 102.3, 101.4, 102)]); const holding = state.positions.BTCUSDT!;
    expect(holding.first).toBeCloseTo(102 * 1.0002); expect(holding.stop).toBeCloseTo(holding.first - 4); expect(holding.qty).toBeCloseTo(100 / holding.first);
    const custom = simulate([bar(0, 101.5, 102.3, 101.4, 102)], { ...settings, newHighSlMultiplier: '1.5' });
    expect(custom.positions.BTCUSDT!.stop).toBeCloseTo(custom.positions.BTCUSDT!.first - 3);
  });
  it.each(['LONG', 'SHORT'] as const)('limits the first %s buy to the fixed 0.5~1 ATR range', side => {
    const overrides = side === 'SHORT' ? { long: false, short: true } : {};
    const parameters = { ...settings, side };
    const rawLimit = side === 'LONG' ? 102.5 / 1.0002 : 97.5 / .9998;
    const accepted = side === 'LONG'
      ? simulate([bar(0, rawLimit - .1, rawLimit + .01, rawLimit - .1, rawLimit, overrides)], parameters)
      : simulate([bar(0, rawLimit + .1, rawLimit + .1, rawLimit - .01, rawLimit, overrides)], parameters);
    expect(accepted.entries).toBe(1); expect(accepted.positions.BTCUSDT!.first).toBeCloseTo(side === 'LONG' ? (rawLimit - .1) * 1.0002 : (rawLimit + .1) * .9998);
    const rejected = side === 'LONG' ? bar(0, 104, 105, 100.5, 102, overrides) : bar(0, 96, 99.5, 95, 98, overrides);
    expect(simulate([rejected], parameters).entries).toBe(0);
  });
  it('does not wait for a later MA crossover when the first breakout touch failed its MA condition', () => {
    expect(simulate([bar(0, 101.5, 102.5, 101.4, 102, { sum19: 2000 })]).entries).toBe(0);
  });
  it('optionally requires the actual entry price to be above or below MA60 by direction', () => {
    expect(simulate([bar(0, 101.5, 102.3, 101.4, 102)], { ...settings, newHighMa60Enabled: true }).entries).toBe(1);
    expect(simulate([bar(0, 101.5, 102.3, 101.4, 102, { sum59: 6600 })], { ...settings, newHighMa60Enabled: true }).entries).toBe(0);
    const short = { ...settings, side: 'SHORT' as const, newHighMa60Enabled: true };
    expect(simulate([bar(0, 98.5, 98.6, 97.7, 97.8, { long: false, short: true, sum59: 5900 })], short).entries).toBe(1);
    expect(simulate([bar(0, 98.5, 98.6, 97.7, 97.8, { long: false, short: true, sum59: 5400 })], short).entries).toBe(0);
  });
  it('optionally requires the entry price to be below or above MA10 by direction', () => {
    expect(simulate([bar(0, 101.5, 102.3, 101.4, 102, { sum9: 1050 })], { ...settings, newHighMa10Enabled: true }).entries).toBe(1);
    expect(simulate([bar(0, 101.5, 102.3, 101.4, 102)], { ...settings, newHighMa10Enabled: true }).entries).toBe(0);
    const short = { ...settings, side: 'SHORT' as const, newHighMa10Enabled: true };
    expect(simulate([bar(0, 98.5, 98.6, 97.7, 97.8, { long: false, short: true, sum9: 850 })], short).entries).toBe(1);
    expect(simulate([bar(0, 98.5, 98.6, 97.7, 97.8, { long: false, short: true })], short).entries).toBe(0);
  });
  it.each(['LONG', 'SHORT'] as const)('opens only one %s unit and never creates additional fills', side => {
    const prices = [[101.5, 102.3, 101.4, 102], [102, 108.1, 106.5, 107.5], [107.5, 107.5, 104, 104.5]];
    const bars = prices.map(([o, h, l, c], i) => side === 'LONG' ? bar(i, o!, h!, l!, c!) : bar(i, 200 - o!, 200 - l!, 200 - h!, 200 - c!, { long: false, short: true }));
    const state = simulate(bars, { ...settings, side }); const trade = state.trades[0]!;
    expect(state.entries).toBe(1); expect(state.closed).toBe(1);
    expect(trade.executions).toHaveLength(2); expect(trade.executions[0]!.kind).toBe('ENTRY');
    expect(trade.reason).toBe('NEW_HIGH_TRAILING');
    expect(trade.newHighTrailStep).toBeGreaterThanOrEqual(2);
    expect(trade.newHighTrailLevels).toEqual(expect.arrayContaining([expect.objectContaining({ step: 1, price: expect.any(Number) }), expect.objectContaining({ step: 2, price: expect.any(Number) })]));
    expect(trade.priceLines?.some(line => line.kind === 'TRAILING_SL')).toBe(true);
    expect(trade.priceLines?.some(line => line.kind === 'TRAILING_REACHED' && line.stage === 2)).toBe(true);
    expect(state.cash).toBeGreaterThan(999); expect(state.fees).toBeGreaterThan(0);
    expect(portfolioResult(state, { ...settings, side })).not.toHaveProperty('pyramidFillCount');
  });
  it('opens a gap at the observed open when it is still inside the allowed range', () => {
    const state = simulate([bar(0, 101.5, 102.3, 101.4, 102)]);
    expect(state.entries).toBe(1); expect(state.positions.BTCUSDT!.executions).toHaveLength(1);
    expect(state.positions.BTCUSDT!.first).toBeCloseTo(102 * 1.0002);
    expect(state.positions.BTCUSDT!.executions[0]!.timing).toBe('INTRABAR');
  });
  it('does not use MA5/MA20 as a separate exit condition', () => {
    const first = bar(0, 101.5, 102.3, 101.4, 102);
    const oneAverage = bar(1, 101.5, 101.5, 101.4, 101.5, { sum9: 918, atr: null });
    const state = simulate([first, oneAverage]); expect(state.positions.BTCUSDT).toBeDefined();
    expect(state.closed).toBe(0);
    expect(state.trades).toHaveLength(0);
  });
  it('keeps a position open after +2ATR when no trailing stop is hit', () => {
    const state = simulate([bar(0, 101.5, 102.3, 101.4, 102, { sum4: 400 })]);
    const threshold = bar(1, 104, 106, 105, 105.5, { sum4: 400, atr: 2 });
    replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars: [threshold] }], settings, threshold.candle.openTime, threshold.candle.closeTime, 3600);
    expect(state.closed).toBe(0); expect(state.positions.BTCUSDT).toBeDefined();
  });
  it('moves the stop through every favorable ATR step and exits through the stepped trailing stop', () => {
    const first = bar(0, 101.5, 102.3, 101.4, 102, { sum4: 400 });
    const breakthrough = bar(1, 106, 108.1, 107.5, 107.5, { sum4: 400, atr: 2 });
    const state = simulate([first, breakthrough]);
    const holding = state.positions.BTCUSDT!;
    expect(state.closed).toBe(0); expect(holding.newHighTrailStep).toBe(3);
    expect(holding.stop).toBeCloseTo(holding.first + 5); expect(holding.newHighTrailLevels).toHaveLength(3);
    const retrace = bar(2, 107.5, 107.5, 104, 104.5, { sum4: 400, atr: 2 });
    replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars: [retrace] }], settings, retrace.candle.openTime, retrace.candle.closeTime, 3600);
    expect(state.closed).toBe(1); expect(state.trades[0]!.reason).toBe('NEW_HIGH_TRAILING');
  });
  it('uses lower-timeframe candles to place a later intrabar trailing exit', () => {
    const entry = bar(0, 101.5, 102.3, 101.4, 102);
    const parent = bar(1, 102, 108.5, 105, 105, { sum4: 400 });
    parent.newHighIntrabarCandles = [
      { openTime: origin + 3600, closeTime: origin + 4500, open: 102, high: 107, low: 106.5, close: 107, volume: 100 },
      { openTime: origin + 4500, closeTime: origin + 5400, open: 107, high: 108.5, low: 106.5, close: 108, volume: 100 },
      { openTime: origin + 5400, closeTime: origin + 6300, open: 108, high: 108.2, low: 105, close: 105, volume: 100 },
    ];
    const state = simulate([entry, parent]);
    expect(state.closed).toBe(1);
    expect(state.trades[0]!.executions.at(-1)!.candleOpenAt).toBe(origin + 5400);
  });
  it('does not close on the same 15m candle that first reaches a trailing stage', () => {
    const entry = bar(0, 101.5, 102.3, 101.4, 102);
    const parent = bar(1, 102.5, 104.2, 102.2, 103.8, { sum4: 400 });
    parent.newHighIntrabarCandles = [{
      openTime: origin + 3600, closeTime: origin + 4500,
      open: 102.5, high: 104.2, low: 102.2, close: 103.8, volume: 100,
    }];
    const state = simulate([entry, parent]);
    expect(state.closed).toBe(0);
    expect(state.positions.BTCUSDT).toBeDefined();
    expect(state.positions.BTCUSDT!.newHighTrailStep).toBe(1);

    const next = bar(2, 103.8, 104, 102.8, 103, { sum4: 400 });
    next.newHighIntrabarCandles = [{
      openTime: origin + 7200, closeTime: origin + 8100,
      open: 103.8, high: 104, low: 102.8, close: 103, volume: 100,
    }];
    replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars: [next] }], settings, next.candle.openTime, next.candle.closeTime, 3600);
    expect(state.closed).toBe(1);
    expect(state.trades[0]!.reason).toBe('NEW_HIGH_TRAILING');
  });
  it('closes on the first 15m break of the entry parent low in the next parent candle', () => {
    const entry = bar(0, 101.5, 102.3, 101.4, 102);
    const next = bar(1, 102, 102.5, 101.3, 102, { sum4: 400 });
    next.newHighIntrabarCandles = [{
      openTime: origin + 3600, closeTime: origin + 4500,
      open: 102, high: 102.5, low: 101.3, close: 102, volume: 100,
    }];
    const state = simulate([entry, next]);
    expect(state.closed).toBe(1);
    expect(state.trades[0]!.reason).toBe('NEW_HIGH_NEXT_CANDLE_BREAK');
    expect(state.trades[0]!.exitPrice).toBeLessThan(101.4);
  });
  it('uses a lower-timeframe candle for the breakout entry fill', () => {
    const parent = bar(0, 101, 102.5, 100.5, 102);
    parent.newHighIntrabarCandles = [{ openTime: origin + 900, closeTime: origin + 1800, open: 101, high: 102.2, low: 100.5, close: 102.1, volume: 100 }];
    const state = simulate([parent]);
    expect(state.entries).toBe(1);
    expect(state.positions.BTCUSDT!.executions[0]!.candleOpenAt).toBe(origin + 900);
  });
  it('uses the short direction for the initial SL and stepped trailing levels', () => {
    const p = { ...settings, side: 'SHORT' as const };
    const state = simulate([bar(0, 98.5, 98.6, 97.7, 97.8, { long: false, short: true, sum4: 2200 })], p);
    expect(state.positions.BTCUSDT!.stop).toBeCloseTo(state.positions.BTCUSDT!.first + 4);
    expect(state.positions.BTCUSDT!.target).toBeCloseTo(state.positions.BTCUSDT!.first - 4);
    const exit = bar(1, 95, 95.5, 94.5, 95, { long: false, short: true, sum4: 2200, atr: null });
    replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars: [exit] }], p, exit.candle.openTime, exit.candle.closeTime, 3600);
    expect(state.closed).toBe(0); expect(state.positions.BTCUSDT!.stop).toBeLessThan(state.positions.BTCUSDT!.first);
  });
  it('keeps the initial stop until the first favorable ATR step', () => {
    const state = simulate([bar(0, 101.5, 102.3, 101.4, 102)]);
    expect(state.entries).toBe(1); expect(state.closed).toBe(0);
    const holding = state.positions.BTCUSDT!; expect(holding.executions).toHaveLength(1); expect(holding.stop).toBeCloseTo(holding.first - 4);
  });
  it('uses the fixed loss amount to size the position from the initial SL distance', () => {
    const parameters = { ...settings, newHighSizingMode: 'RISK' as const, newHighRiskAmount: '10', betAmountUsdt: '100' };
    const first = bar(0, 101.5, 102.3, 101.4, 102);
    const state = simulate([first], parameters);
    const holding = state.positions.BTCUSDT!;
    expect(holding.margin).toBeGreaterThan(100); expect(holding.margin).toBeLessThan(300);
    const stop = bar(1, 101.5, 101.5, 96, 100, { atr: null });
    replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars: [stop] }], parameters, stop.candle.openTime, stop.candle.closeTime, 3600);
    expect(state.closed).toBe(1); expect(Math.abs(state.trades[0]!.netProfitUsdt)).toBeLessThanOrEqual(10.01);
  });
  it('keeps an intrabar entry open when the breakout candle later falls back or forms a rejection wick', () => {
    const failed = simulate([bar(0, 100.5, 102, 99.5, 100.8)]);
    expect(failed.entries).toBe(1); expect(failed.closed).toBe(0); expect(failed.positions.BTCUSDT).toBeDefined();
    const wick = simulate([bar(0, 105, 111, 104, 106, { atr: 10 })]);
    expect(wick.entries).toBe(1); expect(wick.closed).toBe(0); expect(wick.positions.BTCUSDT).toBeDefined();
  });
  it.each(['LONG', 'SHORT'] as const)('does not trigger an SL on the %s entry candle', side => {
    const entryBar = side === 'LONG'
      ? bar(0, 101, 105, 97, 102)
      : bar(0, 99, 103, 97, 98, { long: false, short: true });
    const state = simulate([entryBar], { ...settings, side });
    expect(state.entries).toBe(1); expect(state.closed).toBe(0); expect(state.positions.BTCUSDT).toBeDefined();
  });
  it('shares one account and refuses unaffordable new entries', () => {
    const parameters = { ...settings, mode: 'ALL' as const, initialCapitalUsdt: '250' };
    const candle = bar(0, 101.5, 102.3, 101.4, 102);
    const state = simulate([candle], parameters, [{ symbol: 'ZZZUSDT', bars: [candle] }]);
    expect(state.entries).toBe(2); expect(state.cash).toBeGreaterThan(0);
    expect(Object.values(state.positions).reduce((n, p) => n + p.margin, 0)).toBe(200);
    const shortFunds = { ...settings, initialCapitalUsdt: '150' };
    const previous = simulate([bar(0, 101.5, 102.3, 101.4, 102)], shortFunds);
    const out = bar(1, 89, 90, 88, 89, { atr: null }); const entry = bar(1, 102, 102.5, 101.8, 102);
    replayPortfolioBlock(previous, [{ symbol: 'BTCUSDT', bars: [out] }, { symbol: 'ZZZUSDT', bars: [entry] }], shortFunds, out.candle.openTime, out.candle.closeTime, 3600);
    expect(previous.cash).toBeGreaterThan(100); expect(previous.entries).toBe(1); expect(previous.positions.ZZZUSDT).toBeUndefined();
  });
  it('records the actual betting amount and highest trailing stage on a closed trade', () => {
    const state = simulate([bar(0, 101.5, 102.3, 101.4, 102), bar(1, 106, 108.1, 106.5, 107.5), bar(2, 107.5, 107.5, 104, 104.5)]);
    expect(state.closed).toBe(1); expect(state.trades[0]!.reason).toBe('NEW_HIGH_TRAILING');
    expect(state.trades[0]!.betAmountUsdt).toBe(100); expect(state.trades[0]!.newHighTrailStep).toBe(3);
    expect(state.trades[0]!.newHighTrailLevels).toHaveLength(3); expect(state.fees).toBeLessThan(.12);
  });
  it('resumes JSON portfolio state exactly across entries and closes', () => {
    const bars = [bar(0, 101.5, 102.3, 101.4, 102), bar(1, 102, 103.6, 102, 103.5), bar(2, 103.5, 105.7, 103.5, 105.5), bar(3, 102, 103, 99, 100)];
    const whole = simulate(bars); let resumed = simulate(bars.slice(0, 2)); resumed = JSON.parse(JSON.stringify(resumed));
    replayPortfolioBlock(resumed, [{ symbol: 'BTCUSDT', bars: bars.slice(2) }], settings, bars[2]!.candle.openTime, bars.at(-1)!.candle.closeTime, 3600);
    expect(resumed).toEqual(whole);
  });
  it.each([1e-8, 10000])('preserves entries and account results when prices are scaled by %s', scale => {
    const bars = [bar(0, 101.1, 101.5, 101.1, 101.5), bar(1, 101.5, 103.6, 101.5, 103.5)];
    const scaled = bars.map(row => ({ ...row, candle: { ...row.candle, open: row.candle.open * scale, high: row.candle.high * scale, low: row.candle.low * scale, close: row.candle.close * scale },
      newHigh: { ...row.newHigh!, atr: row.newHigh!.atr! * scale, sum4: row.newHigh!.sum4 * scale, sum9: row.newHigh!.sum9 * scale, sum19: row.newHigh!.sum19 * scale,
        sum59: row.newHigh!.sum59 === undefined ? undefined : row.newHigh!.sum59 * scale,
        high: row.newHigh!.high * scale, low: row.newHigh!.low * scale } }));
    const normal = simulate(bars); const other = simulate(scaled);
    expect(other.entries).toBe(normal.entries);
    expect(portfolioResult(other, settings).finalEquityUsdt).toBeCloseTo(portfolioResult(normal, settings).finalEquityUsdt, 8);
  });
  it('the public preparation and normal runBacktest paths use the same portfolio model', () => {
    const data = history(); const start = data[0]!.openTime; const end = data.at(-1)!.closeTime;
    const prepared = prepareSymbolBlock('BTCUSDT', data, settings, 'NEW_HIGH', start, end);
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [prepared], settings, start, end, 3600);
    const result = runBacktest(data, settings, 'NEW_HIGH');
    expect(result.entryCount).toBe(state.entries); expect(result.finalEquityUsdt).toBeCloseTo(portfolioResult(state, settings).finalEquityUsdt);
  });
});
