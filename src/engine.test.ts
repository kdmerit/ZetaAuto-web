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

function row(index: number, prices: number[], volume = 10): Candle {
  return { openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600,
    open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume };
}

/** Nine warm-up candles, five bodies below MA5, then a two-times body signal. */
function longCandles(): Candle[] {
  return [
    [110, 111, 109, 110], [110, 111, 109, 110], [110, 111, 109, 110], [110, 111, 109, 110],
    [108.5, 109.5, 108, 109], [107.5, 108.5, 107, 108], [106.5, 300, 85, 107], [105.5, 106.5, 105, 106], [104.5, 105.5, 104, 105],
    [108, 130, 90, 120],
    [120, 125, 115, 121],
    [129, 130, 91, 129],
  ].map((prices, index) => row(index, prices));
}

function mirror(rows: Candle[]): Candle[] {
  return rows.map((candle, index) => row(index, [300 - candle.open, 300 - candle.low, 300 - candle.high, 300 - candle.close], candle.volume));
}

function mirroredRow(index: number, prices: number[], volume = 10): Candle {
  return row(index, [300 - prices[0]!, 300 - prices[2]!, 300 - prices[1]!, 300 - prices[3]!], volume);
}

function prepared(rows: Candle[], side: 'LONG' | 'SHORT' = 'LONG') {
  const start = rows[9]!.openTime;
  return prepareSymbolBlock('BTCUSDT', rows, { ...settings, side }, 'VOLATILITY', start, rows.at(-1)!.closeTime);
}

describe('volatility breakout preparation', () => {
  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('creates the %s signal with the fixed conditions', (side, rows) => {
    const document = prepared(rows, side);
    const signal = document.bars[0]!.signal!;
    expect(signal).toMatchObject({
      strategy: 'VOLATILITY', side, exitMode: 'VOLATILITY_CANDLE_RULE', volatilityStopEnabled: true,
    });
    expect(signal.entry).toBeCloseTo(side === 'LONG' ? 128.4 : 171.6, 10);
    expect(signal.volatilityAtr).toBeTypeOf('number');
    expect(signal.stop).toBeCloseTo(side === 'LONG' ? 90 : 210, 10);
    expect(signal.target).toBe(0);
    expect(signal.initialTarget).toBe(0);
    expect(signal.entry).not.toBe(rows[9]!.close);
    expect(signal.volatilityK1).toBeUndefined();
    expect(signal.volatilityK2).toBeUndefined();
  });

  it('does not use volume as a condition', () => {
    const rows = longCandles();
    rows[8]!.volume = 1_000;
    rows[9]!.volume = 1;
    expect(prepared(rows).bars[0]!.signal).not.toBeNull();
  });

  it.each([
    ['a previous body reaches MA5', (rows: Candle[]) => { rows[8]!.close = 110; }],
    ['the current candle midpoint is below MA5', (rows: Candle[]) => { rows[9]!.high = 105; rows[9]!.low = 90; }],
    ['the current body is less than twice the previous body', (rows: Candle[]) => { rows[9]!.open = 104.5; rows[9]!.close = 105; }],
  ])('rejects when %s', (_reason, change) => {
    const rows = longCandles(); change(rows);
    expect(prepared(rows).bars[0]!.signal).toBeNull();
  });

  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('uses the entry and previous candle extremes for the initial SL, %s', (side, rows) => {
    if (side === 'LONG') {
      rows[9]!.low = 95;
      rows[8]!.low = 88;
      const signal = prepared(rows, side).bars[0]!.signal!;
      expect(signal.stop).toBe(88);
    } else {
      rows[9]!.high = 205;
      rows[8]!.high = 212;
      const signal = prepared(rows, side).bars[0]!.signal!;
      expect(signal.stop).toBe(212);
    }
  });

  it('keeps the signal aligned with a completed candle rather than requiring 1-minute data', () => {
    const document = prepared(longCandles());
    expect(document.bars[0]!.intrabarCandles).toBeUndefined();
    expect(document.bars[0]!.ma5Exit).toBeTypeOf('number');
  });
});

