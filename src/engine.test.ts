import { describe, expect, it } from 'vitest';
import { buildLocalChart, prepareSymbolBlock, runBacktest } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const settings: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'BOTH',
  startDate: '2026-01-01', startTime: '09:00', endDate: '2026-01-02', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
  partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1.0',
  ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5',
  volatilityK1: '0.5', volatilityK2: '1.0', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
};

function row(index: number, prices: number[]): Candle {
  return { openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600,
    open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 10 };
}
function candles(short = false, current = [100, 115, 95, 112], tail: number[][] = []): Candle[] {
  const raw = [...Array.from({ length: 20 }, () => [100, 101, 99, 100]),
    [104, 105, 99, 100], [100, 110, 90, 105], current, ...tail];
  return raw.map((prices, i) => row(i, short ? [200 - prices[0]!, 200 - prices[2]!, 200 - prices[1]!, 200 - prices[3]!] : prices));
}
function minutesFor(parent: Candle, ordered = false, short = false): Candle[] {
  const original = short ? { ...parent, open: 200 - parent.open, high: 200 - parent.low, low: 200 - parent.high, close: 200 - parent.close } : parent;
  return Array.from({ length: 60 }, (_, i) => {
    const prices = ordered ? i === 0 ? [original.open, original.open + 6, original.low, original.open + 6]
      : i === 1 ? [original.open + 6, original.high, Math.min(original.open + 5, original.close), original.close]
        : [original.close, original.close, original.close, original.close]
      : i === 59 ? [original.open, original.high, original.low, original.close] : [original.open, original.open, original.open, original.open];
    const p = short ? [200 - prices[0]!, 200 - prices[2]!, 200 - prices[1]!, 200 - prices[3]!] : prices;
    return { openTime: parent.openTime + i * 60, closeTime: parent.openTime + (i + 1) * 60,
      open: p[0]!, high: p[1]!, low: p[2]!, close: p[3]!, volume: 1 };
  });
}
function prepared(short = false, current?: number[], tail: number[][] = [], changes: Partial<BacktestSettings> = {}, ordered = false) {
  const data = candles(short, current, tail);
  const document = prepareSymbolBlock('BTCUSDT', data, { ...settings, ...changes }, 'VOLATILITY', origin + 22 * 3600, data.at(-1)!.closeTime);
  for (const bar of document.bars) if (bar.signal) bar.intrabarCandles = minutesFor(bar.candle, ordered, short);
  return document;
}
function simulate(short = false, current?: number[], tail: number[][] = [], changes: Partial<BacktestSettings> = {}, ordered = false) {
  const document = prepared(short, current, tail, changes, ordered);
  const state = initialPortfolio(1000);
  replayPortfolioBlock(state, [document], { ...settings, ...changes }, origin + 22 * 3600, document.bars.at(-1)!.candle.closeTime, 3600);
  return { state, result: portfolioResult(state, { ...settings, ...changes }) };
}

describe('intrabar volatility signal preparation', () => {
  it.each([false, true])('uses two confirmed candle directions and the first K1 touch, short=%s', short => {
    const signal = prepared(short).bars[0]!.signal!;
    expect(signal).toMatchObject({ side: short ? 'SHORT' : 'LONG', entry: short ? 90 : 110,
      target: short ? 80 : 120, stop: 100, breakoutRange: 20, volatilityPriorExtreme: short ? 110 : 90,
      volatilityEntryLimit: short ? 80 : 120, exitMode: 'VOLATILITY_TP', volatilityStopEnabled: true,
      volatilityTpEnabled: true, volatilityNextCloseEnabled: false });
  });
  it.each([80, 100, 130])('never filters the touch using the later final close=%s', close => {
    const document = prepared(false, [100, 140, 75, close]);
    expect(document.bars[0]!.signal?.entry).toBe(110);
  });
  it('requires a touch, but accepts an exact wick touch', () => {
    expect(prepared(false, [100, 109.99, 95, 108]).bars[0]!.signal).toBeNull();
    expect(prepared(false, [100, 110, 95, 108]).bars[0]!.signal?.entry).toBe(110);
  });
  it.each([20, 21])('requires the strict completed candle pattern, index=%s', index => {
    const data = candles();
    data[index]!.close = data[index]!.open;
    const document = prepareSymbolBlock('BTCUSDT', data, settings, 'VOLATILITY', origin + 22 * 3600, data.at(-1)!.closeTime);
    expect(document.bars[0]!.signal).toBeNull();
  });
  it('retains minimum volatility and side filters', () => {
    expect(prepared(false, [100, 115, 95, 112], [], { side: 'SHORT' }).bars[0]!.signal).toBeNull();
    const data = candles(false, [105, 120, 101, 112]);
    data[21] = row(21, [100, 110, 100, 105]);
    const document = prepareSymbolBlock('BTCUSDT', data, { ...settings, minVolatilityPercent: '10' }, 'VOLATILITY', origin + 22 * 3600, data.at(-1)!.closeTime);
    expect(document.bars[0]!.signal).toBeNull();
  });
});

