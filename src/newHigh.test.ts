import { describe, expect, it } from 'vitest';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import { prepareSymbolBlock, runBacktest } from './engine';
import { currentNewHighSettings, newHighPeriod, newHighWarmup, prepareNewHigh, type PreparedNewHigh } from './newHigh';
import { engineVersionFor, canResumeLocalJob } from './localJobs';
import type { PreparedBar, PreparedSymbol } from './engine';
import type { BacktestSettings, Candle } from './types';

const settings: BacktestSettings = { mode: 'SINGLE', symbol: 'BTC', interval: '1h', startDate: '2026-01-01', startTime: '09:00', endDate: '', endTime: '00:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', side: 'LONG', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100',
  minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false, newHighLookback: '20' };
const origin = Date.UTC(2026, 0, 1) / 1000;
const definition: PreparedNewHigh = { atr: 2, sum9: 900, sum19: 1900, previousMa10: 100, high: 101, low: 99, long: true, short: false };
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
  it('validates configurable N and only accepts 1h/4h without changing other engines', () => {
    expect(newHighPeriod(settings)).toBe(20); expect(newHighPeriod({ ...settings, newHighLookback: '1000' })).toBe(1000);
    for (const value of ['', '1', '5', '1001', '-5', '20.5', 'NaN']) expect(() => newHighPeriod({ ...settings, newHighLookback: value })).toThrow('봉수');
    expect(() => newHighPeriod({ ...settings, interval: '15m' })).toThrow('1h');
    expect(currentNewHighSettings({ ...settings, interval: '15m', partialTpEnabled: true })).toMatchObject({ interval: '1h', partialTpEnabled: false });
    expect(newHighWarmup(settings)).toBe(20 * 86400 + 3600);
    expect(newHighWarmup({ ...settings, interval: '4h' })).toBe(20 * 86400 + 14400);
    expect(engineVersionFor('NEW_HIGH')).toBe('2.10.47'); expect(engineVersionFor('ENVELOPE')).toBe('2.10.45'); expect(engineVersionFor('VOLATILITY')).toBe('2.10.49');
    expect(canResumeLocalJob({ version: '2.10.47', strategy: 'NEW_HIGH', settings })).toBe(true);
  });
  it('changes the breakout window with N while keeping the reversal window fixed and excluding recent five extremes', () => {
    const data = history(); data[585]!.high = 120; data[585]!.low = 50;
    const twenty = prepareNewHigh(data, settings).at(-1)!;
    const ten = prepareNewHigh(data, { ...settings, newHighLookback: '10' }).at(-1)!;
    expect(twenty.high).toBe(120); expect(ten.high).toBe(111);
    expect(ten.long).toBe(true); expect(ten.short).toBe(twenty.short);
    expect(runBacktest(data, settings, 'NEW_HIGH').entryCount).toBe(0);
    expect(runBacktest(data, { ...settings, newHighLookback: '10' }, 'NEW_HIGH').entryCount).toBe(1);
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
  it('requires a strict new high and MA10 > MA20 at the actual touch, not at final close', () => {
    expect(simulate([bar(0, 100, 101, 100, 100.5)]).entries).toBe(0);
    expect(simulate([bar(0, 100.5, 103, 100.2, 102, { sum19: 2000 })]).entries).toBe(0);
    const intrabar = simulate([bar(0, 100.5, 102, 99.5, 99.6)]);
    expect(intrabar.entries).toBe(1); expect(intrabar.closed).toBe(1); expect(intrabar.trades[0]!.executions[0]!.timing).toBe('INTRABAR');
  });
  it('fills opening gaps at observed open and places the initial SL two ATR below the actual fill', () => {
    const state = simulate([bar(0, 102, 102.5, 101.8, 102)]); const holding = state.positions.BTCUSDT!;
    expect(holding.first).toBeCloseTo(102 * 1.0002); expect(holding.stop).toBeCloseTo(holding.first - 4); expect(holding.qty).toBeCloseTo(100 / holding.first);
  });
  it.each(['LONG', 'SHORT'] as const)('limits the first %s buy to one ATR from the breakout line including slippage, without chasing a later return', side => {
    const overrides = side === 'SHORT' ? { long: false, short: true } : {};
    const parameters = { ...settings, side };
    const rawLimit = side === 'LONG' ? 103 / 1.0002 : 97 / .9998;
    const accepted = simulate([bar(0, rawLimit, rawLimit + .01, rawLimit - .01, rawLimit, overrides)], parameters);
    expect(accepted.entries).toBe(1); expect(accepted.positions.BTCUSDT!.first).toBeCloseTo(side === 'LONG' ? 103 : 97);
    const rejected = side === 'LONG' ? bar(0, 104, 105, 100.5, 102, overrides) : bar(0, 96, 99.5, 95, 98, overrides);
    expect(simulate([rejected], parameters).entries).toBe(0);
  });
  it('does not wait for a later MA crossover when the first breakout touch failed its MA condition', () => {
    expect(simulate([bar(0, 100.5, 102.5, 100.2, 102.5, { sum19: 1902 })]).entries).toBe(0);
  });
  it.each(['LONG', 'SHORT'] as const)('adds exactly four %s units, aggregates quantity-weighted fills and moves SL by 2ATR', side => {
    const prices = [[101.1, 101.5, 101.1, 101.5], [101.5, 103.6, 101.5, 103.5], [103.5, 105.7, 103.5, 105.5], [105.5, 107.8, 105.5, 107.5], [107.5, 109.9, 107.5, 109.5], [111, 130, 111, 125]];
    const bars = prices.map(([o, h, l, c], i) => side === 'LONG' ? bar(i, o!, h!, l!, c!) : bar(i, 200 - o!, 200 - l!, 200 - h!, 200 - c!, { long: false, short: true }));
    const state = simulate(bars, { ...settings, side }); const holding = state.positions.BTCUSDT!;
    expect(holding).toBeDefined(); expect(state.entries).toBe(1); expect(state.pyramidFills).toBe(4); expect(holding.margin).toBe(500);
    const fills = holding.executions; expect(fills).toHaveLength(5); expect(fills.filter(fill => fill.kind === 'PYRAMID_ENTRY')).toHaveLength(4);
    expect(holding.qty).toBeCloseTo(fills.reduce((n, fill) => n + fill.quantity, 0)); expect(holding.entry).toBeCloseTo(500 / holding.qty);
    expect(holding.stop).toBeCloseTo(fills.at(-1)!.price + (side === 'LONG' ? -4 : 4));
    expect(state.cash).toBeCloseTo(1000 - 500 - 500 * .00055); expect(state.fees).toBeCloseTo(500 * .00055);
    expect(portfolioResult(state, { ...settings, side }).pyramidFillCount).toBe(4);
  });
  it('does not pyramid unless MA10 is rising and price is above both averages (short is symmetric)', () => {
    const notRising = simulate([bar(0, 101.1, 115, 101, 114, { previousMa10: 120 })]);
    expect(notRising.entries).toBe(1); expect(notRising.pyramidFills).toBe(0);
    const belowMa10 = simulate([bar(0, 102, 109, 101.8, 108, { sum9: 990 })]);
    expect(belowMa10.entries).toBe(1); expect(belowMa10.pyramidFills).toBe(0);
  });
  it('a gap buys one unit at the observed open, not multiple fictional fills at skipped levels', () => {
    const state = simulate([bar(0, 101.1, 101.5, 101.1, 101.5), bar(1, 120, 120.5, 119.8, 120)]);
    expect(state.pyramidFills).toBe(1); expect(state.positions.BTCUSDT!.executions[1]!.price).toBeCloseTo(120 * 1.0002);
  });
  it('requires price below BOTH MAs to exit, with no candle-close wait', () => {
    const first = bar(0, 101.1, 101.5, 101.1, 101.5);
    const oneAverage = bar(1, 101.5, 101.5, 100.5, 101, { sum9: 918, atr: null });
    const state = simulate([first, oneAverage]); expect(state.positions.BTCUSDT).toBeDefined();
    const exit = bar(2, 101, 101, 99, 99.5, { atr: null });
    replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars: [exit] }], settings, exit.candle.openTime, exit.candle.closeTime, 3600);
    expect(state.closed).toBe(1); expect(state.trades[0]!.reason).toBe('NEW_HIGH_MA_EXIT');
    expect(state.trades[0]!.exitPrice).toBeCloseTo(100 * .9998); expect(state.trades[0]!.executions.at(-1)!.timing).toBe('INTRABAR');
    expect(state.trades[0]!.netProfitUsdt).toBeCloseTo(state.realized);
  });
  it('short exits above both MAs and the initial SL is the actual fill plus two ATR', () => {
    const p = { ...settings, side: 'SHORT' as const };
    const state = simulate([bar(0, 98.9, 98.9, 98.5, 98.5, { long: false, short: true })], p);
    expect(state.positions.BTCUSDT!.stop).toBeCloseTo(state.positions.BTCUSDT!.first + 4);
    const exit = bar(1, 99, 101, 99, 100.5, { long: false, short: true, atr: null });
    replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars: [exit] }], p, exit.candle.openTime, exit.candle.closeTime, 3600);
    expect(state.trades[0]!.reason).toBe('NEW_HIGH_MA_EXIT'); expect(state.trades[0]!.exitPrice).toBeCloseTo(100 * 1.0002);
  });
  it('honors the moved stop and conservatively resolves intrabar add/stop ambiguity without reentry', () => {
    const state = simulate([bar(0, 100.5, 110, 100.2, 109)]);
    expect(state.entries).toBe(1); expect(state.pyramidFills).toBe(4); expect(state.closed).toBe(1); expect(state.exitReasons.SL).toBe(1);
    const trade = state.trades[0]!; expect(trade.executions[0]!.kind).toBe('ENTRY'); expect(trade.executions.at(-1)!.kind).toBe('CLOSE');
    expect(trade.priceLines!.some(line => line.kind === 'SL' && line.price === trade.signal.activeStop)).toBe(true);
  });
  it('shares one account and refuses unaffordable additions or fictitious future exit funding', () => {
    const parameters = { ...settings, mode: 'ALL' as const, initialCapitalUsdt: '250' };
    const candle = bar(0, 101.1, 104, 101.1, 103.5);
    const state = simulate([candle], parameters, [{ symbol: 'ZZZUSDT', bars: [candle] }]);
    expect(state.entries).toBe(1); expect(state.pyramidFills).toBe(1); expect(state.cash).toBeGreaterThan(0);
    expect(Object.values(state.positions).reduce((n, p) => n + p.margin, 0)).toBe(200);
    const shortFunds = { ...settings, initialCapitalUsdt: '150' };
    const previous = simulate([bar(0, 101.1, 101.5, 101.1, 101.5)], shortFunds);
    const out = bar(1, 89, 90, 88, 89, { atr: null }); const entry = bar(1, 102, 102.5, 101.8, 102);
    replayPortfolioBlock(previous, [{ symbol: 'BTCUSDT', bars: [out] }, { symbol: 'ZZZUSDT', bars: [entry] }], shortFunds, out.candle.openTime, out.candle.closeTime, 3600);
    expect(previous.cash).toBeGreaterThan(100); expect(previous.entries).toBe(1); expect(previous.positions.ZZZUSDT).toBeUndefined();
  });
  it('prefers an earlier losing MA exit over a profitable raised SL on the other admissible path', () => {
    const state = simulate([bar(0, 101.1, 101.5, 101.1, 101.5), bar(1, 101.5, 110, 99, 109)]);
    expect(state.closed).toBe(1); expect(state.trades[0]!.reason).toBe('NEW_HIGH_MA_EXIT'); expect(state.trades[0]!.netProfitUsdt).toBeLessThan(0);
    expect(state.pyramidFills).toBe(0); expect(state.fees).toBeLessThan(.12);
  });
  it('resumes JSON portfolio state exactly across additions and closes', () => {
    const bars = [bar(0, 101.1, 101.5, 101.1, 101.5), bar(1, 101.5, 103.6, 101.5, 103.5), bar(2, 103.5, 105.7, 103.5, 105.5), bar(3, 102, 103, 99, 100)];
    const whole = simulate(bars); let resumed = simulate(bars.slice(0, 2)); resumed = JSON.parse(JSON.stringify(resumed));
    replayPortfolioBlock(resumed, [{ symbol: 'BTCUSDT', bars: bars.slice(2) }], settings, bars[2]!.candle.openTime, bars.at(-1)!.candle.closeTime, 3600);
    expect(resumed).toEqual(whole);
  });
  it.each([1e-8, 10000])('preserves entries, pyramids and account results when prices are scaled by %s', scale => {
    const bars = [bar(0, 101.1, 101.5, 101.1, 101.5), bar(1, 101.5, 103.6, 101.5, 103.5)];
    const scaled = bars.map(row => ({ ...row, candle: { ...row.candle, open: row.candle.open * scale, high: row.candle.high * scale, low: row.candle.low * scale, close: row.candle.close * scale },
      newHigh: { ...row.newHigh!, atr: row.newHigh!.atr! * scale, sum9: row.newHigh!.sum9 * scale, sum19: row.newHigh!.sum19 * scale,
        previousMa10: row.newHigh!.previousMa10 * scale, high: row.newHigh!.high * scale, low: row.newHigh!.low * scale } }));
    const normal = simulate(bars); const other = simulate(scaled);
    expect(other.entries).toBe(normal.entries); expect(other.pyramidFills).toBe(normal.pyramidFills);
    expect(portfolioResult(other, settings).finalEquityUsdt).toBeCloseTo(portfolioResult(normal, settings).finalEquityUsdt, 8);
  });
  it('the public preparation and normal runBacktest paths use the same portfolio model', () => {
    const data = history(); const start = data[0]!.openTime; const end = data.at(-1)!.closeTime;
    const prepared = prepareSymbolBlock('BTCUSDT', data, settings, 'NEW_HIGH', start, end);
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [prepared], settings, start, end, 3600);
    const result = runBacktest(data, settings, 'NEW_HIGH');
    expect(result.entryCount).toBe(1); expect(result.finalEquityUsdt).toBeCloseTo(portfolioResult(state, settings).finalEquityUsdt);
  });
});