describe('volatility candle-rule replay', () => {
  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('closes when the first following candle body is smaller, %s', (side, rows) => {
    const document = prepared(rows, side);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, side }, rows[9]!.openTime, rows.at(-1)!.closeTime, 3600);
    const result = portfolioResult(state, { ...settings, side });
    expect(result.entryCount).toBe(1);
    expect(result.closedTradeCount).toBe(1);
    expect(result.exitReasons).toEqual({ VOLATILITY_CANDLE_EXIT: 1 });
  });

  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('adds an equal-quantity second entry and places TP on the first body, %s', (side, rows) => {
    if (side === 'LONG') rows[10] = row(10, [120, 125, 110, 115]);
    if (side === 'SHORT') {
      rows[10] = mirroredRow(10, [120, 125, 110, 115]);
    }
    rows[11] = side === 'LONG' ? row(11, [115, 121, 110, 118]) : mirroredRow(11, [115, 121, 110, 118]);
    const document = prepared(rows, side);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, side }, rows[9]!.openTime, rows.at(-1)!.closeTime, 3600);
    const result = portfolioResult(state, { ...settings, side });
    const trade = result.recentTrades[0]!;
    expect(result.entryCount).toBe(1);
    expect(result.secondFillCount).toBe(1);
    expect(result.exitReasons).toEqual({ FULL_TP: 1 });
    expect(trade.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'SPLIT_ENTRY', 'CLOSE']);
    expect(trade.executions[1]!.quantity).toBeCloseTo(trade.executions[0]!.quantity, 10);
    expect(trade.signal.target).toBe(side === 'LONG' ? 120 : 180);
  });

  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('raises the SL when the first following candle has a larger same-direction body, %s', (side, rows) => {
    rows[10] = side === 'LONG' ? row(10, [120, 140, 115, 135]) : mirroredRow(10, [120, 140, 115, 135]);
    const document = prepared(rows, side);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, side }, rows[9]!.openTime, rows[10]!.closeTime, 3600);
    expect(state.closed).toBe(0);
    expect(state.positions.BTCUSDT?.stop).toBe(side === 'LONG' ? 115 : 185);
  });

  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('uses the new SL and exits on a later smaller or opposite candle, %s', (side, rows) => {
    rows[10] = side === 'LONG' ? row(10, [120, 140, 115, 135]) : mirroredRow(10, [120, 140, 115, 135]);
    rows[11] = side === 'LONG' ? row(11, [135, 140, 120, 130]) : mirroredRow(11, [135, 140, 120, 130]);
    const document = prepared(rows, side);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, side }, rows[9]!.openTime, rows.at(-1)!.closeTime, 3600);
    expect(portfolioResult(state, { ...settings, side }).exitReasons).toEqual({ VOLATILITY_CANDLE_EXIT: 1 });
  });

  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('applies the entry/previous extreme SL on a later candle, %s', (side, rows) => {
    if (side === 'LONG') {
      rows[10]!.low = 85;
    } else {
      rows[10]!.high = 215;
    }
    const document = prepared(rows, side);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, side }, rows[9]!.openTime, rows.at(-1)!.closeTime, 3600);
    expect(portfolioResult(state, { ...settings, side }).exitReasons).toEqual({ SL: 1 });
  });

  it('does not render a TP line until the second entry creates one', () => {
    const prefix = Array.from({ length: 12 }, (_, index) => row(index, [110, 111, 109, 110]));
    const rows = [...prefix, ...longCandles().map((candle, index) => ({ ...candle, openTime: origin + (index + 12) * 3600, closeTime: origin + (index + 13) * 3600 }))];
    const result = runBacktest(rows, settings, 'VOLATILITY');
    const trade = result.recentTrades[0]!;
    const chart = buildLocalChart(result, trade, settings);
    expect(chart.priceLines).toEqual([
      { kind: 'ENTRY', price: trade.entryPrice },
      { kind: 'SL', price: trade.signal.activeStop ?? trade.signal.stop },
      { kind: 'EXIT', price: trade.exitPrice },
    ]);
  });
});