describe('intrabar execution and frozen running SL', () => {
  it.each([false, true])('enters before close and never uses a later low/high as its entry-time SL, short=%s', short => {
    const { result } = simulate(short);
    expect(result.entryCount).toBe(1);
    expect(result.exitReasons).toEqual({ SL: 1 });
    const trade = result.recentTrades[0]!;
    // O-H-L-C is the conservative path: the future 95/105 wick was not known
    // at the first touch, so running SL is the current open, 100.
    expect(trade.entryPrice).toBeCloseTo(short ? 90 * 0.9998 : 110 * 1.0002, 10);
    expect(trade.signal.stop).toBe(100);
    expect(trade.exitPrice).toBeCloseTo(short ? 100 * 1.0002 : 100 * 0.9998, 10);
    expect(trade.executions.map(fill => fill.timing)).toEqual(['INTRABAR', 'INTRABAR']);
    expect(trade.entryAt).toBe(origin + 22 * 3600 + 59 * 60);
  });
  it.each([false, true])('can take the new K1 TP inside the entry bar, without waiting for close, short=%s', short => {
    const { result } = simulate(short, [100, 125, 95, 98]);
    expect(result.exitReasons).toEqual({ FULL_TP: 1 });
    const trade = result.recentTrades[0]!;
    expect(trade.exitPrice).toBeCloseTo(trade.entryPrice + (short ? -10 : 10), 10);
    expect(trade.entryAt).toBe(trade.exitAt);
    expect(trade.executions[0]!.candleOpenAt).toBe(trade.executions[1]!.candleOpenAt);
    expect(trade.priceLines).toContainEqual({ kind: 'TP', price: trade.exitPrice });
  });
  it.each([false, true])('does not retroactively stop on a low/high visited before entry, short=%s', short => {
    const { state, result } = simulate(short, [100, 115, 95, 111], [], { volatilityK1: '0.1' });
    // R*K1=2: both paths reach TP before any post-entry adverse wick.
    expect(result.exitReasons).toEqual({ FULL_TP: 1 });
    expect(state.closed).toBe(1);
  });
  it.each([false, true])('uses the worse no-entry scenario if the other path is a profitable but uncertain valid touch, short=%s', short => {
    const { result } = simulate(short, [100, 125, 85, 110]);
    // Low-first invalidates the prior-wick condition before entry. High-first
    // profits, but must not be cherry-picked merely because it traded.
    expect(result.entryCount).toBe(0);
    expect(result.exitReasons).toEqual({});
  });
  it.each([false, true])('honours the strict prior-wick condition at open, short=%s', short => {
    const current = [90, 105, 85, 95];
    expect(prepared(short, current).bars[0]!.signal).toBeNull();
  });
  it('the legacy direct API uses the same authoritative intrabar replay and chart lines', () => {
    const data = candles(false, [100, 125, 95, 98]);
    const minuteData = minutesFor(data[22]!);
    const direct = runBacktest(data, settings, 'VOLATILITY', undefined, minuteData);
    const { result } = simulate(false, [100, 125, 95, 98]);
    expect(direct.exitReasons).toEqual(result.exitReasons);
    expect(direct.finalEquityUsdt).toBeCloseTo(result.finalEquityUsdt, 10);
    const chart = buildLocalChart(direct, direct.recentTrades[0]!, settings);
    expect(chart.priceLines).toContainEqual({ kind: 'TP', price: direct.recentTrades[0]!.exitPrice });
    expect(chart.priceLines.some(line => line.kind === 'SL')).toBe(true);
  });
});

describe('independent TP and next-candle-close options', () => {
  const current = [100, 115, 100, 112];
  const tail = [[112, 125, 110, 114], [114, 130, 113, 127]];
  const orderedSimulation = (short: boolean, current: number[], tail: number[][], changes: Partial<BacktestSettings> = {}) => simulate(short, current, tail, changes, true);
  it.each([false, true])('TP enabled closes on touch even when next-close is disabled, short=%s', short => {
    const { result } = orderedSimulation(short, current, tail);
    expect(result.exitReasons).toEqual({ FULL_TP: 1 });
  });
  it.each([false, true])('TP disabled ignores touch, omits its line, and closes at the exact next bar close when selected, short=%s', short => {
    const { result } = orderedSimulation(short, current, tail, { volatilityTpEnabled: false, volatilityNextCloseEnabled: true });
    expect(result.exitReasons).toEqual({ NEXT_CANDLE_CLOSE: 1 });
    const trade = result.recentTrades[0]!;
    expect(trade.exitAt).toBe(origin + 24 * 3600);
    expect(trade.exitPrice).toBeCloseTo(short ? 86 * 1.0002 : 114 * 0.9998, 10);
    expect(trade.executions.at(-1)!.timing).toBe('BAR_CLOSE');
    expect(trade.priceLines?.some(line => line.kind === 'TP')).toBe(false);
    expect(trade.priceLines?.some(line => line.kind === 'SL')).toBe(true);
  });
  it.each([false, true])('both enabled chooses TP first, short=%s', short => {
    const { result } = orderedSimulation(short, current, tail, { volatilityNextCloseEnabled: true });
    expect(result.exitReasons).toEqual({ FULL_TP: 1 });
  });
  it.each([false, true])('both disabled retains the position beyond TP and multiple closes, short=%s', short => {
    const { result } = orderedSimulation(short, current, tail, { volatilityTpEnabled: false, volatilityNextCloseEnabled: false });
    expect(result.closedTradeCount).toBe(0);
    expect(result.openPositionCount).toBe(1);
  });
  it.each([false, true])('SL remains mandatory with both optional exits disabled and gaps fill at open, short=%s', short => {
    const { result } = orderedSimulation(short, current, [[90, 99, 85, 97]], { volatilityTpEnabled: false, volatilityNextCloseEnabled: false });
    expect(result.exitReasons).toEqual({ SL: 1 });
    expect(result.recentTrades[0]!.exitPrice).toBeCloseTo(short ? 110 * 1.0002 : 90 * 0.9998, 10);
    expect(result.recentTrades[0]!.exitAt).toBe(origin + 23 * 3600);
  });
  it.each([false, true])('next-close never exits the entry candle itself, short=%s', short => {
    const { result } = orderedSimulation(short, current, [], { volatilityTpEnabled: false, volatilityNextCloseEnabled: true });
    expect(result.entryCount).toBe(1);
    expect(result.closedTradeCount).toBe(0);
  });
  it.each([false, true])('SL or TP before next close wins over the scheduled close, short=%s', short => {
    const { result } = orderedSimulation(short, current, [[112, 118, 95, 114]], { volatilityTpEnabled: false, volatilityNextCloseEnabled: true });
    expect(result.exitReasons).toEqual({ SL: 1 });
  });
  it.each([false, true])('does not resurrect the removed K1 close rule when TP is off, short=%s', short => {
    const { result } = orderedSimulation(short, current, [[112, 129, 110, 126]], { volatilityTpEnabled: false });
    expect(result.closedTradeCount).toBe(0);
  });
});
